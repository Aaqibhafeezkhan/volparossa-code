# SPDX-License-Identifier: GPL-3.0-only
"""Offline wiring/admission contracts, not a hosted runner or model proof."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


CI = load('opencode_ci')
TRIAL = load('smoke_opencode_inference')


def specialize_memory_diagnostics(source):
    """Normalize only the two exact reviewed native opt-ins, never the golden."""
    keyword = ", **({'memory_enabled': True} if backend != 'torch' else {})"
    expected = ast.parse("private.service_diagnostic(BASE / (CORE_UNIT + '.log')" + keyword + ')',
                         mode='eval').body
    calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute) and node.func.attr == 'service_diagnostic']
    if source.count(keyword) != 2 or len(calls) != 2 or any(
            ast.dump(call) != ast.dump(expected) for call in calls):
        raise ValueError('memory_diagnostic_specialization')
    return source.replace(keyword, '')


def bounded_memory_receipt():
    """Maximum-count synthetic closed records, not observed model/runtime facts."""
    maximum = 2**53 - 1
    stat = dict(state='observed', **{key: maximum for key in (
        'anon_bytes', 'file_bytes', 'shmem_bytes', 'inactive_file_bytes', 'active_file_bytes', 'kernel_bytes')})
    sample = dict(headroom_bytes=1, host_available_bytes=maximum,
        self_headroom_bytes=1, ancestor_headroom_bytes=2, self_max_bytes=maximum,
        self_current_bytes=maximum-1, ancestor_max_bytes=maximum, ancestor_current_bytes=maximum-2,
        limiting_scope='self', missing_stage='none', io_kind='none', numeric_overflow=False,
        self_stat=stat, ancestor_stat=stat)
    memory = dict(version=1, phase='cache_hint', binding='bound', outcome='advised',
        supervisor_ok=True, before=sample, after=sample, syscall_error=None)
    state = dict(version=1, last_phase='checkpoint',
        substage=dict(stage='verify_after', state='complete', elapsed_ms=599999),
        capacity=dict(decision='cancel', constraint='quiet_hold', cpu_some_avg10=99.99999999999999,
            io_some_avg10=99.99999999999999, memory_bytes=2**64-1),
        controls=dict(issued=128, acknowledged=128, last_issued='resume', last_acknowledged='resume'),
        peak_rss_bytes=10 * 1024**3,
        generation=dict(prompt_tokens=12288, threads=2, interop_threads=2,
            cpu=dict(isa='NO AVX', avx2=False, avx512_bf16=False, amx_bf16=False,
                amx_tile=False, mkldnn_available=False, mkldnn_enabled=False),
            first_forward_started_ms=599997, first_forward_completed_ms=599998,
            first_token_ms=599999, generated_tokens=1024, complete=True, elapsed_ms=599999))
    event = dict(version=1, phase='task', detail=dict(code='compute_private_process_cleanup_deadline',
        io_kind='permission_denied', exit_code=255, signal=64, stderr_class='user_namespace'))
    return dict(version=1, kind='opencode-real-inference-guest', passed=False,
        core_revision=TRIAL.NATIVE_CORE, model_profile=TRIAL.LARGE_MODEL, inference_backend='llama_cpp_bf16_v1',
        native_source_commit=TRIAL.NATIVE_SOURCE, actual_model_provisioned=False,
        core_diagnostics=dict(version=2, events=[event] * 16, states=[state] * 16,
            memory=[memory] * 16, truncated=False, unrecognized_record=False))


class Contracts(unittest.TestCase):
    def test_host_profile_is_explicit_and_refused_on_local_host(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'hosted_ci_only'):
                CI.verify_host_tools(Path('/usr'))
            process.assert_not_called()
        with patch.object(CI, 'guard'), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'ci_system_tools_only'):
                CI.verify_host_tools(Path('/untrusted/tools'))
            process.assert_not_called()

    def test_hosted_memory_gate_precedes_any_service_or_vm(self):
        with patch.object(CI, 'verify_host_tools', return_value={}), \
                patch.object(CI, 'module', return_value=SimpleNamespace(GIB=TRIAL.GIB,
                    trial_profile=TRIAL.trial_profile, available_memory=lambda: 8 * TRIAL.GIB - 1)), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'host_available_memory_below_8GiB'):
                CI.preflight()
            process.assert_not_called()

    def test_actual_service_probe_demands_kvm_and_effective_cgroup_limits(self):
        calls = []

        def process(args, **kwargs):
            calls.append(args)
            output = 'MainPID=0\nActiveState=inactive\n' if 'show' in args else ''
            return subprocess.CompletedProcess(args, 0, output, '')

        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), \
                patch.object(CI, 'verify_host_tools', return_value={'profile': CI.PROFILE}), \
                patch.object(CI, 'module', return_value=SimpleNamespace(GIB=TRIAL.GIB,
                    trial_profile=TRIAL.trial_profile, available_memory=lambda: 8 * TRIAL.GIB)), patch.object(CI.subprocess, 'run', side_effect=process):
            CI.preflight()
            command = next(args for args in calls if args[0] == 'systemd-run')
            self.assertIn('--user', command)
            self.assertIn('--property=MemoryMax=' + str(7 * TRIAL.GIB), command)
            self.assertIn('--property=MemorySwapMax=0', command)
            probe = command[command.index('-c') + 1]
            for bound in ('0xAE00', "'/user.slice/'", "'memory.max'", "'memory.swap.max'"):
                self.assertIn(bound, probe)
            self.assertTrue(json.loads((Path(tmp) / 'ci-preflight.json').read_text())['preflight_service_joined'])

    def test_larger_hosted_admission_uses_its_own_exact_bounds_and_no_swap(self):
        with patch.object(TRIAL, 'LARGE_CORE', 'a' * 40), \
                patch.object(CI, 'verify_host_tools', return_value={}), \
                patch.object(CI, 'module', return_value=TRIAL), \
                patch.object(TRIAL, 'available_memory', return_value=14 * TRIAL.GIB - 1), \
                patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'host_available_memory_below_14GiB'):
                CI.preflight(TRIAL.LARGE_MODEL)
            process.assert_not_called()
        calls = []
        def process(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, 'MainPID=0\nActiveState=inactive\n' if 'show' in args else '', '')
        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), \
                patch.object(TRIAL, 'LARGE_CORE', 'a' * 40), \
                patch.object(CI, 'verify_host_tools', return_value={}), \
                patch.object(CI, 'module', return_value=TRIAL), \
                patch.object(TRIAL, 'available_memory', return_value=14 * TRIAL.GIB), \
                patch.object(CI.subprocess, 'run', side_effect=process):
            CI.preflight(TRIAL.LARGE_MODEL)
            command = next(args for args in calls if args[0] == 'systemd-run')
            self.assertIn('--property=MemoryMax=' + str(13 * TRIAL.GIB), command)
            self.assertIn('--property=MemorySwapMax=0', command)
            self.assertEqual(command[-1], str(13 * TRIAL.GIB))
            receipt = json.loads((Path(tmp) / 'ci-preflight.json').read_text())
            self.assertEqual(receipt['model_profile'], TRIAL.LARGE_MODEL)
            self.assertEqual(receipt['memory_max'], 13 * TRIAL.GIB)
            self.assertEqual(receipt['host_available_required'], 14 * TRIAL.GIB)

    def test_ubuntu_qemu_changes_only_verified_tool_and_firmware_paths(self):
        original = TRIAL.qemu_command(Path('/verified/tools'), Path('/private/scratch'))
        hosted = TRIAL.qemu_command(Path('/usr'), Path('/private/scratch'),
                                    Path('/usr/share/seabios/vgabios-stdvga.bin'))
        firmware_index = original.index('-device') + 1
        self.assertEqual([arg for index, arg in enumerate(original) if index not in (0, firmware_index)],
                         [arg for index, arg in enumerate(hosted) if index not in (0, firmware_index)])
        self.assertEqual(hosted[0], Path('/usr/bin/qemu-system-x86_64'))
        self.assertIn('VGA,id=video0,bus=pcie.0,addr=0x1,romfile=/usr/share/seabios/vgabios-stdvga.bin', hosted)
        self.assertEqual(hosted[hosted.index('-m') + 1], '6144')
        self.assertEqual(hosted[hosted.index('-smp') + 1], '2')

    def test_fixed_receipt_export_does_not_publish_private_sentinels(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), patch.object(CI, 'guard'):
            root = Path(tmp)
            (root / 'ci-vm').mkdir()
            CI.record(root / 'ci-source.json', {'version': 1, 'code_revision': 'a' * 40})
            CI.record(root / 'ci-vm/vm-result.json', {'passed': False, 'qemu_joined': True})
            for name in ('ssh-key', 'console.log', 'task.json', 'ci-inputs.tar.gz'):
                (root / name).write_text('private sentinel')
            CI.export()
            result = root / 'ci-public-receipts'
            self.assertEqual({p.name for p in result.iterdir()}, {'ci-source.json', 'vm-result.json'})
            self.assertNotIn('sentinel', ''.join(p.read_text() for p in result.iterdir()))

    def test_large_closed_memory_receipt_reaches_existing_export_without_widening_torch(self):
        value = bounded_memory_receipt()
        diagnostic = value['core_diagnostics']
        raw_log_bytes = sum(len(marker) + len(json.dumps(row, separators=(',', ':'))) + 1
            for marker, rows in (('private_memory_diagnostic ', diagnostic['memory']),
                ('private_execution_state ', diagnostic['states']),
                ('private_execution_diagnostic ', diagnostic['events'])) for row in rows)
        self.assertLess(raw_log_bytes, 65536)
        self.assertLess(len(json.dumps(diagnostic['memory'][0], separators=(',', ':')))
                        + len('private_memory_diagnostic ') + 1, 4096)
        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), patch.object(CI, 'guard'):
            root = Path(tmp)
            (root / 'ci-vm').mkdir()
            source = root / 'ci-vm/guest-result.json'
            TRIAL.record(source, value)
            self.assertGreater(source.stat().st_size, 65536)
            self.assertLessEqual(source.stat().st_size, 256 * 1024)
            result = TRIAL.load(source, TRIAL.guest_receipt_limit('llama_cpp_bf16_v1'))
            self.assertEqual(result, value)
            self.assertFalse(result['passed'])
            TRIAL.validate_backend_fields(result, TRIAL.trial_profile(TRIAL.LARGE_MODEL, 'llama_cpp_bf16_v1'))
            with self.assertRaisesRegex(ValueError, 'report_bound'):
                TRIAL.load(source, TRIAL.guest_receipt_limit('torch'))
            CI.export()
            exported = root / 'ci-public-receipts/guest-result.json'
            self.assertEqual(json.loads(exported.read_bytes()), value)
            self.assertLessEqual(exported.stat().st_size, 256 * 1024)

    def test_export_ceiling_also_bounds_pretty_print_expansion(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), patch.object(CI, 'guard'):
            root = Path(tmp)
            (root / 'ci-vm').mkdir()
            source = root / 'ci-vm/guest-result.json'
            value = {'synthetic_counters': [0] * 60000}
            source.write_text(json.dumps(value, separators=(',', ':')))
            source.chmod(0o600)
            self.assertLess(source.stat().st_size, 256 * 1024)
            self.assertGreater(len(json.dumps(value, sort_keys=True, indent=2).encode()) + 1, 256 * 1024)
            with self.assertRaisesRegex(ValueError, 'closed_receipt_file'):
                CI.export()
            self.assertFalse((root / 'ci-public-receipts/guest-result.json').exists())

    def test_default_guest_keeps_reviewed_task_and_acceptance_with_closed_diagnostics(self):
        # Resolve only explicit profile substitutions and closed diagnostics.
        # Every other guest statement must still be
        # the reviewed 44022c8/afdb284 behavior, including its final success gate.
        current = (ROOT / 'scripts/smoke_opencode_inference.py').read_text()
        node = next(node for node in ast.parse(current).body
                    if isinstance(node, ast.FunctionDef) and node.name == 'guest')
        source = ast.get_source_segment(current, node)
        # Specialize only the explicit native opt-in to its unchanged torch
        # default. Keep the original fingerprint; do not replace the golden.
        native_blocks = [child for child in ast.walk(node) if isinstance(child, ast.If)
                         and ast.unparse(child.test) == "backend != 'torch'"]
        self.assertEqual(len(native_blocks), 2)
        for child in reversed(sorted(native_blocks, key=lambda item: item.lineno)):
            lines = source.splitlines(keepends=True)
            del lines[child.lineno - node.lineno:child.end_lineno - node.lineno + 1]
            source = ''.join(lines)
        source = specialize_memory_diagnostics(source)
        changes = (
            ("    backend = getattr(args, 'inference_backend', 'torch')\n", ''),
            ("trial_profile(getattr(args, 'model_profile', MODEL), backend)",
             "trial_profile(getattr(args, 'model_profile', MODEL))"),
            ("staged_inputs(profile['model_profile'], backend)", "staged_inputs(profile['model_profile'])"),
            ("    report.update(backend_fields(profile))\n", ''),
            ("task_arguments(backend)",
             "[str(INPUT / 'runtime/node'), str(INPUT / 'code/scripts/smoke_opencode_inference.cjs'),\n"
             "            '--execute', '--yes', '--node', str(INPUT / 'runtime/node'), '--build-report',\n"
             "            str(INPUT / 'runtime/build-report.json'), '--socket', str(BASE / 'private.sock'),\n"
             "            '--project-parent', str(PROJECTS), '--output', str(BASE / 'task.json')]"),
            ("validate_task_selection(report['task'], profile, backend)",
             "require(report['task']['model_profile'] == profile['model_profile'], 'task_model_mismatch')"),
            ("        provision_pins = (model.load_pins(profile['model_profile'], native_cpu_converter=True)\n"
             "                          if backend != 'torch' else model.load_pins(profile['model_profile']))\n",
             "        provision_pins = model.load_pins(profile['model_profile'])\n"),
            (",\n                *(['--native-cpu-source', str(BASE / 'llama-source'), '--native-cpu-build', str(BASE / 'llama-build')]\n"
             "                  if backend != 'torch' else [])", ''),
            (",\n            *(['--native-backend-root', str(BASE / 'ml/native-backend'), '--native-backend-sha256',\n"
             "               report['native_backend']['manifest_sha256']] if backend != 'torch' else [])", ''),
            ("'core_memory' if name == CORE_UNIT else\n                           'native_build_memory' if name == NATIVE_UNIT else 'task_memory'",
             "'core_memory' if name == CORE_UNIT else 'task_memory'"),
            ("(\n                               native_memory(profile['core_memory_bytes']) if name == NATIVE_UNIT else memory(name))", "memory(name)"),
            (",\n                native_cpu=backend != 'torch'", ''),
        )
        for added, original in changes:
            self.assertIn(added, source)
            source = source.replace(added, original)
        selection = "    profile = trial_profile(getattr(args, 'model_profile', MODEL))\n"
        guard = "            require(report['task']['model_profile'] == profile['model_profile'], 'task_model_mismatch')\n"
        self.assertIn(selection, source)
        self.assertIn(guard, source)
        source = source.replace(selection, '').replace(guard, '')
        diagnostic_changes = (
            ('    provision_stage, provision_pins, provision_wait_timeout = None, None, False\n', ''),
            ("        provision_stage = 'pins'\n"
             "        model = module(private.ML / 'provision.py', 'opencode_model_provision')\n"
             "        provision_pins = model.load_pins(profile['model_profile'])\n"
             "        provision_stage = 'launch'\n", ''),
            ("            provision_stage = 'process'\n"
             "            try:\n"
             "                require(provision.wait(timeout=1850) == 0, 'provision_failed')\n"
             "            except subprocess.TimeoutExpired:\n"
             "                provision_wait_timeout = True\n"
             "                raise\n",
             "            require(provision.wait(timeout=1850) == 0, 'provision_failed')\n"),
            ("        provision_stage = 'report'\n", ''),
            ("        provision_stage = 'provenance'\n        pins = provision_pins\n",
             "        model = module(private.ML / 'provision.py', 'opencode_model_provision')\n"
             "        pins = model.load_pins(profile['model_profile'])\n"),
            ("        provision_stage = 'complete'\n", ''),
            ("        if provision_stage is not None:\n"
             "            report['model_provision_diagnostic'] = closed_provision(BASE / 'provision.log', provision_pins,\n"
             "                provision_stage, provision.returncode if provision is not None else None, provision_wait_timeout)\n", ''),
        )
        for diagnostic, original in diagnostic_changes:
            self.assertEqual(source.count(diagnostic), 1)
            source = source.replace(diagnostic, original)
        for key, original in (('core_revision', 'CORE'), ('model_profile', 'MODEL'),
                              ('provision_budget_bytes', '5 * GIB'), ('core_memory_bytes', '5 * GIB')):
            source = source.replace("profile['" + key + "']", original)
        source = source.replace('staged_inputs(MODEL)', 'staged_inputs()')
        # Python 3.12 adds empty type_params; omit this non-semantic field to
        # retain the same structural fingerprint on local and hosted Python.
        def stable(value):
            if isinstance(value, ast.AST):
                return [type(value).__name__, [(name, stable(item)) for name, item in ast.iter_fields(value)
                                               if name != 'type_params']]
            return [stable(item) for item in value] if isinstance(value, list) else value
        encoded = json.dumps(stable(ast.parse(source).body[0]), sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(hashlib.sha256(encoded).hexdigest(),
                         '5321af83db1d961df90ecdbea73235da224117de85e32cd13143cb9436c6c637')

    def test_torch_specialization_rejects_changed_memory_opt_in_expressions(self):
        current = (ROOT / 'scripts/smoke_opencode_inference.py').read_text()
        node = next(node for node in ast.parse(current).body
                    if isinstance(node, ast.FunctionDef) and node.name == 'guest')
        source = ast.get_source_segment(current, node)
        self.assertNotIn('memory_enabled', specialize_memory_diagnostics(source))
        for old, new in (("'memory_enabled': True", "'memory_enabled': False"),
                         ("'memory_enabled': True", "'memory_enabled': 1"),
                         ("if backend != 'torch' else {}", "if backend == 'torch' else {}"),
                         ("if backend != 'torch' else {}", "if backend != 'torch' else {'memory_enabled': False}"),
                         ("CORE_UNIT + '.log'", "TASK_UNIT + '.log'")):
            with self.subTest(new=new), self.assertRaisesRegex(ValueError, 'memory_diagnostic_specialization'):
                specialize_memory_diagnostics(source.replace(old, new, 1))

    def test_workflow_has_one_manual_trial_and_closed_export_only(self):
        source = (ROOT / '.github/workflows/opencode-inference.yml').read_text()
        for required in ('workflow_dispatch:', 'cancel-in-progress: false', 'runs-on: ubuntu-24.04',
                         'steps.selected_core.outputs.core_revision', 'persist-credentials: false',
                         'default: qwen3-0.6b-v1', 'qwen3-4b-instruct-2507-v1',
                         '--model-profile "$MODEL_PROFILE"', '--host-tools-profile github-ubuntu-24.04',
                         'default: torch', '--inference-backend "$INFERENCE_BACKEND"', 'llama_cpp_bf16_v1',
                         'env -i PATH=/usr/bin:/bin', 'build/ci-public-receipts/*.json'):
            self.assertIn(required, source)
        for forbidden in ('pull_request:', '\n  push:', 'actions/cache', 'upload-artifact@main',
                          'sysctl -w', '--no-sandbox', 'continue-on-error:', '--resume'):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count('smoke_opencode_inference.py execute --yes'), 1)


if __name__ == '__main__':
    unittest.main()
