# SPDX-License-Identifier: GPL-3.0-only
"""Inert native fixture bindings; no source fetch, build, library or model load."""
import hashlib
import copy
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


NATIVE = load('opencode_native_cpu')
TRIAL = load('smoke_opencode_inference')
CI = load('opencode_ci')
KIND = 'llama_cpp_bf16_v1'


class Contracts(unittest.TestCase):
    def test_native_is_refused_without_final_pin_and_cannot_replace_default(self):
        self.assertEqual(TRIAL.NATIVE_CORE, '7d0f9f0b492c5e692cc9d26f23d95f55f2c1e651')
        original = TRIAL.trial_profile(TRIAL.LARGE_MODEL)
        self.assertNotIn('inference_backend', original)
        with patch.object(TRIAL, 'NATIVE_CORE', None), self.assertRaisesRegex(ValueError, 'native_core_not_pinned'):
            TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
        for model in (TRIAL.MODEL,):
            with self.assertRaisesRegex(ValueError, 'native_backend_requires_qwen4b'):
                TRIAL.trial_profile(model, KIND)
        for backend in (None, '', 'llama_cpp', 'torch;id'):
            with self.assertRaisesRegex(ValueError, 'unknown_inference_backend'):
                TRIAL.trial_profile(TRIAL.LARGE_MODEL, backend)
        # Synthetic pin tests selection only; no invented production pin is set.
        with patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            native = TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
            self.assertEqual({k: v for k, v in native.items() if k not in
                              ('core_revision', 'inference_backend', 'native_source_commit')},
                             {k: v for k, v in original.items() if k != 'core_revision'})
            self.assertEqual(native['native_source_commit'], NATIVE.SOURCE)
            self.assertEqual(TRIAL.trial_profile(TRIAL.LARGE_MODEL), original)
            old = TRIAL.qemu_command(Path('/tools'), Path('/scratch'), model_profile=TRIAL.LARGE_MODEL)
            new = TRIAL.qemu_command(Path('/tools'), Path('/scratch'), model_profile=TRIAL.LARGE_MODEL,
                                     inference_backend=KIND)
            self.assertEqual(old, new)

    def test_backend_metadata_cannot_be_missing_partial_or_implicitly_added(self):
        with patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            profile = TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
        exact = {'inference_backend': KIND, 'native_source_commit': NATIVE.SOURCE}
        TRIAL.validate_backend_fields(exact, profile)
        self.assertEqual(CI.backend_fields(profile), exact)
        for value in ({}, {'inference_backend': KIND}, {'native_source_commit': NATIVE.SOURCE},
                      dict(exact, inference_backend='torch'), dict(exact, native_source_commit='0' * 40)):
            with self.assertRaisesRegex(ValueError, 'input_backend'):
                TRIAL.validate_backend_fields(value, profile)
        for value in (exact, {'inference_backend': None}):
            with self.assertRaisesRegex(ValueError, 'input_backend'):
                TRIAL.validate_backend_fields(value, TRIAL.trial_profile())

    def test_real_bundle_and_staging_parsers_reject_native_source_substitution(self):
        payload = b'inert input bytes, no runtime or model'
        row = dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(), mode=0o600)
        exact = dict(core_revision='a' * 40, model_profile=TRIAL.LARGE_MODEL,
                     inference_backend=KIND, native_source_commit=NATIVE.SOURCE,
                     code_contains_uncommitted_changes=True, code_git_head_proves_migration=False,
                     files={'code/example.cjs': row})
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            root = Path(temp)
            (root / 'code').mkdir()
            (root / 'code/example.cjs').write_bytes(payload)
            (root / 'code/example.cjs').chmod(0o600)
            for value, accepted in ((exact, True), (dict(exact, core_revision='b' * 40), False),
                                    (dict(exact, model_profile=TRIAL.MODEL), False),
                                    (dict(exact, inference_backend='torch'), False),
                                    (dict(exact, native_source_commit='b' * 40), False),
                                    ({key: val for key, val in exact.items()
                                      if key != 'native_source_commit'}, False)):
                raw = json.dumps(value).encode()
                path = root / 'inputs.tar.gz'
                with tarfile.open(path, 'w:gz') as archive:
                    for name, content in (('code/example.cjs', payload), ('INPUTS.json', raw)):
                        entry = tarfile.TarInfo(name)
                        entry.mode, entry.size = 0o600, len(content)
                        archive.addfile(entry, io.BytesIO(content))
                (root / 'INPUTS.json').write_bytes(raw)
                with self.subTest(value=value), patch.object(TRIAL, 'INPUT', root):
                    for parse in (lambda: TRIAL.validate_bundle(path, TRIAL.LARGE_MODEL, KIND),
                                  lambda: TRIAL.staged_inputs(TRIAL.LARGE_MODEL, KIND)):
                        if accepted:
                            self.assertEqual(parse(), exact)
                        else:
                            with self.assertRaises(ValueError):
                                parse()

    def test_ci_capture_binds_same_backend_and_rejects_mixed_source_receipts(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40), \
                patch.object(CI, 'BUILD', Path(temp)), patch.object(CI, 'guard'), \
                patch.object(CI, 'module', return_value=TRIAL), \
                patch.dict(os.environ, {'GITHUB_SHA': 'c' * 40}):
            root = Path(temp)
            manifest = dict(code_base_revision='c' * 40, core_revision='a' * 40,
                            model_profile=TRIAL.LARGE_MODEL, inference_backend=KIND,
                            native_source_commit=NATIVE.SOURCE)
            source = dict(manifest, code_revision='c' * 40)
            (root / 'ci-source.json').write_text(json.dumps(source))
            (root / 'ci-inputs.tar.gz').write_bytes(b'inert bundle, parser checked separately')
            with patch.object(TRIAL, 'validate_bundle', return_value=manifest) as parser:
                CI.capture(TRIAL.LARGE_MODEL, KIND)
                parser.assert_called_once_with(root / 'ci-inputs.tar.gz', TRIAL.LARGE_MODEL, KIND)
                captured = json.loads((root / 'ci-inputs.json').read_text())
                self.assertEqual(captured['inference_backend'], KIND)
                self.assertEqual(captured['native_source_commit'], NATIVE.SOURCE)
                (root / 'ci-source.json').write_text(json.dumps(dict(source, inference_backend='torch')))
                with self.assertRaisesRegex(ValueError, 'input_backend'):
                    CI.capture(TRIAL.LARGE_MODEL, KIND)

    def test_native_missing_pin_stops_before_memory_tools_or_vm(self):
        with patch.object(TRIAL, 'NATIVE_CORE', None), patch.object(TRIAL, 'run') as process, \
                patch.object(TRIAL, 'available_memory') as memory:
            with self.assertRaisesRegex(ValueError, 'native_core_not_pinned'):
                TRIAL.execute(SimpleNamespace(model_profile=TRIAL.LARGE_MODEL, inference_backend=KIND))
            process.assert_not_called()
            memory.assert_not_called()

    def test_only_native_build_unit_can_receive_public_source_network(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'BASE', Path(temp)), \
                patch.object(TRIAL, 'run') as process:
            for unit in (TRIAL.CORE_UNIT, TRIAL.TASK_UNIT, 'untrusted.service'):
                with self.assertRaisesRegex(ValueError, 'native_build_network_scope'):
                    TRIAL.start(unit, ['inert'], 11 * TRIAL.GIB, 1800, public_source_build=True)
            process.assert_not_called()
            TRIAL.start(TRIAL.NATIVE_UNIT, ['inert'], 11 * TRIAL.GIB, 1800, public_source_build=True)
            args = process.call_args.args[0]
            for field in ('--property=PrivateNetwork=no', '--property=MemoryMax=' + str(11 * TRIAL.GIB),
                          '--property=MemorySwapMax=0', '--property=RuntimeMaxSec=1800',
                          '--property=KillMode=control-group', '--property=NoNewPrivileges=yes'):
                self.assertIn(field, args)
            TRIAL.start(TRIAL.CORE_UNIT, ['inert'], 11 * TRIAL.GIB, 2700)
            self.assertIn('--property=PrivateNetwork=yes', process.call_args.args[0])
        with patch.object(TRIAL.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            TRIAL.unit(TRIAL.NATIVE_UNIT, 'stop')
            self.assertEqual(TRIAL.cgroup(TRIAL.NATIVE_UNIT).name, TRIAL.NATIVE_UNIT)

    def test_native_helper_refuses_host_before_acquisition_or_build(self):
        with patch.object(NATIVE.os, 'getuid', return_value=0), patch.object(NATIVE.subprocess, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'disposable_guest_required'):
                NATIVE.guest_build()
            process.assert_not_called()

    def test_actual_build_shell_prefix_forwards_backend_before_any_profile_or_sudo(self):
        script = (ROOT / 'scripts/opencode_ci_build.sh').read_text()
        prefix, separator, _ = script.partition('profile="$core/tests/integration/native-coding-bwrap.apparmor"')
        self.assertTrue(separator)
        addition = ' --inference-backend "${INFERENCE_BACKEND:-torch}"'
        self.assertEqual(prefix.count(addition), 1)
        # Execute the real shell prefix and the real CLI selector. Only its
        # hosted-machine guard is replaced; no build, profile, sudo or VM runs.
        bridge = '''python3() {
  command /usr/bin/python3 -B -c '
import importlib.util, sys
from pathlib import Path
assert sys.argv[1] == "-B"
path = Path(sys.argv[2]).resolve()
spec = importlib.util.spec_from_file_location("inert_ci_prefix", path)
value = importlib.util.module_from_spec(spec)
spec.loader.exec_module(value)
value.guard = lambda: None
sys.argv = [str(path), *sys.argv[3:]]
value.main()
' "$@"
}
git() {
  test "$#" = 4 && test "$1" = -C && test "$3" = rev-parse && test "$4" = HEAD || return 99
  printf '%s\\n' "$TEST_EXPECTED_CORE"
}
sudo() { return 99; }
'''
        def check(source, model=None, backend=None, core=TRIAL.CORE):
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TEST_EXPECTED_CORE': core}
            if model is not None:
                env['MODEL_PROFILE'] = model
            if backend is not None:
                env['INFERENCE_BACKEND'] = backend
            return subprocess.run(['/bin/bash', '-c', bridge + source + '\nprintf "PREFIX_ACCEPTED\\n"\n'],
                                  cwd=ROOT, env=env, capture_output=True, text=True, timeout=10)
        for model, backend, core in ((None, None, TRIAL.CORE),
                                     (TRIAL.LARGE_MODEL, 'torch', TRIAL.LARGE_CORE),
                                     (TRIAL.LARGE_MODEL, KIND, TRIAL.NATIVE_CORE)):
            result = check(prefix, model, backend, core)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'PREFIX_ACCEPTED\n')
        # The original prefix genuinely fails the native checkout, then the
        # corrected same prefix passes above; failures never reach profile work.
        for source, model, backend, core in (
                (prefix.replace(addition, ''), TRIAL.LARGE_MODEL, KIND, TRIAL.NATIVE_CORE),
                (prefix, TRIAL.LARGE_MODEL, KIND, TRIAL.LARGE_CORE),
                (prefix, TRIAL.MODEL, KIND, TRIAL.NATIVE_CORE),
                (prefix, TRIAL.LARGE_MODEL, 'unknown', TRIAL.NATIVE_CORE)):
            result = check(source, model, backend, core)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('PREFIX_ACCEPTED', result.stdout)

    def test_stacked_source_workflow_keeps_original_jobs_and_only_removes_pr_filter(self):
        source = (ROOT / '.github/workflows/source-checks.yml').read_text()
        self.assertIn('  push:\n    branches: [main]\n  pull_request:\n', source)
        self.assertEqual(source.count('branches: [main]'), 1)
        self.assertNotIn('feature/', source)
        self.assertIn('permissions:\n  contents: read\n', source)
        self.assertIn('timeout-minutes: 5', source)
        self.assertIn("python3 -B -m unittest discover -s tests -p 'test_*opencode*.py'", source)

    def test_acquisition_and_build_use_exact_source_in_guest_not_prebuilt_payload(self):
        source = inspect.getsource(NATIVE.guest_build)
        for text in ("'fetch', '--depth=1', '--no-tags', 'origin', SOURCE", 'builder.verify_source(source)',
                     "'--source', str(source), '--output', str(output), '--execute'",
                     "'GIT_CONFIG_GLOBAL': '/dev/null'", 'https://github.com/ggml-org/llama.cpp.git'):
            self.assertIn(text, source if text.startswith(('builder', "'fetch'", "'--source'"))
                          else (ROOT / 'scripts/opencode_native_cpu.py').read_text())
        self.assertNotIn('ctypes.CDLL', source)
        self.assertNotIn('curl', source)

    def test_guest_keeps_original_task_and_inference_budgets_and_joins_native_unit(self):
        source = inspect.getsource(TRIAL.guest)
        for text in ("model.load_pins(profile['model_profile'], native_cpu_converter=True)",
                     'model.retained_pin_files(pins)', "'--native-cpu-source'", "'--native-cpu-build'",
                     "'--native-backend-root'", "'--native-backend-sha256'",
                     "report['native_backend']['manifest_sha256']", 'provision.wait(timeout=1850)',
                     "'--threads', '2', '--max-seconds', '600'", '768 * 1024**2, 2550',
                     'time.monotonic() + 2565', 'created.append(NATIVE_UNIT)', 'for name in reversed(created)',
                     "report['units_empty'] = all(empty(name) for name in created)",
                     "if report['units_empty'] and report['provision_group_joined']:"):
            self.assertIn(text, source)
        task_driver = (ROOT / 'scripts/smoke_opencode_inference.cjs').read_bytes()
        # Exact source with opt-in output selection and descriptor-bound fixture reads.
        # The reviewed delta changes only contents() and its fs.constants import.
        # Focused JS tests retain the original prompt, approvals and round bounds;
        # no regenerated answers or claim of model quality.
        self.assertEqual(hashlib.sha256(task_driver).hexdigest(),
                         '0f395f215d11b3ebc868299a7695908511724778b72d2966b9669ccaf20ccf13')

    def test_native_memory_requires_actual_zero_swap_and_oom_not_just_limits(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'cgroup', return_value=Path(temp)):
            root, limit = Path(temp), 11 * TRIAL.GIB
            original = {'memory.max': str(limit), 'memory.swap.max': '0', 'memory.peak': '123456',
                        'memory.swap.current': '0', 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'}
            def write(values):
                for name, text in values.items():
                    (root / name).write_text(text)
            write(original)
            observed = TRIAL.native_memory(limit)
            self.assertEqual(observed['swap_current'], 0)
            self.assertEqual(observed['oom'], 0)
            for mutation in ({'memory.swap.current': '1'}, {'memory.swap.max': '1'},
                             {'memory.max': str(limit + 1)}, {'memory.peak': str(limit + 1)},
                             {'memory.events': 'oom 1\noom_kill 0\n'},
                             {'memory.events': 'oom 0\noom_kill 1\n'}):
                write(dict(original, **mutation))
                with self.assertRaisesRegex(ValueError, 'native_build_resource_violation'):
                    TRIAL.native_memory(limit)
            write(original)
            (root / 'memory.swap.current').unlink()
            with self.assertRaises(OSError):
                TRIAL.native_memory(limit)

    def test_native_conversion_diagnostic_is_exact_opt_in_and_no_raw_export(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'provision.log'
            path.write_bytes(b'NATIVE_CONVERSION_FAILED\nProvisioning refused: Command CANARY returned non-zero exit status 1.\n')
            path.chmod(0o600)
            legacy = TRIAL.closed_provision(path, None, 'process', 1)
            native = TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
            self.assertEqual(set(legacy) | {'native_conversion'}, set(native))
            self.assertEqual(native['native_conversion']['state'], 'absent')
            self.assertEqual(legacy['failure_class'], 'runtime_subprocess')
            self.assertEqual(native['failure_class'], 'native_conversion')
            self.assertNotIn('CANARY', json.dumps(native))
            for raw in (b'NATIVE_CONVERSION_FAILED CANARY\n', b'prefix NATIVE_CONVERSION_FAILED\n',
                        b'NATIVE_CONVERSION_FAILED\n' + b'x' * 131073):
                path.write_bytes(raw)
                self.assertNotEqual(TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
                                    ['failure_class'], 'native_conversion')

    @staticmethod
    def conversion_line(**changes):
        value = dict(version=1, kind='native-conversion-failure', stage='convert',
                     failure='child_failed', child_exit_status=7)
        value.update(changes)
        return b'NATIVE_CONVERSION_DIAGNOSTIC ' + json.dumps(value).encode()

    def test_conversion_failure_schema_preserves_closed_stage_and_child_status(self):
        stages = ('guard', 'source', 'runtime', 'model', 'build', 'budget', 'convert', 'tokenizer',
                  'verify', 'recheck', 'bundle', 'manifest', 'permissions')
        failures = ('cancelled', 'timeout', 'missing_file', 'permission', 'memory', 'import',
                    'subprocess', 'os_error', 'invalid_shape', 'child_failed', 'disk_budget', 'contract')
        for stage in stages:
            for failure in failures:
                with self.subTest(stage=stage, failure=failure):
                    value = TRIAL.closed_conversion([self.conversion_line(stage=stage, failure=failure),
                                                     b'NATIVE_CONVERSION_FAILED'], 'present', 1)
                    self.assertEqual(value, dict(state='reported_failure', stage=stage,
                                                 failure=failure, child_exit_status=7))
        for status in (-128, -15, -9, 0, 255, None):
            with self.subTest(status=status):
                value = TRIAL.closed_conversion([self.conversion_line(failure='timeout', child_exit_status=status),
                                                 b'NATIVE_CONVERSION_FAILED'], 'present', 1)
                self.assertEqual(value['child_exit_status'], status)
                self.assertEqual(value['state'], 'reported_failure')

    def test_conversion_absent_unknown_invalid_and_forged_success_stay_unproven(self):
        for lines in ([], [b'NATIVE_CONVERSION_FAILED'], [b'prefix ' + self.conversion_line()]):
            self.assertEqual(TRIAL.closed_conversion(lines, 'present', 1)['state'], 'absent')
        for changes in ({'stage': 'unknown'}, {'failure': 'unknown'}):
            result = TRIAL.closed_conversion([self.conversion_line(**changes), b'NATIVE_CONVERSION_FAILED'], 'present', 1)
            self.assertEqual(result['state'], 'unknown')
        for changes in ({'version': True}, {'version': 2}, {'kind': 'native-conversion-success'},
                        {'stage': 'complete'}, {'stage': ['CANARY']}, {'stage': 'CANARY'},
                        {'failure': 'success'}, {'failure': 'CANARY'}, {'child_exit_status': True},
                        {'child_exit_status': -129}, {'child_exit_status': 256}, {'child_exit_status': '7'},
                        {'child_exit_status': 0}, {'child_exit_status': None}, {'private_path': 'CANARY'}):
            result = TRIAL.closed_conversion([self.conversion_line(**changes), b'NATIVE_CONVERSION_FAILED'], 'present', 1)
            self.assertEqual(result, dict(state='invalid', stage='unknown', failure='unknown', child_exit_status=None))
            self.assertNotIn('CANARY', json.dumps(result))
        for status in (0, None, True, 256):
            result = TRIAL.closed_conversion([self.conversion_line(), b'NATIVE_CONVERSION_FAILED'], 'present', status)
            self.assertEqual(result['state'], 'invalid')
        for state, expected in (('absent', 'absent'), ('invalid', 'invalid'), ('truncated', 'invalid')):
            self.assertEqual(TRIAL.closed_conversion([self.conversion_line(), b'NATIVE_CONVERSION_FAILED'],
                                                    state, 1)['state'], expected)

    def test_conversion_duplicate_malformed_and_missing_markers_are_rejected(self):
        valid = self.conversion_line()
        mutations = ([valid], [valid, valid, b'NATIVE_CONVERSION_FAILED'],
            [valid, b'NATIVE_CONVERSION_FAILED', b'NATIVE_CONVERSION_FAILED'],
            [valid.replace(b'"version": 1', b'"version": 0, "version": 1'), b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC {', b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC []', b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC null', b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC "\\ud800"', b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC ' + b'x' * 1025, b'NATIVE_CONVERSION_FAILED'],
            [b'NATIVE_CONVERSION_DIAGNOSTIC \xff', b'NATIVE_CONVERSION_FAILED'])
        for lines in mutations:
            with self.subTest(lines=lines):
                self.assertEqual(TRIAL.closed_conversion(lines, 'present', 1),
                                 dict(state='invalid', stage='unknown', failure='unknown', child_exit_status=None))

    def test_conversion_detail_flows_into_final_provision_summary_only_when_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'provision.log'
            raw = self.conversion_line(stage='verify', failure='contract', child_exit_status=0) \
                + b'\nNATIVE_CONVERSION_FAILED\nProvisioning refused: Command CANARY returned non-zero exit status 1.\n'
            path.write_bytes(raw)
            path.chmod(0o600)
            native = TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
            self.assertEqual(native['failure_class'], 'native_conversion')
            self.assertEqual(native['native_conversion'], dict(state='reported_failure', stage='verify',
                                                              failure='contract', child_exit_status=0))
            self.assertNotIn('CANARY', json.dumps(native))
            self.assertNotIn('native_conversion', TRIAL.closed_provision(path, None, 'process', 1))
            path.write_bytes(raw + b'x' * 131073)
            self.assertEqual(TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
                             ['native_conversion']['state'], 'invalid')
            path.write_bytes(raw + self.conversion_line() + b'\n')
            native = TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
            self.assertEqual(native['failure_class'], 'native_conversion')
            self.assertEqual(native['native_conversion']['state'], 'invalid')

    def test_native_unit_diagnostics_are_closed_and_do_not_invent_log_inspection(self):
        value = TRIAL.closed_native_unit({'ActiveState': 'failed', 'Result': 'timeout',
                                         'SubState': 'failed', 'ExecMainStatus': '9', 'private': 'CANARY'})
        self.assertEqual(value, {'active': 'failed', 'substate': 'failed', 'result': 'timeout', 'status': 9})
        self.assertNotIn('CANARY', json.dumps(value))
        self.assertNotIn('stderr', json.dumps(value))
        self.assertEqual(TRIAL.closed_native_unit({'SubState': 'CANARY'})['substate'], 'unknown')
        for error, expected in ((FileNotFoundError('CANARY'), 'missing_file'),
                                (PermissionError('CANARY'), 'permission'),
                                (TimeoutError('CANARY'), 'timeout'),
                                (subprocess.TimeoutExpired(['CANARY'], 1), 'timeout'),
                                (subprocess.CalledProcessError(1, ['CANARY']), 'subprocess_error'),
                                (OSError('CANARY'), 'os_error'),
                                (ValueError('native_deadline'), 'deadline'),
                                (ValueError('CANARY'), 'contract'), (KeyError('CANARY'), 'invalid_shape')):
            self.assertEqual(TRIAL.closed_native_exception(error), expected)

    def test_original_post_exit_resource_read_reproduces_pruned_cgroup_failure(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'cgroup', return_value=Path(temp) / 'pruned'):
            state = dict(ActiveState='active', SubState='exited', Result='success', ExecMainStatus='0')
            self.assertEqual(TRIAL.closed_native_unit(state)['status'], 0)
            self.assertTrue(TRIAL.empty(TRIAL.NATIVE_UNIT))
            with self.assertRaises(FileNotFoundError):
                TRIAL.native_memory(11 * TRIAL.GIB)

    def exercise_handshake(self, *, ready_nonce=None, terminal_failure=False, resources=None,
                           pruned=False, descendants=False, stale_manifest=False, expire_after_snapshot=False,
                           ready_payload=None):
        """Real local sockets, synthetic cgroup/unit data; never a host service/build/model."""
        with tempfile.TemporaryDirectory(prefix='vp-native-') as temp:
            root, limit = Path(temp), 11 * TRIAL.GIB
            group = root / 'group'
            group.mkdir()
            values = {'cgroup.procs': str(os.getpid()) + '\n', 'memory.max': str(limit),
                      'memory.swap.max': '0', 'memory.peak': '123456', 'memory.swap.current': '0',
                      'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'}
            if descendants:
                values['cgroup.procs'] += str(os.getpid() + 1) + '\n'
            values.update(resources or {})
            for name, value in values.items():
                (group / name).write_text(value)
            build = {'build_manifest_sha256': 'a' * 64}
            nonce = 'b' * 64
            done, errors, events = threading.Event(), [], []
            expired = threading.Event()
            clock = time.monotonic_ns
            deadline = time.monotonic_ns() + 2_000_000_000
            def helper():
                try:
                    if ready_payload is None:
                        NATIVE.await_release(root, build, ready_nonce or nonce, deadline, os.getpid())
                    else:
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
                            channel.settimeout(NATIVE.remaining(deadline))
                            channel.connect(str(root / NATIVE.CONTROL))
                            NATIVE.send_frame(channel, ready_payload, deadline)
                            NATIVE.receive_frame(channel, deadline)
                    events.append('helper_released')
                except Exception as error:
                    errors.append(error)
                finally:
                    done.set()
            def state(_name):
                if done.is_set():
                    (group / 'cgroup.procs').write_text('')
                    return dict(ActiveState='failed' if terminal_failure else 'active',
                                SubState='failed' if terminal_failure else 'exited',
                                MainPID='0', Result='exit-code' if terminal_failure else 'success',
                                ExecMainStatus='7' if terminal_failure else '0')
                return dict(ActiveState='active', SubState='running', MainPID=str(os.getpid()),
                            Result='success', ExecMainStatus='0')
            original_memory = TRIAL.native_memory
            def observe(current_limit):
                self.assertFalse(done.is_set())
                self.assertNotIn('helper_released', events)
                result = original_memory(current_limit)
                events.append('parent_measured')
                if expire_after_snapshot:
                    expired.set()
                return result
            report, failure, result = {}, None, None
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                path = root / NATIVE.CONTROL
                listener.bind(str(path))
                path.chmod(0o600)
                listener.listen(1)
                worker = threading.Thread(target=helper)
                worker.start()
                try:
                    with patch.object(TRIAL, 'properties', side_effect=state), \
                            patch.object(TRIAL, 'cgroup', return_value=root / 'missing' if pruned else group), \
                            patch.object(TRIAL, 'native_memory', side_effect=observe), \
                            patch.object(NATIVE.time, 'monotonic_ns', side_effect=lambda:
                                         deadline + 1 if expired.is_set() else clock()), \
                            patch.object(NATIVE, 'validate_build', return_value=dict(build,
                                build_manifest_sha256='c' * 64 if stale_manifest else build['build_manifest_sha256'])):
                        result = TRIAL.native_build_handshake(NATIVE, listener, nonce, deadline, limit, report)
                except Exception as error:
                    failure = error
                finally:
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive(), 'helper must join on every handshake failure')
            return result, report, failure, errors, events

    def test_actual_socket_handshake_keeps_helper_live_for_parent_resource_snapshot(self):
        result, report, failure, errors, events = self.exercise_handshake()
        self.assertIsNone(failure)
        self.assertEqual(errors, [])
        self.assertEqual(events, ['parent_measured', 'helper_released'])
        self.assertEqual(result, {'build_manifest_sha256': 'a' * 64})
        self.assertEqual(report['native_build_stage'], 'complete')
        self.assertEqual(report['native_build_unit']['substate'], 'exited')
        self.assertEqual(report['native_build_memory'], dict(maximum=11 * TRIAL.GIB, swap=0,
                         peak=123456, oom_kill=0, swap_current=0, oom=0))

    def test_separate_helper_process_uses_actual_peer_credentials_and_joins(self):
        # The real handshake crosses a process boundary. Only unit/cgroup and
        # build provenance are inert fixtures; no systemd, source build or model.
        with tempfile.TemporaryDirectory(prefix='vp-native-') as temp, \
                socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            root, limit = Path(temp), 11 * TRIAL.GIB
            group = root / 'group'
            group.mkdir()
            for name, value in {'memory.max': str(limit), 'memory.swap.max': '0',
                                'memory.peak': '123456', 'memory.swap.current': '0',
                                'memory.events': 'oom 0\noom_kill 0\n'}.items():
                (group / name).write_text(value)
            path = root / NATIVE.CONTROL
            listener.bind(str(path))
            path.chmod(0o600)
            listener.listen(1)
            deadline = time.monotonic_ns() + 3_000_000_000
            nonce, build = 'b' * 64, {'build_manifest_sha256': 'a' * 64}
            program = '''import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('inert_native_helper', sys.argv[1])
value = importlib.util.module_from_spec(spec)
spec.loader.exec_module(value)
value.await_release(Path(sys.argv[2]), {'build_manifest_sha256': 'a' * 64},
                    sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
'''
            child = subprocess.Popen([sys.executable, '-B', '-c', program,
                str(ROOT / 'scripts/opencode_native_cpu.py'), str(root), nonce, str(deadline), str(os.getpid())],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            (group / 'cgroup.procs').write_text(str(child.pid) + '\n')
            def state(_name):
                code = child.poll()
                if code is not None:
                    (group / 'cgroup.procs').write_text('')
                    return dict(ActiveState='active' if code == 0 else 'failed',
                                SubState='exited' if code == 0 else 'failed',
                                MainPID='0', Result='success' if code == 0 else 'exit-code', ExecMainStatus=str(code))
                return dict(ActiveState='active', SubState='running', MainPID=str(child.pid),
                            Result='success', ExecMainStatus='0')
            try:
                with patch.object(TRIAL, 'properties', side_effect=state), \
                        patch.object(TRIAL, 'cgroup', return_value=group), \
                        patch.object(NATIVE, 'validate_build', return_value=build):
                    report = {}
                    self.assertEqual(TRIAL.native_build_handshake(NATIVE, listener, nonce, deadline, limit, report), build)
                    self.assertEqual(report['native_build_stage'], 'complete')
                stdout, stderr = child.communicate(timeout=1)
                self.assertEqual((child.returncode, stdout, stderr), (0, b'', b''))
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=2)

    def test_ready_binding_or_manifest_mismatch_never_releases_helper(self):
        for options in ({'ready_nonce': 'c' * 64}, {'stale_manifest': True},
                        {'ready_payload': b'{"unknown":"CANARY"}\n'}, {'ready_payload': b'invalid\n'}):
            with self.subTest(options=options):
                result, report, failure, errors, events = self.exercise_handshake(**options)
                self.assertIsNone(result)
                self.assertRegex(str(failure), 'native_handshake_binding')
                self.assertTrue(errors)
                self.assertEqual(events, [])
                self.assertNotIn('native_build_memory', report)

    def test_expiry_after_valid_snapshot_still_refuses_release_and_success(self):
        result, report, failure, errors, events = self.exercise_handshake(expire_after_snapshot=True)
        self.assertIsNone(result)
        self.assertRegex(str(failure), 'native_deadline')
        self.assertEqual(events, ['parent_measured'])
        self.assertTrue(errors)
        self.assertEqual(report['native_build_stage'], 'release')

    def test_pruned_cgroup_or_remaining_descendants_cannot_pass_readiness(self):
        for options in ({'pruned': True}, {'descendants': True}):
            with self.subTest(options=options):
                result, report, failure, errors, events = self.exercise_handshake(**options)
                self.assertIsNone(result)
                self.assertIsInstance(failure, ValueError)
                self.assertEqual(events, [])
                self.assertTrue(errors)
                self.assertNotIn('native_build_memory', report)

    def test_nonzero_actual_swap_or_oom_never_releases_helper(self):
        for mutation in ({'memory.swap.current': '1'}, {'memory.swap.max': '1'},
                         {'memory.events': 'oom 1\noom_kill 0\n'},
                         {'memory.events': 'oom 0\noom_kill 1\n'},
                         {'memory.max': str(12 * TRIAL.GIB)}, {'memory.peak': str(12 * TRIAL.GIB)}):
            with self.subTest(mutation=mutation):
                result, report, failure, errors, events = self.exercise_handshake(resources=mutation)
                self.assertIsNone(result)
                self.assertRegex(str(failure), 'native_build_resource_violation')
                self.assertEqual(events, [])
                self.assertTrue(errors)
                self.assertEqual(report['native_build_stage'], 'resources')

    def test_parent_measurement_does_not_mask_failed_exit_after_release(self):
        result, report, failure, errors, events = self.exercise_handshake(terminal_failure=True)
        self.assertIsNone(result)
        self.assertRegex(str(failure), 'native_build_failed')
        self.assertEqual(errors, [])
        self.assertEqual(events, ['parent_measured', 'helper_released'])
        self.assertEqual(report['native_build_stage'], 'exit')
        self.assertEqual(report['native_build_unit']['status'], 7)

    def test_release_mismatch_is_refused_by_actual_helper_socket(self):
        with tempfile.TemporaryDirectory(prefix='vp-native-') as temp:
            root, errors = Path(temp), []
            deadline = time.monotonic_ns() + 2_000_000_000
            def helper():
                try:
                    NATIVE.await_release(root, {'build_manifest_sha256': 'a' * 64},
                                         'b' * 64, deadline, os.getpid())
                except Exception as error:
                    errors.append(error)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                path = root / NATIVE.CONTROL
                listener.bind(str(path))
                path.chmod(0o600)
                listener.listen(1)
                listener.settimeout(2)
                worker = threading.Thread(target=helper)
                worker.start()
                try:
                    channel, _ = listener.accept()
                    with channel:
                        self.assertEqual(NATIVE.receive_frame(channel, deadline), NATIVE.binding('ready', 'b' * 64, 'a' * 64))
                        NATIVE.send_frame(channel, NATIVE.binding('release', 'c' * 64, 'a' * 64), deadline)
                finally:
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertRegex(str(errors[0]), 'native_handshake_binding')

    def test_expired_unknown_peer_and_oversized_or_empty_socket_frames_fail_closed(self):
        now = time.monotonic_ns()
        for deadline in (now - 1, now + 1801 * 1_000_000_000, True, None):
            with self.subTest(deadline=deadline), self.assertRaisesRegex(ValueError, 'native_deadline'):
                NATIVE.remaining(deadline)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            with self.assertRaisesRegex(ValueError, 'native_deadline'):
                TRIAL.native_build_handshake(NATIVE, listener, 'b' * 64, now - 1, 11 * TRIAL.GIB, {})
        for payload in (b'', b'x' * 1025):
            left, right = socket.socketpair()
            with self.subTest(size=len(payload)), left, right:
                NATIVE.peer(left, os.getpid())
                with self.assertRaisesRegex(ValueError, 'native_handshake_peer'):
                    NATIVE.peer(left, os.getpid() + 1)
                right.sendall(payload)
                right.shutdown(socket.SHUT_WR)
                with self.assertRaisesRegex(ValueError, 'native_handshake_frame'):
                    NATIVE.receive_frame(left, time.monotonic_ns() + 1_000_000_000)
        left, right = socket.socketpair()
        with left, right, self.assertRaises(TimeoutError):
            NATIVE.receive_frame(left, time.monotonic_ns() + 10_000_000)

    def test_missing_readiness_after_unit_failure_is_not_waited_into_success(self):
        with tempfile.TemporaryDirectory(prefix='vp-native-') as temp, \
                socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(Path(temp) / 'control'))
            listener.listen(1)
            state = dict(ActiveState='failed', SubState='failed', MainPID='0', Result='exit-code', ExecMainStatus='1')
            report = {}
            with patch.object(TRIAL, 'properties', return_value=state), \
                    self.assertRaisesRegex(ValueError, 'native_build_ended_before_ready'):
                TRIAL.native_build_handshake(NATIVE, listener, 'b' * 64,
                                            time.monotonic_ns() + 1_000_000_000, 11 * TRIAL.GIB, report)
            self.assertEqual(report['native_build_unit']['status'], 1)

    def test_launch_uses_one_original_deadline_and_closes_listener_on_errors(self):
        with tempfile.TemporaryDirectory(prefix='vp-native-') as temp, \
                patch.object(TRIAL, 'BASE', Path(temp)), patch.object(TRIAL, 'module', return_value=NATIVE), \
                patch.object(TRIAL, 'start') as start:
            report, before = {}, time.monotonic_ns()
            def fail(native, listener, nonce, deadline, limit, observed):
                self.assertIs(native, NATIVE)
                self.assertIs(observed, report)
                self.assertEqual(limit, 11 * TRIAL.GIB)
                self.assertLessEqual(deadline, time.monotonic_ns() + 1800 * 1_000_000_000)
                self.assertGreaterEqual(deadline, before + 1800 * 1_000_000_000)
                unit, args, memory, seconds = start.call_args.args
                self.assertEqual((unit, memory, seconds), (TRIAL.NATIVE_UNIT, limit, 1800))
                self.assertEqual(start.call_args.kwargs, {'public_source_build': True})
                self.assertEqual(args[-6:], ['--deadline-monotonic-ns', str(deadline),
                                           '--handshake-nonce', nonce, '--parent-pid', str(os.getpid())])
                self.assertEqual(Path(listener.getsockname()), Path(temp) / NATIVE.CONTROL)
                raise FileNotFoundError('CANARY')
            with patch.object(TRIAL, 'native_build_handshake', side_effect=fail), self.assertRaises(FileNotFoundError):
                TRIAL.run_native_build(11 * TRIAL.GIB, report)
            self.assertEqual(report['native_build_exception'], 'missing_file')
            self.assertNotIn('CANARY', json.dumps(report))
            # Existing control endpoints are never overwritten/reused.
            with self.assertRaises(OSError):
                TRIAL.run_native_build(11 * TRIAL.GIB, {})
            self.assertEqual(start.call_count, 1)

    def cpu_overlay(self):
        # Inert provenance fixture; actual core hashes are checked separately.
        return dict(kind='q1_avx2_aligned_load_v1', original_path='ggml/src/ggml-cpu/arch/x86/quants.c',
                    original_sha256='1' * 64, effective_sha256='2' * 64,
                    patch_path='native-cpu/q1-aligned-load.patch', patch_sha256='3' * 64,
                    compiled_source='cpu-overlay/quants.c')

    def bundle_fixture(self, directory, constrained=False, session=False, aligned=False):
        session = session or aligned
        constrained = constrained or session
        base, core = Path(directory) / 'base', Path(directory) / 'core'
        build_root, backend = base / 'llama-build', base / 'ml/native-backend'
        wrappers = core / 'workers/volparossa-ml/native-cpu'
        for path in (build_root, backend, wrappers):
            path.mkdir(mode=0o700, parents=True)
        def artifact(path, content):
            path.write_bytes(content)
            return {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
        library = artifact(build_root / 'libvolparossa_llama_cpu.so', b'inert library bytes, never loaded')
        (backend / 'libvolparossa_llama_cpu.so').write_bytes((build_root / 'libvolparossa_llama_cpu.so').read_bytes())
        names = NATIVE.ALIGNED_WRAPPERS if aligned else (NATIVE.SESSION_WRAPPERS if session else (
            NATIVE.CONSTRAINED_WRAPPERS if constrained else NATIVE.LEGACY_WRAPPERS))
        wrapper = {name: artifact(wrappers / name, b'inert source ' + name.encode()) for name in names}
        raw_build = dict(version=4 if session else (3 if constrained else 2),
                         kind=KIND, source_commit=NATIVE.SOURCE, source_tree='b' * 40,
                         abi_version=1, jobs=2, cpu='avx2_fma_f16c', models_loaded=False, downloads=False,
                         install=False, sanitizers=False, provisionable=True, quantization=False,
                         library={'path': 'libvolparossa_llama_cpu.so', **library}, wrapper_sources=wrapper,
                         dynamic_dependencies=['libc.so.6'])
        if constrained:
            raw_build['output_constraints'] = [NATIVE.OUTPUT_CONSTRAINT]
        if session:
            raw_build['native_sessions'] = [NATIVE.NATIVE_SESSION]
        if aligned:
            raw_build.update(cpu_source_overlay=self.cpu_overlay(), cpu_compile_source_verified=True)
        for root in (build_root, backend):
            (root / 'build.json').write_text(json.dumps(raw_build))
        build_hash = hashlib.sha256((build_root / 'build.json').read_bytes()).hexdigest()
        gguf = artifact(backend / 'model.gguf', b'inert gguf bytes, never loaded')
        manifest = dict(version=3 if session else (2 if constrained else 1),
                        model_profile=NATIVE.MODEL, build_manifest_sha256=build_hash,
                        library=raw_build['library'], gguf={'path': 'model.gguf', **gguf}, source_weights_sha256='c' * 64)
        if constrained:
            manifest['output_constraints'] = [NATIVE.OUTPUT_CONSTRAINT]
        if session:
            manifest['native_sessions'] = [NATIVE.NATIVE_SESSION]
        (backend / 'backend.json').write_text(json.dumps(manifest))
        report = dict(native_cpu_converter={'implementation': KIND, 'dependencies': {'sentencepiece': '0.2.1'}},
                      native_backend={'kind': KIND, 'root': str(backend),
                                      'backend_sha256': hashlib.sha256((backend / 'backend.json').read_bytes()).hexdigest()})
        # Core parsers/builders have separate tests; these doubles exercise only
        # this fixture consumer's artifact/provenance checks, not model evidence.
        parser = SimpleNamespace(validate_manifest=Mock(), validate_build_provenance=Mock())
        builder = SimpleNamespace(SOURCE=NATIVE.SOURCE, ORIGIN=NATIVE.ORIGIN, KIND=KIND,
                                  ALLOWED_NEEDED={'libc.so.6'}, verify_source=lambda _path: 'b' * 40,
                                  native=parser, verify_loader_compilation=Mock(), verify_cpu_compilation=Mock())
        return base, core, report, builder, parser

    def test_exact_build_and_converted_manifest_bind_actual_inert_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, report, builder, parser = self.bundle_fixture(temp)
            with patch.object(NATIVE, 'module', return_value=builder):
                build = NATIVE.validate_build(core, base)
            parser.validate_build_provenance.assert_called_once_with(
                json.loads((base / 'llama-build/build.json').read_bytes()), NATIVE.require)
            builder.verify_loader_compilation.assert_called_once_with(
                base / 'llama-build', base / 'llama-build/loader-overlay/llama-model-loader.cpp')
            self.assertEqual(set(build), {'kind', 'source_commit', 'source_tree', 'build_manifest_sha256',
                                         'library', 'wrapper_sources', 'jobs', 'nice', 'cpu',
                                         'quantization', 'models_loaded'})
            with patch.object(NATIVE, 'module', return_value=parser):
                result = NATIVE.validate_provision(core, base, report, build)
                self.assertEqual(result['manifest_sha256'], report['native_backend']['backend_sha256'])
                self.assertEqual(set(result), {'kind', 'source_commit', 'manifest_sha256', 'build_manifest_sha256',
                                              'library_sha256', 'gguf_sha256', 'gguf_bytes', 'source_weights_sha256'})
                self.assertNotIn(str(base), json.dumps(result))
                for mutation in ({'native_cpu_converter': {}},
                                 {'native_backend': dict(report['native_backend'], root='/untrusted')},
                                 {'native_backend': dict(report['native_backend'], backend_sha256='0' * 64)}):
                    with self.assertRaises(ValueError):
                        NATIVE.validate_provision(core, base, dict(report, **mutation), build)
                (base / 'ml/native-backend/model.gguf').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'native_artifact_binding'):
                    NATIVE.validate_provision(core, base, report, build)
            (core / 'workers/volparossa-ml/native-cpu/adapter.cpp').write_bytes(b'changed')
            with patch.object(NATIVE, 'module', return_value=builder), self.assertRaisesRegex(ValueError, 'native_wrapper_binding'):
                NATIVE.validate_build(core, base)

    def test_constrained_build3_backend2_preserve_closed_provenance_and_require_capability(self):
        for selected in (False, True):
            with self.subTest(selected=selected), tempfile.TemporaryDirectory() as temp:
                base, core, report, builder, parser = self.bundle_fixture(temp, constrained=selected)
                with patch.object(NATIVE, 'module', return_value=builder):
                    build = NATIVE.validate_build(core, base)
                with patch.object(NATIVE, 'module', return_value=parser):
                    backend = NATIVE.validate_provision(core, base, report, build)
                # Historical artifacts remain readable, but this new actual
                # requires a separately verified owner-session capability.
                with self.assertRaisesRegex(ValueError, 'native_output_constraint_required'):
                    NATIVE.require_output_constraint(build, backend)
                self.assertNotIn('native_sessions', build)
                self.assertNotIn('native_sessions', backend)
                if selected:
                    self.assertEqual(build['build_version'], 3)
                    self.assertEqual(backend['build_version'], 3)
                    self.assertEqual(backend['backend_version'], 2)
                    self.assertEqual(build['output_constraints'], [NATIVE.OUTPUT_CONSTRAINT])
                    self.assertEqual(backend['output_constraints'], [NATIVE.OUTPUT_CONSTRAINT])
                    self.assertEqual(set(build['wrapper_sources']), set(NATIVE.CONSTRAINED_WRAPPERS))
                else:
                    self.assertNotIn('build_version', build)
                    self.assertNotIn('output_constraints', build)
                    self.assertNotIn('backend_version', backend)
                    self.assertEqual(set(build['wrapper_sources']), set(NATIVE.LEGACY_WRAPPERS))
                self.assertFalse(build['models_loaded'])
                self.assertNotIn('passed', backend)
                self.assertNotIn(str(base), json.dumps(backend))

    def test_session_build4_backend3_bind_seven_exact_sources_without_execution_claims(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, report, builder, parser = self.bundle_fixture(temp, session=True)
            with patch.object(NATIVE, 'module', return_value=builder):
                build = NATIVE.validate_build(core, base)
            with patch.object(NATIVE, 'module', return_value=parser):
                backend = NATIVE.validate_provision(core, base, report, build)
            with self.assertRaisesRegex(ValueError, 'native_cpu_correction_required'):
                NATIVE.require_output_constraint(build, backend)
            self.assertEqual((build['build_version'], backend['build_version'], backend['backend_version']),
                             (4, 4, 3))
            self.assertEqual(build['native_sessions'], [NATIVE.NATIVE_SESSION])
            self.assertEqual(backend['native_sessions'], [NATIVE.NATIVE_SESSION])
            self.assertEqual(set(build['wrapper_sources']), set(NATIVE.SESSION_WRAPPERS))
            self.assertEqual(set(NATIVE.SESSION_WRAPPERS) - set(NATIVE.CONSTRAINED_WRAPPERS),
                             {'session-state.h'})
            self.assertEqual(len(NATIVE.SESSION_WRAPPERS), 7)
            self.assertFalse(build['models_loaded'])
            self.assertEqual(build['jobs'], 2)
            for token in ('passed', 'child_reaped', 'session_closed', str(base)):
                self.assertNotIn(token, json.dumps(backend))

    def test_session_build_capability_or_source_substitution_is_rejected(self):
        for changes in ({'version': True}, {'version': 5}, {'version': 3},
                        {'native_sessions': None}, {'native_sessions': []},
                        {'native_sessions': ['unknown']},
                        {'native_sessions': [NATIVE.NATIVE_SESSION, NATIVE.NATIVE_SESSION]},
                        {'output_constraints': []}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, session=True)
                path = base / 'llama-build/build.json'
                path.write_text(json.dumps(json.loads(path.read_text()) | changes))
                with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises(ValueError):
                    NATIVE.validate_build(core, base)
        for mutation in ('missing', 'modified', 'unlisted', 'extra'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, session=True)
                path = core / 'workers/volparossa-ml/native-cpu/session-state.h'
                if mutation == 'missing':
                    path.unlink()
                elif mutation == 'modified':
                    path.write_bytes(b'PRIVATE-CANARY changed source')
                else:
                    manifest = base / 'llama-build/build.json'
                    value = json.loads(manifest.read_text())
                    if mutation == 'unlisted':
                        del value['wrapper_sources']['session-state.h']
                    else:
                        value['wrapper_sources']['private.c'] = value['wrapper_sources']['session-state.h']
                    manifest.write_text(json.dumps(value))
                with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises((OSError, ValueError)):
                    NATIVE.validate_build(core, base)

    def test_aligned_build_binds_eight_sources_and_closed_cpu_projections(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, report, builder, parser = self.bundle_fixture(temp, aligned=True)
            with patch.object(NATIVE, 'module', return_value=builder):
                build = NATIVE.validate_build(core, base)
            builder.verify_cpu_compilation.assert_called_once_with(base / 'llama-build', base / 'llama-source')
            with patch.object(NATIVE, 'module', return_value=parser):
                backend = NATIVE.validate_provision(core, base, report, build)
            NATIVE.require_output_constraint(build, backend)
            self.assertEqual(len(build['wrapper_sources']), 8)
            self.assertEqual(set(build['wrapper_sources']), set(NATIVE.ALIGNED_WRAPPERS))
            self.assertEqual(set(NATIVE.ALIGNED_WRAPPERS) - set(NATIVE.SESSION_WRAPPERS),
                             {'q1-aligned-load.patch'})
            for result in (build, backend):
                self.assertEqual(result['cpu_source_overlay'], self.cpu_overlay())
                self.assertIs(result['cpu_compile_source_verified'], True)
                self.assertNotIn('passed', result)
                self.assertNotIn(str(base), json.dumps(result))
            self.assertFalse(build['models_loaded'])

    def test_cpu_pair_cannot_be_partial_false_or_downgraded(self):
        mutations = [{'cpu_compile_source_verified': flag} for flag in (False, 1, None, 'true')]
        mutations += [{'cpu_source_overlay': None}, {'version': 3}, {'version': 2}]
        for changes in mutations + ['cpu_source_overlay', 'cpu_compile_source_verified', 'both']:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, aligned=True)
                path = base / 'llama-build/build.json'
                value = json.loads(path.read_text())
                if type(changes) is dict:
                    value.update(changes)
                else:
                    for key in NATIVE.CPU_FIELDS if changes == 'both' else (changes,):
                        del value[key]
                path.write_text(json.dumps(value))
                with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises(ValueError):
                    NATIVE.validate_build(core, base)
                builder.verify_cpu_compilation.assert_not_called()

    def test_cpu_patch_inventory_and_content_cannot_be_substituted(self):
        for mutation in ('missing', 'modified', 'unlisted', 'extra'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, aligned=True)
                patch_path = core / 'workers/volparossa-ml/native-cpu/q1-aligned-load.patch'
                if mutation == 'missing':
                    patch_path.unlink()
                elif mutation == 'modified':
                    patch_path.write_bytes(b'changed, never executed')
                else:
                    path = base / 'llama-build/build.json'
                    value = json.loads(path.read_text())
                    if mutation == 'unlisted':
                        del value['wrapper_sources']['q1-aligned-load.patch']
                    else:
                        value['wrapper_sources']['extra.patch'] = value['wrapper_sources']['q1-aligned-load.patch']
                    path.write_text(json.dumps(value))
                with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises((OSError, ValueError)):
                    NATIVE.validate_build(core, base)
                builder.verify_cpu_compilation.assert_not_called()

    def test_cpu_core_and_compilation_rejections_are_not_swallowed(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, _, builder, parser = self.bundle_fixture(temp, aligned=True)
            with patch.object(NATIVE, 'module', return_value=builder):
                parser.validate_build_provenance.side_effect = ValueError('CORE_CPU_REJECTED')
                with self.assertRaisesRegex(ValueError, 'CORE_CPU_REJECTED'):
                    NATIVE.validate_build(core, base)
                builder.verify_cpu_compilation.assert_not_called()
                parser.validate_build_provenance.side_effect = None
                builder.verify_cpu_compilation.side_effect = ValueError('CORE_CPU_COMPILE_REJECTED')
                with self.assertRaisesRegex(ValueError, 'CORE_CPU_COMPILE_REJECTED'):
                    NATIVE.validate_build(core, base)
                builder.verify_cpu_compilation.assert_called_once()

    def test_copied_cpu_provenance_must_match_the_verified_build(self):
        for mutation in ('missing', 'changed', 'false', 'copied_bytes'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                base, core, report, builder, parser = self.bundle_fixture(temp, aligned=True)
                with patch.object(NATIVE, 'module', return_value=builder):
                    build = NATIVE.validate_build(core, base)
                if mutation == 'missing':
                    del build['cpu_source_overlay']
                elif mutation == 'changed':
                    build['cpu_source_overlay']['effective_sha256'] = 'f' * 64
                elif mutation == 'false':
                    build['cpu_compile_source_verified'] = False
                else:
                    path = base / 'ml/native-backend/build.json'
                    path.write_bytes(path.read_bytes() + b' ')
                with patch.object(NATIVE, 'module', return_value=parser), \
                        self.assertRaisesRegex(ValueError, 'native_copied_build_(cpu|binding)'):
                    NATIVE.validate_provision(core, base, report, build)

    def test_trial_requires_matching_cpu_correction_on_both_projections(self):
        build = dict(build_version=4, output_constraints=[NATIVE.OUTPUT_CONSTRAINT],
                     native_sessions=[NATIVE.NATIVE_SESSION], cpu_source_overlay=self.cpu_overlay(),
                     cpu_compile_source_verified=True)
        backend = dict(build, backend_version=3)
        for side in ('build', 'backend'):
            for field, values in (('cpu_source_overlay', (None, {}, 'unknown', dict(self.cpu_overlay(),
                                             effective_sha256='f' * 64))),
                                  ('cpu_compile_source_verified', (None, False, 1, 'true'))):
                for value in values:
                    a, b = copy.deepcopy(build), copy.deepcopy(backend)
                    (a if side == 'build' else b)[field] = value
                    with self.subTest(side=side, field=field, value=value), \
                            self.assertRaisesRegex(ValueError, 'native_cpu_correction_required'):
                        NATIVE.require_output_constraint(a, b)
        for a, b in (({key: value for key, value in build.items() if key not in NATIVE.CPU_FIELDS},
                       {key: value for key, value in backend.items() if key not in NATIVE.CPU_FIELDS}),
                      (dict(build, cpu_source_overlay={'kind': 'unreviewed'}),
                       dict(backend, cpu_source_overlay={'kind': 'unreviewed'}))):
            with self.assertRaisesRegex(ValueError, 'native_cpu_correction_required'):
                NATIVE.require_output_constraint(a, b)

    def test_session_backend_rejects_missing_mixed_and_copied_capability(self):
        for changes in ({'version': True}, {'version': 4}, {'version': 2},
                        {'native_sessions': None}, {'native_sessions': []},
                        {'native_sessions': ['unknown']}, {'output_constraints': []}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temp:
                base, core, report, builder, parser = self.bundle_fixture(temp, session=True)
                with patch.object(NATIVE, 'module', return_value=builder):
                    build = NATIVE.validate_build(core, base)
                path = base / 'ml/native-backend/backend.json'
                path.write_text(json.dumps(json.loads(path.read_text()) | changes))
                report['native_backend']['backend_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                with patch.object(NATIVE, 'module', return_value=parser), self.assertRaises(ValueError):
                    NATIVE.validate_provision(core, base, report, build)
        for changes in ({'version': 3}, {'native_sessions': []}):
            with self.subTest(copied=changes), tempfile.TemporaryDirectory() as temp:
                base, core, report, builder, parser = self.bundle_fixture(temp, session=True)
                with patch.object(NATIVE, 'module', return_value=builder):
                    build = NATIVE.validate_build(core, base)
                copied = base / 'ml/native-backend/build.json'
                copied.write_text(json.dumps(json.loads(copied.read_text()) | changes))
                digest = hashlib.sha256(copied.read_bytes()).hexdigest()
                build['build_manifest_sha256'] = digest
                manifest = base / 'ml/native-backend/backend.json'
                manifest.write_text(json.dumps(json.loads(manifest.read_text()) | {'build_manifest_sha256': digest}))
                report['native_backend']['backend_sha256'] = hashlib.sha256(manifest.read_bytes()).hexdigest()
                with patch.object(NATIVE, 'module', return_value=parser), self.assertRaises(ValueError):
                    NATIVE.validate_provision(core, base, report, build)

    def test_legacy_versions_reject_unsolicited_session_capability(self):
        for constrained in (False, True):
            for target in ('build', 'manifest', 'projection'):
                with self.subTest(constrained=constrained, target=target), tempfile.TemporaryDirectory() as temp:
                    base, core, report, builder, parser = self.bundle_fixture(temp, constrained=constrained)
                    if target == 'build':
                        path = base / 'llama-build/build.json'
                        path.write_text(json.dumps(json.loads(path.read_text()) |
                                                   {'native_sessions': [NATIVE.NATIVE_SESSION]}))
                        with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises(ValueError):
                            NATIVE.validate_build(core, base)
                    else:
                        with patch.object(NATIVE, 'module', return_value=builder):
                            build = NATIVE.validate_build(core, base)
                        if target == 'manifest':
                            path = base / 'ml/native-backend/backend.json'
                            path.write_text(json.dumps(json.loads(path.read_text()) |
                                                       {'native_sessions': [NATIVE.NATIVE_SESSION]}))
                            report['native_backend']['backend_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                        else:
                            build['native_sessions'] = [NATIVE.NATIVE_SESSION]
                        with patch.object(NATIVE, 'module', return_value=parser), self.assertRaises(ValueError):
                            NATIVE.validate_provision(core, base, report, build)

    def test_current_trial_requires_exact_session_on_both_closed_projections(self):
        build = dict(build_version=4, output_constraints=[NATIVE.OUTPUT_CONSTRAINT],
                     native_sessions=[NATIVE.NATIVE_SESSION], cpu_source_overlay=self.cpu_overlay(),
                     cpu_compile_source_verified=True)
        backend = dict(build, backend_version=3)
        NATIVE.require_output_constraint(build, backend)
        for field in ('build_version', 'output_constraints', 'native_sessions'):
            for side in ('build', 'backend'):
                for value in (None, [], True, 'PRIVATE-CANARY'):
                    changed_build, changed_backend = copy.deepcopy(build), copy.deepcopy(backend)
                    (changed_build if side == 'build' else changed_backend)[field] = value
                    with self.subTest(field=field, side=side, value=value), \
                            self.assertRaisesRegex(ValueError, 'native_output_constraint_required'):
                        NATIVE.require_output_constraint(changed_build, changed_backend)
        for old in ({}, dict(backend, backend_version=2), dict(backend, build_version=3)):
            with self.assertRaisesRegex(ValueError, 'native_output_constraint_required'):
                NATIVE.require_output_constraint(build, old)

    def test_constrained_build_cannot_omit_substitute_or_downgrade_wrapper_capability(self):
        changes = ({'version': True}, {'version': 4}, {'version': 2}, {'output_constraints': None},
                   {'output_constraints': []}, {'output_constraints': ['unknown']},
                   {'output_constraints': [NATIVE.OUTPUT_CONSTRAINT, NATIVE.OUTPUT_CONSTRAINT]})
        for changed in changes:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, constrained=True)
                file = base / 'llama-build/build.json'
                value = json.loads(file.read_text()) | changed
                file.write_text(json.dumps(value))
                with patch.object(NATIVE, 'module', return_value=builder), self.assertRaises(ValueError):
                    NATIVE.validate_build(core, base)
        for name in ('output-constraint.h', 'output-constraint.cpp'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                base, core, _, builder, _ = self.bundle_fixture(temp, constrained=True)
                (core / 'workers/volparossa-ml/native-cpu' / name).write_bytes(b'changed source')
                with patch.object(NATIVE, 'module', return_value=builder), \
                        self.assertRaisesRegex(ValueError, 'native_wrapper_binding'):
                    NATIVE.validate_build(core, base)

    def test_constrained_manifest_and_current_trial_reject_missing_or_mixed_capability(self):
        for changes in ({'version': True}, {'version': 1}, {'version': 3}, {'output_constraints': None},
                        {'output_constraints': []}, {'output_constraints': ['unknown']}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temp:
                base, core, report, builder, parser = self.bundle_fixture(temp, constrained=True)
                with patch.object(NATIVE, 'module', return_value=builder):
                    build = NATIVE.validate_build(core, base)
                file = base / 'ml/native-backend/backend.json'
                file.write_text(json.dumps(json.loads(file.read_text()) | changes))
                report['native_backend']['backend_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
                with patch.object(NATIVE, 'module', return_value=parser), self.assertRaises(ValueError):
                    NATIVE.validate_provision(core, base, report, build)
        build = {'build_version': 3, 'output_constraints': [NATIVE.OUTPUT_CONSTRAINT]}
        backend = build | {'backend_version': 2}
        for old_build, old_backend in (({}, backend), (build, {}), (build | {'output_constraints': []}, backend),
                (build, backend | {'backend_version': 1}), (build, backend | {'output_constraints': None})):
            with self.subTest(build=old_build, backend=old_backend), \
                    self.assertRaisesRegex(ValueError, 'native_output_constraint_required'):
                NATIVE.require_output_constraint(old_build, old_backend)

    def test_core_provenance_and_loader_rejections_are_not_swallowed(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, _report, builder, parser = self.bundle_fixture(temp)
            with patch.object(NATIVE, 'module', return_value=builder):
                parser.validate_build_provenance.side_effect = ValueError('CORE_PATCH_REJECTED')
                with self.assertRaisesRegex(ValueError, 'CORE_PATCH_REJECTED'):
                    NATIVE.validate_build(core, base)
                builder.verify_loader_compilation.assert_not_called()
                parser.validate_build_provenance.side_effect = None
                builder.verify_loader_compilation.side_effect = ValueError('CORE_COMPILE_REJECTED')
                with self.assertRaisesRegex(ValueError, 'CORE_COMPILE_REJECTED'):
                    NATIVE.validate_build(core, base)

    def test_patch_and_copied_build_tampering_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, report, builder, parser = self.bundle_fixture(temp)
            with patch.object(NATIVE, 'module', return_value=builder):
                build = NATIVE.validate_build(core, base)
                (core / 'workers/volparossa-ml/native-cpu/bounded-tensor-validation.patch').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'native_wrapper_binding'):
                    NATIVE.validate_build(core, base)
            copied = base / 'ml/native-backend/build.json'
            original = copied.read_bytes()
            with patch.object(NATIVE, 'module', return_value=parser):
                copied.write_bytes(original + b' ')
                with self.assertRaisesRegex(ValueError, 'native_copied_build_binding'):
                    NATIVE.validate_provision(core, base, report, build)
                copied.write_bytes(original)
                parser.validate_build_provenance.side_effect = ValueError('CORE_COPIED_PATCH_REJECTED')
                with self.assertRaisesRegex(ValueError, 'CORE_COPIED_PATCH_REJECTED'):
                    NATIVE.validate_provision(core, base, report, build)

    def test_builder_import_uses_only_exact_sibling_and_restores_import_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sibling = root / 'llama_cpu.py'
            sibling.write_text('marker = "exact sibling"\n')
            builder = root / 'build_llama_cpu.py'
            builder.write_text('import llama_cpu as native\n')
            original_path = list(sys.path)
            for previous in (None, SimpleNamespace(marker='stale cached core')):
                with patch.dict(sys.modules):
                    if previous is None:
                        sys.modules.pop('llama_cpu', None)
                    else:
                        sys.modules['llama_cpu'] = previous
                    value = NATIVE.module(builder, 'inert_exact_core_builder')
                    self.assertEqual(value.native.marker, 'exact sibling')
                    self.assertEqual(Path(value.native.__file__), sibling)
                    self.assertIsNot(value.native, previous)
                    self.assertEqual(sys.path, original_path)
                    if previous is None:
                        self.assertNotIn('llama_cpu', sys.modules)
                    else:
                        self.assertIs(sys.modules['llama_cpu'], previous)
            # Failed imports must restore state too, without falling back to an
            # existing module when the actual sibling is missing or a symlink.
            stale = SimpleNamespace(marker='must never be selected')
            with patch.dict(sys.modules, {'llama_cpu': stale}):
                builder.write_text('import llama_cpu as native\nraise ValueError("inert import failed")\n')
                with self.assertRaisesRegex(ValueError, 'inert import failed'):
                    NATIVE.module(builder, 'inert_failed_core_builder')
                self.assertIs(sys.modules['llama_cpu'], stale)
                builder.write_text('native = None\n')
                with self.assertRaisesRegex(ValueError, 'native_builder_contract'):
                    NATIVE.module(builder, 'inert_rebound_core_builder')
                self.assertIs(sys.modules['llama_cpu'], stale)
                sibling.unlink()
                with self.assertRaises(OSError):
                    NATIVE.module(builder, 'inert_missing_core_builder')
                elsewhere = root / 'wrong_core.py'
                elsewhere.write_text('marker = "wrong core"\n')
                sibling.symlink_to(elsewhere)
                with self.assertRaisesRegex(ValueError, 'native_module_path'):
                    NATIVE.module(builder, 'inert_symlink_core_builder')
                self.assertIs(sys.modules['llama_cpu'], stale)
                self.assertEqual(sys.path, original_path)

    def actual_core_builder(self):
        core = Path(os.environ['VOLPAROSSA_NATIVE_CORE_TEST_SOURCE']).resolve(strict=True)
        self.assertEqual(subprocess.check_output(['git', '-C', str(core), 'rev-parse', 'HEAD'],
                                                text=True, timeout=10).strip(), TRIAL.NATIVE_CORE)
        for name in ('llama_cpu.py', 'build_llama_cpu.py'):
            relative = 'workers/volparossa-ml/' + name
            self.assertEqual((core / relative).read_bytes(), subprocess.check_output(
                ['git', '-C', str(core), 'show', TRIAL.NATIVE_CORE + ':' + relative], timeout=10))
        return NATIVE.module(core / 'workers/volparossa-ml/build_llama_cpu.py', 'actual_pinned_builder')

    @unittest.skipUnless(os.environ.get('VOLPAROSSA_NATIVE_CORE_TEST_SOURCE'),
                         'requires explicitly retained exact core source; never downloads')
    def test_actual_pinned_core_import_and_v2_provenance(self):
        core = Path(os.environ['VOLPAROSSA_NATIVE_CORE_TEST_SOURCE']).resolve(strict=True)
        stale = SimpleNamespace(marker='stale cached module')
        original_path = list(sys.path)
        with patch.dict(sys.modules, {'llama_cpu': stale}), patch('ctypes.CDLL') as library:
            builder = self.actual_core_builder()
            self.assertIs(sys.modules['llama_cpu'], stale)
            self.assertEqual(sys.path, original_path)
            self.assertEqual(Path(builder.native.__file__), core / 'workers/volparossa-ml/llama_cpu.py')
            native = builder.native
            value = dict(version=2, source_commit=native.SOURCE, source_tree=native.SOURCE_TREE,
                         source_overlay=native.loader_provenance(), loader_compile_source_verified=True,
                         upstream_original_unchanged=True)
            native.validate_build_provenance(value, NATIVE.require)
            for changes in ({'version': 1}, {'version': True}, {'source_tree': '0' * 40},
                            {'source_commit': '0' * 40}, {'source_overlay': {}},
                            {'loader_compile_source_verified': False}, {'upstream_original_unchanged': False}):
                with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'NATIVE_BUILD_PATCH_BINDING'):
                    native.validate_build_provenance(dict(value, **changes), NATIVE.require)
            for field in ('patch_sha256', 'effective_sha256', 'complete_tensor_validation',
                          'owner_poll_between_tensors', 'validation_execution_threads'):
                changed = copy.deepcopy(value)
                changed['source_overlay'][field] = None
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'NATIVE_BUILD_PATCH_BINDING'):
                    native.validate_build_provenance(changed, NATIVE.require)
            library.assert_not_called()

    @unittest.skipUnless(os.environ.get('VOLPAROSSA_NATIVE_CORE_TEST_SOURCE')
                         and os.environ.get('VOLPAROSSA_NATIVE_LOADER_TEST_SOURCE'),
                         'requires retained exact core and patched loader source; never builds')
    def test_actual_pinned_core_compile_source_proof_rejects_tampering(self):
        builder = self.actual_core_builder()
        retained = Path(os.environ['VOLPAROSSA_NATIVE_LOADER_TEST_SOURCE'])
        self.assertEqual(NATIVE.file_identity(retained, 1024 ** 2)['sha256'],
                         builder.native.LOADER_EFFECTIVE_SHA)
        raw = retained.read_bytes()
        with tempfile.TemporaryDirectory() as temp, patch('ctypes.CDLL') as library:
            output = Path(temp)
            (output / 'build').mkdir()
            (output / 'loader-overlay').mkdir()
            loader = output / 'loader-overlay/llama-model-loader.cpp'
            loader.write_bytes(raw)
            database = output / 'build/compile_commands.json'
            exact = {'file': str(loader)}
            database.write_text(json.dumps([exact]))
            builder.verify_loader_compilation(output, loader)
            for rows in ([exact, exact], [{'file': str(output / 'original/llama-model-loader.cpp')}],
                         [{'file': str(output / 'other.cpp')}]):
                database.write_text(json.dumps(rows))
                with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, 'NATIVE_COMPILED_LOADER'):
                    builder.verify_loader_compilation(output, loader)
            database.write_text(json.dumps([exact]))
            loader.write_bytes(raw + b'\n')
            with self.assertRaisesRegex(ValueError, 'NATIVE_COMPILED_LOADER'):
                builder.verify_loader_compilation(output, loader)
            library.assert_not_called()

    @unittest.skipUnless(os.environ.get('VOLPAROSSA_NATIVE_CORE_TEST_SOURCE'),
                         'requires explicitly retained exact core source; never builds')
    def test_actual_pinned_core_cpu_pair_and_compile_input_checks(self):
        with patch('ctypes.CDLL') as library:
            builder = self.actual_core_builder()
            native = builder.native
            value = dict(version=4, source_commit=native.SOURCE, source_tree=native.SOURCE_TREE,
                         source_overlay=native.loader_provenance(), loader_compile_source_verified=True,
                         upstream_original_unchanged=True, output_constraints=[native.OUTPUT_CONSTRAINT],
                         native_sessions=[native.NATIVE_SESSION], cpu_source_overlay=native.cpu_provenance(),
                         cpu_compile_source_verified=True)
            native.validate_build_provenance(value, NATIVE.require)
            for mutation in ('cpu_source_overlay', 'cpu_compile_source_verified', 'version', 'hash', 'extra'):
                changed = copy.deepcopy(value)
                if mutation in NATIVE.CPU_FIELDS:
                    del changed[mutation]
                elif mutation == 'version':
                    changed['version'] = 3
                    del changed['native_sessions']
                elif mutation == 'hash':
                    changed['cpu_source_overlay']['effective_sha256'] = '0' * 64
                else:
                    changed['cpu_source_overlay']['extra'] = True
                with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'NATIVE_CPU_PATCH_BINDING'):
                    native.validate_build_provenance(changed, NATIVE.require)
            # Exercise the exact core verifier on inert compiler metadata.
            # This is not a compiler execution or a real native-source receipt.
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                output, source = root / 'output', root / 'upstream'
                staged = output / 'cpu-overlay/quants.c'
                staged.parent.mkdir(parents=True)
                raw = b'inert CPU fixture; never compiled'
                staged.write_bytes(raw)
                database = output / 'build/compile_commands.json'
                database.parent.mkdir()
                row = dict(directory=str(database.parent), file=str(staged),
                           command='cc -o CMakeFiles/ggml-cpu.dir/fixture.o -c ' + str(staged))
                with patch.object(native, 'CPU_EFFECTIVE_SHA', hashlib.sha256(raw).hexdigest()):
                    database.write_text(json.dumps([row]))
                    builder.verify_cpu_compilation(output, source)
                    for changed in (dict(row, file=str(source / native.CPU_ORIGINAL_PATH)),
                                    dict(row, command='cc -o CMakeFiles/wrong.dir/x.o -c ' + str(staged)),
                                    dict(row, command='cc -o CMakeFiles/ggml-cpu.dir/x.o -c wrong.c')):
                        database.write_text(json.dumps([changed]))
                        with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'NATIVE_COMPILED_CPU'):
                            builder.verify_cpu_compilation(output, source)
            library.assert_not_called()


if __name__ == '__main__':
    unittest.main()
