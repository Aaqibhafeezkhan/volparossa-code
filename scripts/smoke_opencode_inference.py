#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""One explicit OpenCode/Qwen guest trial; no host model execution or installation.

pack captures the dirty Code candidate by exact file hash (never as a clean Git
revision). execute owns one explicitly selected KVM, its private SSH keys and teardown.
guest is rejected outside the disposable vpci Debian KVM. No Codex is launched.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CORE = '6a517b576baa17e7329661ee0476d1848081d114'
MODEL = 'qwen3-0.6b-v1'
GIB = 1024 ** 3
LARGE_MODEL = 'qwen3-4b-instruct-2507-v1'
# Both profiles require the reviewed terminal-budget IPC; model and budgets stay distinct.
LARGE_CORE = '6a517b576baa17e7329661ee0476d1848081d114'
MODEL_PROFILES = (MODEL, LARGE_MODEL)
INFERENCE_BACKENDS = ('torch', 'llama_cpp_bf16_v1')
# Native validation, output constraints and closed task diagnostics are source-bound.
NATIVE_CORE = '60a7386bd5dedf614a08be497b41963f842c9512'
NATIVE_SOURCE = '7fe450e19305b828c199d602c23a8337aaa1f03b'
OUTPUT_CONSTRAINT = 'qwen_tagged_tool_json_v1'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
IMAGE_NAME = 'debian-13-genericcloud-amd64-20260826-2582.qcow2'
IMAGE_SHA512 = '184761b0dad0f9ace02f9298050ca96ce3caa39a461a47706d47ff9698b59933918b91b40177fbd4d392f6446af8b4d18ecb94caca988169b19641606bf34003'
BASE = Path('/home/vpci/opencode-trial')
INPUT = Path('/home/vpci/opencode-input')
SOURCE = Path('/home/vpci/source')
PROJECTS = Path('/home/vpci/opencode-projects')
CORE_UNIT = 'volparossa-opencode-core.service'
TASK_UNIT = 'volparossa-opencode-task.service'
NATIVE_UNIT = 'volparossa-opencode-native-build.service'


def require(value, reason):
    if not value:
        raise ValueError(reason)


def trial_profile(model_profile=MODEL, inference_backend='torch'):
    """Closed source/resource choices; the larger trial never changes the default."""
    require(model_profile in MODEL_PROFILES, 'unknown_model_profile')
    require(inference_backend in INFERENCE_BACKENDS, 'unknown_inference_backend')
    if inference_backend != 'torch':
        require(model_profile == LARGE_MODEL, 'native_backend_requires_qwen4b')
        require(type(NATIVE_CORE) is str and re.fullmatch('[0-9a-f]{40}', NATIVE_CORE), 'native_core_not_pinned')
        return dict(trial_profile(model_profile), core_revision=NATIVE_CORE,
                    inference_backend=inference_backend, native_source_commit=NATIVE_SOURCE)
    if model_profile == MODEL:
        return dict(model_profile=MODEL, core_revision=CORE, guest_memory_mib=6144,
                    core_memory_bytes=5 * GIB, qemu_memory_bytes=7 * GIB,
                    host_available_bytes=8 * GIB, provision_budget_bytes=5 * GIB,
                    scratch_gib=18, memory_failure='host_available_memory_below_8GiB')
    require(type(LARGE_CORE) is str and re.fullmatch('[0-9a-f]{40}', LARGE_CORE),
            'larger_core_not_pinned')
    return dict(model_profile=LARGE_MODEL, core_revision=LARGE_CORE, guest_memory_mib=12288,
                core_memory_bytes=11 * GIB, qemu_memory_bytes=13 * GIB,
                host_available_bytes=14 * GIB, provision_budget_bytes=20 * GIB,
                scratch_gib=40, memory_failure='host_available_memory_below_14GiB')


def backend_fields(profile):
    return {key: profile[key] for key in ('inference_backend', 'native_source_commit') if key in profile}


def validate_backend_fields(value, profile):
    expected = backend_fields(profile)
    require({key: value[key] for key in ('inference_backend', 'native_source_commit') if key in value}
            == expected, 'input_backend')


def task_arguments(inference_backend='torch'):
    require(inference_backend in INFERENCE_BACKENDS, 'unknown_inference_backend')
    return [str(INPUT / 'runtime/node'), str(INPUT / 'code/scripts/smoke_opencode_inference.cjs'),
            '--execute', '--yes', '--node', str(INPUT / 'runtime/node'), '--build-report',
            str(INPUT / 'runtime/build-report.json'), '--socket', str(BASE / 'private.sock'),
            '--project-parent', str(PROJECTS), '--output', str(BASE / 'task.json'),
            *(['--output-constraint', OUTPUT_CONSTRAINT] if inference_backend != 'torch' else [])]


def validate_task_selection(task, profile, inference_backend='torch'):
    require(inference_backend in INFERENCE_BACKENDS, 'unknown_inference_backend')
    require(task['model_profile'] == profile['model_profile'], 'task_model_mismatch')
    require(type(task.get('version')) is int and task['version'] == (1 if inference_backend == 'torch' else 2)
            and (task.get('output_constraint') == OUTPUT_CONSTRAINT if inference_backend != 'torch'
                 else 'output_constraint' not in task), 'task_output_constraint_mismatch')


def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def run(argv, **kwargs):
    return subprocess.run([str(arg) for arg in argv], check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 60), **kwargs)


def record(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
    path.chmod(0o600)


def load(path, maximum=2 * 1024**2):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, 'report_bound')
    return json.loads(path.read_bytes())


def guest_receipt_limit(inference_backend='torch'):
    require(inference_backend in INFERENCE_BACKENDS, 'unknown_inference_backend')
    # The optional native diagnostic fits the existing public-export ceiling.
    # This changes no task input, model, execution or resource allowance.
    return 65536 if inference_backend == 'torch' else 256 * 1024


def closed_conversion(lines, log_state, process_status):
    """A diagnostic can report failure, never establish successful conversion."""
    value = dict(state='absent', stage='unknown', failure='unknown', child_exit_status=None)
    if log_state != 'present':
        value['state'] = 'absent' if log_state == 'absent' else 'invalid'
        return value
    prefix = b'NATIVE_CONVERSION_DIAGNOSTIC '
    rows = [line[len(prefix):] for line in lines if line.startswith(prefix)]
    if not rows:
        return value
    value['state'] = 'invalid'
    if len(rows) != 1 or len(rows[0]) > 1024 or lines.count(b'NATIVE_CONVERSION_FAILED') != 1 \
            or type(process_status) is not int or not -128 <= process_status <= 255 or process_status == 0:
        return value
    def unique(pairs):
        result = {}
        for key, item in pairs:
            require(key not in result, 'duplicate_conversion_field')
            result[key] = item
        return result
    try:
        row = json.loads(rows[0], object_pairs_hook=unique)
        stages = {'guard', 'source', 'runtime', 'model', 'build', 'budget', 'convert', 'tokenizer',
                  'verify', 'recheck', 'bundle', 'manifest', 'permissions', 'unknown'}
        failures = {'cancelled', 'timeout', 'missing_file', 'permission', 'memory', 'import', 'subprocess',
                    'os_error', 'invalid_shape', 'child_failed', 'disk_budget', 'contract', 'unknown'}
        require(type(row) is dict and set(row) == {'version', 'kind', 'stage', 'failure', 'child_exit_status'}
                and type(row['version']) is int and row['version'] == 1
                and row['kind'] == 'native-conversion-failure'
                and type(row['stage']) is str and row['stage'] in stages
                and type(row['failure']) is str and row['failure'] in failures
                and (row['child_exit_status'] is None or (type(row['child_exit_status']) is int
                     and -128 <= row['child_exit_status'] <= 255)), 'conversion_diagnostic_shape')
        require(row['failure'] != 'child_failed' or (type(row['child_exit_status']) is int
                and row['child_exit_status'] != 0), 'conversion_child_status')
        return dict(state='unknown' if 'unknown' in (row['stage'], row['failure']) else 'reported_failure',
                    **{key: row[key] for key in ('stage', 'failure', 'child_exit_status')})
    except (ValueError, TypeError, KeyError, UnicodeError):
        return value


def closed_provision(path, pins, stage, returncode, wait_timeout=False, native_cpu=False):
    """Bounded metadata only; progress means download starts, not verified assets."""
    stages = {'pins', 'launch', 'process', 'report', 'provenance', 'complete'}
    value = dict(version=1, stage=stage if stage in stages else 'unknown',
        process_status=returncode if type(returncode) is int and -128 <= returncode <= 255 else None,
        wait_timeout=wait_timeout is True, log_state='absent', progress_state='no_signal',
        download_starts=0, last_artifact_index=None, failure_class='unknown', http_status=None,
        wheel_graph_checked=False, runtime_import_checked=False)
    native_conversion_failed = False
    lines = []
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
                    'private_provision_log')
            raw = stream.read(131073)
        value['log_state'] = 'truncated' if len(raw) > 131072 else 'present'
        # A truncated prefix cannot establish the final error or a completed step.
        lines = raw[:131072].splitlines()
        if value['log_state'] == 'truncated':
            lines = lines[:-1]
        artifacts = pins['wheels'] + pins['files'] if pins is not None else []
        for line in lines:
            if line.startswith(b'{"downloading":'):
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    value['progress_state'] = 'invalid'
                    continue
                index = value['download_starts']
                if value['progress_state'] == 'invalid' or index >= len(artifacts) \
                        or set(row) != {'downloading', 'bytes'} or type(row['bytes']) is not int \
                        or row != {'downloading': artifacts[index]['path'], 'bytes': artifacts[index]['bytes']}:
                    value['progress_state'] = 'invalid'
                    continue
                value.update(progress_state='ordered', download_starts=index + 1, last_artifact_index=index)
            if value['log_state'] != 'present':
                continue
            native_conversion_failed |= native_cpu is True and line == b'NATIVE_CONVERSION_FAILED'
            value['wheel_graph_checked'] |= line == b'PINNED_WHEEL_GRAPH_OK'
            value['runtime_import_checked'] |= line == b'OFFLINE_CPU_RUNTIME_IMPORT_OK'
            prefix = b'Provisioning refused: '
            if not line.startswith(prefix):
                continue
            reason = line[len(prefix):]
            http = re.match(rb'HTTP Error ([1-5][0-9]{2}):', reason)
            value['http_status'] = int(http[1]) if http else None
            fixed = {
                b'budget cannot hold pinned downloads': 'download_budget',
                b'free disk space is below the explicit budget': 'free_disk_budget',
                b'verified wheel expansion exceeds explicit disk budget': 'wheel_expansion_budget',
                b'provisioning deadline expired': 'deadline',
                b'unapproved artifact URL/redirect': 'redirect_refused',
                b'download size header mismatch': 'download_length',
                b'truncated artifact': 'download_truncated',
                b'artifact exceeds pinned size': 'download_length',
                b'artifact SHA256 mismatch': 'download_hash',
                b'shard changed': 'shard_hash',
                b'shard file changed': 'shard_file',
                b'shard file grew': 'shard_file',
                b'sharded weights raw concatenation mismatch': 'aggregate_hash',
            }
            category = fixed.get(reason, 'other_refusal')
            for marker, label in ((b'HTTP Error ', 'http'), (b'<urlopen error ', 'network'),
                                  (b'[Errno 28]', 'disk_full'), (b'[Errno 13]', 'permission'),
                                  (b'[Errno 12]', 'memory')):
                if reason.startswith(marker):
                    category = label
            if reason in (b'timed out', b'The read operation timed out'):
                category = 'network_timeout'
            if reason.startswith(b'Command ') and b' returned non-zero exit status ' in reason:
                category = 'runtime_subprocess'
            value['failure_class'] = category
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, TypeError):
        value['log_state'] = 'invalid'
    if native_conversion_failed and value['log_state'] == 'present':
        value['failure_class'] = 'native_conversion'
    if native_cpu is True:
        value['native_conversion'] = closed_conversion(lines, value['log_state'], value['process_status'])
    return value


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def canonical(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical_input')
    return path


def new_output(path):
    require(path.is_absolute() and path.resolve() == path and not path.exists()
            and not path.is_symlink() and path.parent.is_dir()
            and path.is_relative_to(ROOT / 'build'), 'new_workspace_output')


def pack(args):
    profile = trial_profile(getattr(args, 'model_profile', MODEL), getattr(args, 'inference_backend', 'torch'))
    new_output(args.output)
    canonical(args.core)
    require(run(['git', '-C', args.core, 'rev-parse', 'HEAD'], text=True).stdout.strip()
            == profile['core_revision'], 'exact_core')
    report_path = ROOT / 'build/opencode-runtime/build-report.json'
    report = load(report_path, 65536)
    binary = canonical(Path(report['binary']))
    require(report['source_build'] is True and report['source_commit'] == 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
            and digest(binary) == report['binary_sha256'] and report['runtime_version'] == '1.18.34', 'exact_opencode')
    private = module(args.core / 'tests/integration/agent-private-conversation.py', 'opencode_private_inputs')
    node_pin = private.pins()['runtime']['files']['bin/node']
    canonical(args.node)
    require(args.node.stat().st_size == node_pin['bytes'] and digest(args.node) == node_pin['sha256'], 'exact_node')
    files = {f'code/{path.relative_to(ROOT)}': path for path in sorted((ROOT / 'src').glob('*.cjs'))}
    names = ['src/opencode-cooperative-tool.js', 'scripts/opencode_session.py', 'scripts/opencode_session.cjs',
             'scripts/smoke_opencode_inference.cjs', 'scripts/smoke_opencode_inference.py',
             'scripts/opencode_native_cpu.py',
             'third_party/opencode.json', 'third_party/opencode-LICENSE.txt',
             'third_party/opencode-build-tools.json', 'patches/opencode-no-runtime-installs.patch',
             'LICENSE', 'THIRD_PARTY_LICENSES.md']
    files.update({f'code/{name}': ROOT / name for name in names})
    files.update({'runtime/opencode': binary, 'runtime/build-report.json': report_path,
                  'runtime/node': args.node, 'runtime/node-LICENSE': args.node.parent.parent / 'LICENSE'})
    require(len(files) < 128, 'source_bound')
    inventory = {}
    with tempfile.TemporaryDirectory(prefix='opencode-pack-', dir=args.output.parent) as temp:
        archive = Path(temp) / 'core.tar'
        with archive.open('xb') as stream:
            subprocess.run(['git', '-C', str(args.core), 'archive', '--format=tar', profile['core_revision']],
                           stdout=stream, stderr=subprocess.PIPE, timeout=60, check=True)
        files['core.tar'] = archive
        for name, source in files.items():
            info = canonical(source).lstat()
            require(stat.S_ISREG(info.st_mode) and 0 < info.st_size < 200 * 1024**2, 'source_file')
            inventory[name] = {'bytes': info.st_size, 'sha256': digest(source),
                               'mode': 0o700 if name in ('runtime/opencode', 'runtime/node') else 0o600}
        manifest = dict(version=1, kind='opencode-inference-inputs', core_revision=profile['core_revision'],
            code_base_revision=run(['git', '-C', ROOT, 'rev-parse', 'HEAD'], text=True).stdout.strip(),
            code_contains_uncommitted_changes=True, code_git_head_proves_migration=False,
            node_version='24.19.0', model_profile=profile['model_profile'], opencode_revision=report['source_commit'],
            opencode_binary_sha256=report['binary_sha256'], files=inventory)
        manifest.update(backend_fields(profile))
        encoded = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        with tarfile.open(args.output, 'x:gz', compresslevel=1) as target:
            for name, source in files.items():
                row = inventory[name]
                require(digest(source) == row['sha256'], 'capture_changed')
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = row['bytes'], row['mode']
                with source.open('rb') as stream:
                    target.addfile(entry, stream)
            entry = tarfile.TarInfo('INPUTS.json')
            entry.size, entry.mode = len(encoded), 0o600
            target.addfile(entry, io.BytesIO(encoded))
        args.output.chmod(0o600)
    print(json.dumps({'packed': True, 'sha256': digest(args.output), 'bytes': args.output.stat().st_size,
                      'manifest_sha256': hashlib.sha256(encoded).hexdigest(), 'files': len(inventory),
                      'core_revision': profile['core_revision'], 'model_profile': profile['model_profile'],
                      'code_contains_uncommitted_changes': True}))


def staged_inputs(model_profile=MODEL, inference_backend='torch'):
    profile = trial_profile(model_profile, inference_backend)
    manifest = load(INPUT / 'INPUTS.json')
    validate_backend_fields(manifest, profile)
    require(manifest['core_revision'] == profile['core_revision'] and manifest['model_profile'] == model_profile
            and manifest['code_contains_uncommitted_changes'] is True
            and manifest['code_git_head_proves_migration'] is False, 'input_authority')
    for name, row in manifest['files'].items():
        parts = PurePosixPath(name)
        require(not parts.is_absolute() and '..' not in parts.parts and str(parts) == name, 'input_name')
        source = canonical(INPUT / name)
        info = source.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == row['mode'] and info.st_size == row['bytes']
                and digest(source) == row['sha256'], 'input_identity')
    return manifest


def unit(name, *args, check=True):
    require(name in (CORE_UNIT, TASK_UNIT, NATIVE_UNIT), 'unit_scope')
    return subprocess.run(['sudo', '-n', 'systemctl', *args, name], capture_output=True,
                          text=True, timeout=20, check=check)


def properties(name):
    result = unit(name, 'show', '--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus', check=False)
    require(len(result.stdout) < 8192, 'unit_properties')
    return dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)


def cgroup(name):
    require(name in (CORE_UNIT, TASK_UNIT, NATIVE_UNIT), 'cgroup_scope')
    return Path('/sys/fs/cgroup/system.slice') / name


def empty(name):
    group = cgroup(name)
    return not group.exists() or all(not p.read_text().strip() for p in group.rglob('cgroup.procs'))


def memory(name):
    group = cgroup(name)
    events = dict(row.split() for row in (group / 'memory.events').read_text().splitlines())
    return {**{key: int((group / field).read_text()) for key, field in
        [('maximum', 'memory.max'), ('swap', 'memory.swap.max'), ('peak', 'memory.peak')]},
        'oom_kill': int(events['oom_kill'])}


def closed_native_unit(state):
    code = state.get('ExecMainStatus', '')
    return dict(active=state.get('ActiveState') if state.get('ActiveState') in
                ('active', 'inactive', 'failed', 'activating', 'deactivating') else 'unknown',
                substate=state.get('SubState') if state.get('SubState') in
                ('running', 'exited', 'failed', 'dead', 'start', 'stop', 'stop-sigterm', 'stop-sigkill') else 'unknown',
                result=state.get('Result') if state.get('Result') in
                ('success', 'exit-code', 'signal', 'core-dump', 'oom-kill', 'timeout', 'resources') else 'unknown',
                status=int(code) if re.fullmatch('[0-9]{1,3}', code) and int(code) <= 255 else None)


def closed_native_exception(error):
    if isinstance(error, FileNotFoundError):
        return 'missing_file'
    if isinstance(error, PermissionError):
        return 'permission'
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        return 'timeout'
    if isinstance(error, OSError):
        return 'os_error'
    if isinstance(error, subprocess.SubprocessError):
        return 'subprocess_error'
    if isinstance(error, ValueError):
        return 'deadline' if str(error) == 'native_deadline' else 'contract'
    return 'invalid_shape'


def native_memory(limit):
    value = memory(NATIVE_UNIT)
    group = cgroup(NATIVE_UNIT)
    events = dict(row.split() for row in (group / 'memory.events').read_text().splitlines())
    value.update(swap_current=int((group / 'memory.swap.current').read_text()), oom=int(events['oom']))
    require(value['maximum'] == limit and 0 < value['peak'] <= limit
            and value['swap'] == value['swap_current'] == value['oom'] == value['oom_kill'] == 0,
            'native_build_resource_violation')
    return value


def native_helper_state(report):
    state = properties(NATIVE_UNIT)
    report['native_build_unit'] = closed_native_unit(state)
    return state


def native_helper_live(state, expected_pid=None):
    raw = state.get('MainPID', '')
    require(state.get('ActiveState') == 'active' and state.get('SubState') == 'running'
            and re.fullmatch('[0-9]{1,10}', raw) and 1 < int(raw) < 2 ** 31,
            'native_helper_not_running')
    pid = int(raw)
    require(expected_pid is None or pid == expected_pid, 'native_helper_changed')
    group = cgroup(NATIVE_UNIT)
    require(group.is_dir(), 'native_cgroup_missing')
    files = []
    for path in group.rglob('cgroup.procs'):
        require(len(files) < 16, 'native_cgroup_shape')
        files.append(path)
    require(files and group / 'cgroup.procs' in files, 'native_cgroup_shape')
    processes = []
    for path in files:
        with path.open('rb') as stream:
            raw = stream.read(4097)
        require(len(raw) <= 4096 and all(re.fullmatch(rb'[0-9]{1,10}', row) for row in raw.splitlines()),
                'native_cgroup_shape')
        processes.extend(int(row) for row in raw.splitlines())
    require(processes == [pid], 'native_build_descendants')
    return pid


def native_build_handshake(native, listener, nonce, deadline, limit, report):
    report['native_build_stage'] = 'ready'
    while True:
        listener.settimeout(min(.2, native.remaining(deadline)))
        try:
            channel, _ = listener.accept()
            break
        except TimeoutError:
            state = native_helper_state(report)
            require(state.get('ActiveState') == 'active' and state.get('SubState') == 'running',
                    'native_build_ended_before_ready')
    with channel:
        helper_pid = native_helper_live(native_helper_state(report))
        native.peer(channel, helper_pid)
        raw = native.receive_frame(channel, deadline)
        report['native_build_stage'] = 'provenance'
        build = native.validate_build(SOURCE, BASE)
        require(raw == native.binding('ready', nonce, build['build_manifest_sha256']), 'native_handshake_binding')
        native.remaining(deadline)
        report['native_build_stage'] = 'resources'
        native_helper_live(native_helper_state(report), helper_pid)
        measured = native_memory(limit)
        native_helper_live(native_helper_state(report), helper_pid)
        report['native_build_memory'] = measured
        report['native_build_stage'] = 'release'
        native.send_frame(channel, native.binding('release', nonce, build['build_manifest_sha256']), deadline)
    report['native_build_stage'] = 'exit'
    while True:
        native.remaining(deadline)
        state = native_helper_state(report)
        if state.get('SubState') == 'exited' or state.get('ActiveState') in ('failed', 'inactive'):
            break
        time.sleep(min(.1, native.remaining(deadline)))
    require(state.get('SubState') == 'exited' and state.get('Result') == 'success'
            and state.get('ExecMainStatus') == '0' and empty(NATIVE_UNIT), 'native_build_failed')
    native.remaining(deadline)
    report['native_build_stage'] = 'complete'
    return build


def run_native_build(limit, report):
    native = module(INPUT / 'code/scripts/opencode_native_cpu.py', 'opencode_native_inputs')
    nonce, deadline = os.urandom(32).hex(), time.monotonic_ns() + 1800 * 1_000_000_000
    path = BASE / native.CONTROL
    report['native_build_stage'] = 'launch'
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))  # Existing socket/path is a failure, never replaced.
            path.chmod(0o600)
            listener.listen(1)
            start(NATIVE_UNIT, [sys.executable, '-B', str(INPUT / 'code/scripts/opencode_native_cpu.py'),
                  '--execute', '--deadline-monotonic-ns', str(deadline), '--handshake-nonce', nonce,
                  '--parent-pid', str(os.getpid())], limit, 1800, public_source_build=True)
            return native_build_handshake(native, listener, nonce, deadline, limit, report)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        report['native_build_exception'] = closed_native_exception(error)
        raise
    # The private socket remains inside BASE until the existing joined cleanup;
    # no temporary handshake path can escape or weaken the all-units-empty gate.


def start(name, command, limit, seconds, public_source_build=False):
    require(not public_source_build or name == NATIVE_UNIT, 'native_build_network_scope')
    (BASE / (name + '.log')).touch(mode=0o600)
    run(['sudo', '-n', 'systemd-run', '--quiet', '--unit=' + name, '--property=Type=exec',
         '--property=RemainAfterExit=yes', '--property=User=vpci', '--property=Group=vpci',
         '--property=WorkingDirectory=/home/vpci/source', '--property=MemoryMax=' + str(limit),
         '--property=MemorySwapMax=0', '--property=TasksMax=256', '--property=KillMode=control-group',
         '--property=RuntimeMaxSec=' + str(seconds), '--property=TimeoutStopSec=15',
         '--property=NoNewPrivileges=yes', '--property=PrivateNetwork=' + ('no' if public_source_build else 'yes'),
         '--property=StandardOutput=append:' + str(BASE / (name + '.log')),
         '--property=StandardError=append:' + str(BASE / (name + '.log')),
         '--setenv=RUST_LOG=off,volparossa::compute::private_diagnostic=debug', '--setenv=NO_COLOR=1', *command])


def guest(args):
    backend = getattr(args, 'inference_backend', 'torch')
    profile = trial_profile(getattr(args, 'model_profile', MODEL), backend)
    os.umask(0o077)
    require(os.getuid() > 0 and pwd.getpwuid(os.getuid()).pw_name == 'vpci'
            and socket.gethostname() == 'volparossa-alpha'
            and run(['systemd-detect-virt', '--vm'], text=True).stdout.strip() == 'kvm'
            and 'VERSION_ID="13"' in Path('/etc/os-release').read_text(), 'disposable_guest_required')
    require(not BASE.exists() and not PROJECTS.exists() and not SOURCE.exists(), 'fresh_guest')
    manifest = staged_inputs(profile['model_profile'], backend)
    output = Path('/home/vpci/opencode-result.json')
    require(not output.exists(), 'fresh_receipt')
    BASE.mkdir(mode=0o700)
    PROJECTS.mkdir(mode=0o700)
    SOURCE.mkdir(mode=0o700)
    # Core archive is the exact git archive independently bound by INPUTS.json.
    with tarfile.open(INPUT / 'core.tar') as source:
        source.extractall(SOURCE, filter='data')
    private = module(SOURCE / 'tests/integration/agent-private-conversation.py', 'opencode_private')
    train = private.TRAIN
    before, provision, created = None, None, []
    provision_stage, provision_pins, provision_wait_timeout = None, None, False
    report = dict(version=1, kind='opencode-real-inference-guest', passed=False, phase='packages',
        failure=None, core_revision=profile['core_revision'], input_manifest_sha256=digest(INPUT / 'INPUTS.json'),
        code_contains_uncommitted_changes=True, model_profile=profile['model_profile'], actual_model_provisioned=False,
        private_peer_execution_proven=False, confidential_remote_execution_proven=False,
        raw_model_output_exported=False, host_state_unchanged=None, units_empty=False, private_data_removed=False)
    report.update(backend_fields(profile))
    try:
        for name in (CORE_UNIT, TASK_UNIT):
            require(properties(name).get('LoadState') == 'not-found', 'existing_unit')
        for argv in (['apt-get', 'update'], ['apt-get', 'install', '--yes', '--no-install-recommends',
            'build-essential', 'ca-certificates', 'cargo', 'cmake', 'git', 'iproute2', 'nftables',
            'pkg-config', 'python3-venv', 'rustc', 'bubblewrap', 'util-linux', 'libssl3t64']):
            with (BASE / 'packages.log').open('ab') as log:
                subprocess.run(['sudo', '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', *argv],
                               stdout=log, stderr=log, check=True, timeout=600)
        before = train['snapshot']()
        report['phase'] = 'core-build'
        build_env = dict(ENV, CARGO_TARGET_DIR='/home/vpci/target', CARGO_BUILD_JOBS='2',
                         CARGO_PROFILE_DEV_DEBUG='0', CARGO_INCREMENTAL='0')
        with (BASE / 'core-build.log').open('xb') as log:
            subprocess.run(['/usr/bin/cargo', 'build', '--locked', '-p', 'volparossa', '--bin', 'volparossa'],
                           cwd=SOURCE, env=build_env, stdout=log, stderr=log, timeout=1200, check=True)
        report['core_binary_sha256'] = digest(private.CLI)
        if backend != 'torch':
            report['phase'] = 'native-source-build'
            require(properties(NATIVE_UNIT).get('LoadState') == 'not-found', 'existing_unit')
            created.append(NATIVE_UNIT)
            report['native_build'] = run_native_build(profile['core_memory_bytes'], report)
        report['phase'] = 'model-provision'
        provision_stage = 'pins'
        model = module(private.ML / 'provision.py', 'opencode_model_provision')
        provision_pins = (model.load_pins(profile['model_profile'], native_cpu_converter=True)
                          if backend != 'torch' else model.load_pins(profile['model_profile']))
        provision_stage = 'launch'
        with (BASE / 'provision.log').open('xb') as log:
            provision = subprocess.Popen([sys.executable, '-B', str(private.ML / 'provision.py'),
                '--execute', '--yes', '--disposable-guest', '--model-profile', profile['model_profile'],
                '--root', str(BASE / 'ml'), '--budget-bytes', str(profile['provision_budget_bytes']),
                *(['--native-cpu-source', str(BASE / 'llama-source'), '--native-cpu-build', str(BASE / 'llama-build')]
                  if backend != 'torch' else [])],
                stdout=log, stderr=log, start_new_session=True, env=ENV)
            provision_stage = 'process'
            try:
                require(provision.wait(timeout=1850) == 0, 'provision_failed')
            except subprocess.TimeoutExpired:
                provision_wait_timeout = True
                raise
        provision_stage = 'report'
        observed = load(BASE / 'ml/provision-report.json')
        provision_stage = 'provenance'
        pins = provision_pins
        retained, lock = model.retained_pin_files(pins)
        expected = dict(model_id=pins['model_id'], revision=pins['revision'], model_profile=profile['model_profile'],
            download_bytes=model.download_total(pins), budget_bytes=profile['provision_budget_bytes'], installed_wheels=len(pins['wheels']),
            model_pins_sha256=hashlib.sha256(retained).hexdigest(), requirements_sha256=hashlib.sha256(lock).hexdigest())
        require(observed['success'] is True and observed['training_performed'] is False
                and observed['runtime_autofetch_enabled'] is False
                and {key: observed[key] for key in expected} == expected, 'model_provenance')
        report['actual_model_provisioned'], report['model_provision'] = True, expected
        if backend != 'torch':
            native = module(INPUT / 'code/scripts/opencode_native_cpu.py', 'opencode_native_provision')
            report['native_backend'] = native.validate_provision(SOURCE, BASE, observed, report['native_build'])
            native.require_output_constraint(report['native_build'], report['native_backend'])
        provision_stage = 'complete'
        report['phase'] = 'core-start'
        (BASE / 'work').mkdir(mode=0o700)
        created.append(CORE_UNIT)
        start(CORE_UNIT, [str(private.CLI), 'compute', 'private-serve', '--socket', str(BASE / 'private.sock'),
            '--work-parent', str(BASE / 'work'), '--runtime-root', str(BASE / 'ml/venv'),
            '--model-root', str(BASE / 'ml/model'), '--model-profile', profile['model_profile'],
            '--threads', '2', '--max-seconds', '600', '--execute',
            *(['--native-backend-root', str(BASE / 'ml/native-backend'), '--native-backend-sha256',
               report['native_backend']['manifest_sha256']] if backend != 'torch' else [])], profile['core_memory_bytes'], 2700)
        deadline = time.monotonic() + 15
        while not (BASE / 'private.sock').exists() and time.monotonic() < deadline:
            time.sleep(.1)
        state = properties(CORE_UNIT)
        require(state.get('ActiveState') == 'active' and (BASE / 'private.sock').is_socket(), 'core_not_ready')
        require(int(state['MainPID']) > 0, 'core_process')
        report['phase'] = 'opencode-task'
        created.append(TASK_UNIT)
        start(TASK_UNIT, task_arguments(backend), 768 * 1024**2, 2550)
        deadline = time.monotonic() + 2565
        while time.monotonic() < deadline:
            state = properties(TASK_UNIT)
            if state.get('SubState') == 'exited' or state.get('ActiveState') in ('failed', 'inactive'):
                break
            time.sleep(2)
        report['task_unit_result'] = state.get('Result') if state.get('Result') in (
            'success', 'exit-code', 'signal', 'timeout', 'oom-kill', 'resources') else 'other'
        report['task_exit_status'] = int(state.get('ExecMainStatus', '-1'))
        if (BASE / 'task.json').exists():
            report['task'] = load(BASE / 'task.json', 32768)
            validate_task_selection(report['task'], profile, backend)
        for name, field in ((CORE_UNIT, 'core_memory'), (TASK_UNIT, 'task_memory')):
            report[field] = memory(name)
            require(report[field]['swap'] == report[field]['oom_kill'] == 0, 'resource_violation')
        report['core_diagnostics'] = private.service_diagnostic(
            BASE / (CORE_UNIT + '.log'), **({'memory_enabled': True} if backend != 'torch' else {}))
        require(report['task_exit_status'] == 0 and report.get('task', {}).get('passed') is True, 'task_failed')
        require(empty(TASK_UNIT) and not list((BASE / 'work').iterdir()), 'task_private_cleanup')
        require(staged_inputs(profile['model_profile'], backend) == manifest, 'staged_inputs_changed')
        report['inputs_unchanged'] = True
        report['phase'] = 'core-stop'
        unit(CORE_UNIT, 'kill', '--kill-whom=main', '--signal=SIGINT')
        for _ in range(100):
            state = properties(CORE_UNIT)
            if state.get('MainPID') == '0':
                break
            time.sleep(.1)
        require(state.get('SubState') == 'exited' and state.get('Result') == 'success'
                and state.get('ExecMainStatus') == '0' and empty(CORE_UNIT)
                and not (BASE / 'private.sock').exists(), 'core_clean_stop')
        report['core_clean_stop'] = True
        report['phase'] = 'complete'
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        report['failure'] = 'stage_failed'
    finally:
        report['provision_group_joined'] = private.stop_client(provision)
        if provision_stage is not None:
            report['model_provision_diagnostic'] = closed_provision(BASE / 'provision.log', provision_pins,
                provision_stage, provision.returncode if provision is not None else None, provision_wait_timeout,
                native_cpu=backend != 'torch')
        # The original worker monitor owns descendants; stopping the complete
        # cgroup joins nested native/model processes, not just their leaders.
        for name in reversed(created):
            if cgroup(name).exists():
                try:
                    report['core_memory' if name == CORE_UNIT else
                           'native_build_memory' if name == NATIVE_UNIT else 'task_memory'] = (
                               native_memory(profile['core_memory_bytes']) if name == NATIVE_UNIT else memory(name))
                except (OSError, ValueError, KeyError):
                    report['failure'] = 'resource_observation_failed'
            unit(name, 'stop', check=False)
        if (BASE / (CORE_UNIT + '.log')).exists():
            try:
                report['core_diagnostics'] = private.service_diagnostic(
                    BASE / (CORE_UNIT + '.log'), **({'memory_enabled': True} if backend != 'torch' else {}))
            except (OSError, ValueError, KeyError):
                report['failure'] = 'closed_diagnostic_failed'
        report['units_empty'] = all(empty(name) for name in created)
        if before is not None:
            after = train['snapshot']()
            report['host_state_unchanged'] = before == after
        if report['units_empty'] and report['provision_group_joined']:
            shutil.rmtree(BASE)
            shutil.rmtree(PROJECTS)
            report['private_data_removed'] = not BASE.exists() and not PROJECTS.exists()
        report['passed'] = report['phase'] == 'complete' and report['failure'] is None \
            and report['units_empty'] and report['provision_group_joined'] \
            and report['private_data_removed'] and report['host_state_unchanged'] is True
        record(output, report)
    return 0 if report['passed'] else 1


def ipv6_route_configuration(raw):
    """Strict proc-visible route multiset, excluding only the kernel refcount.

    Linux v6.12 net/ipv6/ip6_fib.c:ipv6_route_native_seq_show emits fib6_ref
    at zero-based column 6. Column 7 is currently zero; retain it unchanged.
    https://github.com/torvalds/linux/blob/v6.12/net/ipv6/ip6_fib.c#L2395-L2423
    """
    require(len(raw) <= 4 * 1024**2 and (not raw or raw.endswith(b'\n')), 'ipv6_route_format')
    rows = raw.splitlines()
    require(len(rows) <= 16384, 'ipv6_route_format')
    projected = []
    for row in rows:
        fields = row.split()
        require(len(fields) == 10
                and all(re.fullmatch(rb'[0-9a-f]{32}', fields[i]) for i in (0, 2, 4))
                and all(re.fullmatch(rb'[0-9a-f]{2}', fields[i])
                        and int(fields[i], 16) <= 128 for i in (1, 3))
                and all(re.fullmatch(rb'[0-9a-f]{8}', fields[i]) for i in (5, 6, 7, 8))
                and re.fullmatch(rb'[^\x00-\x20/\x7f-\xff]{1,15}', fields[9]), 'ipv6_route_format')
        projected.append(b' '.join(fields[:6] + fields[7:]))
    # Sort a list, not a set: losing or adding an identical route still differs.
    canonical = b''.join(row + b'\n' for row in sorted(projected))
    return dict(format='linux-proc-ipv6-route-v1', excluded_columns=[6], rows=len(rows),
                sha256=hashlib.sha256(canonical).hexdigest())


def host_state():
    # This is not a full route/rule/firewall inventory. No host mutation occurs.
    with Path('/proc/net/ipv6_route').open('rb') as stream:
        ipv6 = stream.read(4 * 1024**2 + 1)
    configuration = ipv6_route_configuration(ipv6)
    return dict(version=2, scope='proc_visible_routes_and_resolv_conf',
        raw_sha256={'/proc/net/route': digest(Path('/proc/net/route')),
                    '/proc/net/ipv6_route': hashlib.sha256(ipv6).hexdigest(),
                    '/etc/resolv.conf': digest(Path('/etc/resolv.conf'))}, ipv6_routes=configuration)


def same_host_configuration(before, after):
    require(before['version'] == after['version'] == 2
            and before['scope'] == after['scope'] == 'proc_visible_routes_and_resolv_conf',
            'host_state_format')
    return before['ipv6_routes'] == after['ipv6_routes'] and all(
        before['raw_sha256'][name] == after['raw_sha256'][name]
        for name in ('/proc/net/route', '/etc/resolv.conf'))


def available_memory():
    values = dict(row.split(':', 1) for row in Path('/proc/meminfo').read_text().splitlines())
    # Admission must fit both currently available RAM and total physical RAM.
    return min(int(values[key].split()[0]) for key in ('MemAvailable', 'MemTotal')) * 1024


def closed_exception(error):
    classes = {'OSError', 'PermissionError', 'FileNotFoundError', 'ValueError', 'KeyError', 'TypeError',
               'InterruptedError', 'CalledProcessError', 'TimeoutExpired'}
    reason = error.args[0] if error.args and type(error.args[0]) is str else None
    reasons = {'host_available_memory_below_8GiB', 'host_available_memory_below_14GiB',
               'another_vm_is_running', 'qemu_start', 'qemu_cgroup',
               'qemu_resource_limits', 'qemu_exited', 'guest_boot_deadline', 'guest_bundle_hash',
               'guest_trial_failed', 'user_unit_observation'}
    return {'class': type(error).__name__ if type(error).__name__ in classes else 'other',
            'reason': reason if reason in reasons else 'unclassified',
            'subprocess_status': error.returncode if isinstance(error, subprocess.CalledProcessError) else None}


def closed_qemu(state, stderr):
    """Fixed metadata only; neither paths nor raw stderr are an exported diagnostic."""
    classifications = [
        ('missing_library', (b'error while loading shared libraries',)),
        ('missing_firmware', (b'could not load PC BIOS', b'could not find ROM image', b'Could not open option rom')),
        ('missing_module', (b'failed to initialize module', b'failed to load module')),
        ('kvm_unavailable', (b'Could not access KVM', b'failed to initialize kvm', b'KVM is not supported')),
        ('port_in_use', (b'Could not set up host forwarding rule', b'Address already in use')),
        ('memory_allocation', (b'Cannot allocate memory', b'cannot set up guest memory')),
        ('disk_open', (b'Could not open backing file', b'Could not open ', b'Failed to get "write" lock')),
        ('sandbox', (b'failed to install seccomp', b'failed to create seccomp', b'Seccomp')),
        ('missing_file', (b'No such file or directory',)),
        ('permission_denied', (b'Permission denied',)),
    ]
    category = next((name for name, needles in classifications if any(word in stderr for word in needles)),
                    'empty' if not stderr else 'other')
    code, status = state.get('ExecMainCode', ''), state.get('ExecMainStatus', '')
    number = int(status) if re.fullmatch('[0-9]{1,3}', status) else None
    return {'active': state.get('ActiveState') if state.get('ActiveState') in ('active', 'inactive', 'failed', 'activating', 'deactivating') else 'unknown',
            'result': state.get('Result') if state.get('Result') in ('success', 'exit-code', 'signal', 'core-dump', 'oom-kill', 'timeout', 'resources') else 'unknown',
            'exit_code': number if code == '1' else None, 'signal': number if code in ('2', '3') else None,
            'stderr_class': category, 'stderr_bytes_observed': len(stderr), 'stderr_truncated': len(stderr) > 65536}


def boot_running(state):
    return state.get('ActiveState') == 'active' and str(state.get('MainPID', '')).isdigit() \
        and int(state['MainPID']) > 0


def qemu_command(tools, scratch, firmware=None, model_profile=MODEL, inference_backend='torch'):
    profile = trial_profile(model_profile, inference_backend)
    firmware = firmware or tools / 'root/usr/share/seabios/vgabios-stdvga.bin'
    return [tools / 'bin/qemu-system-x86_64', '-name', 'volparossa-opencode-inference', '-no-user-config', '-nodefaults',
        '-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '2', '-m', str(profile['guest_memory_mib']),
        '-device', 'VGA,id=video0,bus=pcie.0,addr=0x1,romfile=' + str(firmware),
        '-drive', 'if=virtio,format=qcow2,file=' + str(scratch / 'overlay.qcow2'),
        '-drive', 'if=virtio,format=raw,readonly=on,file=' + str(scratch / 'seed.img'),
        '-device', 'virtio-rng-pci', '-device', 'virtio-net-pci,netdev=net0',
        '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:22223-:22', '-display', 'none', '-monitor', 'none',
        '-serial', 'file:' + str(scratch / 'console.log'), '-no-reboot',
        '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny']


def validate_bundle(path, model_profile=MODEL, inference_backend='torch'):
    profile = trial_profile(model_profile, inference_backend)
    canonical(path)
    require(path.stat().st_size < 512 * 1024**2, 'bundle_bound')
    with tarfile.open(path) as archive:
        rows = archive.getmembers()
        require(len(rows) <= 128 and all(row.isfile() for row in rows), 'bundle_files')
        names = [row.name for row in rows]
        require(len(names) == len(set(names)) and names.count('INPUTS.json') == 1, 'bundle_names')
        for name in names:
            parts = PurePosixPath(name)
            require(not parts.is_absolute() and '..' not in parts.parts and str(parts) == name, 'bundle_path')
        manifest_entry = archive.getmember('INPUTS.json')
        require(manifest_entry.size <= 2 * 1024**2, 'manifest_bound')
        manifest = json.load(archive.extractfile(manifest_entry))
        validate_backend_fields(manifest, profile)
        require(manifest['core_revision'] == profile['core_revision'] and manifest['model_profile'] == model_profile
                and manifest['code_contains_uncommitted_changes'] is True
                and manifest['code_git_head_proves_migration'] is False
                and set(manifest['files']) == set(names) - {'INPUTS.json'}, 'bundle_authority')
        for name, pin in manifest['files'].items():
            row = archive.getmember(name)
            require(row.size == pin['bytes'] and row.mode == pin['mode']
                    and row.size <= 200 * 1024**2, 'bundle_file')
            with archive.extractfile(row) as stream:
                require(hashlib.file_digest(stream, 'sha256').hexdigest() == pin['sha256'], 'bundle_hash')
    return manifest


def execute(args):
    backend = getattr(args, 'inference_backend', 'torch')
    profile = trial_profile(getattr(args, 'model_profile', MODEL), backend)
    os.umask(0o077)
    require(args.yes and os.getuid() > 0, 'explicit_unprivileged_execution')
    new_output(args.output)
    require(available_memory() >= profile['host_available_bytes'], profile['memory_failure'])
    require(os.access('/dev/kvm', os.R_OK | os.W_OK), 'host_kvm_unavailable')
    canonical(args.image)
    require(args.image.name == IMAGE_NAME and digest(args.image, 'sha512') == IMAGE_SHA512, 'image_pin')
    canonical(args.core)
    require(run(['git', '-C', args.core, 'rev-parse', 'HEAD'], text=True).stdout.strip()
            == profile['core_revision'], 'core_revision')
    tools_profile = getattr(args, 'host_tools_profile', 'workspace-debian')
    if tools_profile == 'github-ubuntu-24.04':
        ci = module(ROOT / 'scripts/opencode_ci.py', 'opencode_ci_host')
        host_tools = ci.verify_host_tools(canonical(args.tools))
        require(load(ROOT / 'build/ci-host-tools.json') == host_tools, 'ci_host_tools_changed')
    else:
        require(tools_profile == 'workspace-debian', 'host_tools_profile')
        run([sys.executable, '-B', args.core / 'tests/integration/browser-native-tools.py',
             '--verify', '--output', canonical(args.tools)])
        host_tools = None
    manifest = validate_bundle(args.bundle, profile['model_profile'], backend)
    # The host executes only this reviewed runner; guest code remains in KVM.
    require(manifest['files']['code/scripts/smoke_opencode_inference.py']['sha256'] == digest(Path(__file__)),
            'runner_differs_from_captured_input')
    listener = socket.socket()
    try:
        listener.bind(('127.0.0.1', 22223))
    finally:
        listener.close()
    for path in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            words = path.read_bytes().split(b'\0')
        except (OSError, PermissionError):
            continue
        require(not any(word.endswith(b'/qemu-system-x86_64') or word == b'qemu-system-x86_64' for word in words),
                'another_vm_is_running')
    args.output.mkdir(mode=0o700)
    before = host_state()
    record(args.output / 'host-state-before.json', before)
    scratch = Path(tempfile.mkdtemp(prefix='opencode-kvm-', dir=args.output.parent))
    os.chmod(scratch, 0o700)
    name = 'volparossa-opencode-vm-' + uuid.uuid4().hex[:12] + '.service'
    launched, status = False, 1
    receipt = dict(version=1, kind='opencode-inference-vm', passed=False, phase='prepare', failure=None,
        core_revision=profile['core_revision'], model_profile=profile['model_profile'],
        bundle_sha256=digest(args.bundle), bundle_bytes=args.bundle.stat().st_size,
        code_contains_uncommitted_changes=True, memory_mib=profile['guest_memory_mib'], cpus=2, vm_started=False,
        qemu_joined=False, scratch_removed=False, host_observed_routes_dns_unchanged=None,
        host_raw_route_dns_bytes_unchanged=None, host_observation_scope='proc_visible_routes_and_resolv_conf',
        host_firewall_modified=False, actual_model_execution_proven=False,
        confidential_remote_execution_proven=False)
    receipt.update(backend_fields(profile))
    if host_tools is not None:
        receipt['host_tools_profile'] = tools_profile
        receipt['host_tools_sha256'] = hashlib.sha256(json.dumps(host_tools, sort_keys=True).encode()).hexdigest()
    control = ['systemctl', '--user']
    key, hostkey, known = scratch / 'ssh-key', scratch / 'host-key', scratch / 'known-hosts'
    ssh_options = ['-F', '/dev/null', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ForwardAgent=no', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'IdentitiesOnly=yes',
        '-o', 'IdentityAgent=none', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PasswordAuthentication=no',
        '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'RequestTTY=no',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'Tunnel=no', '-o', 'UserKnownHostsFile=' + str(known)]

    def ssh(*command, timeout=30, check=True):
        return subprocess.run(['ssh', *ssh_options, '-p', '22223', 'vpci@127.0.0.1', *command],
                              capture_output=True, timeout=timeout, check=check)

    def scp(source, destination):
        run(['scp', *ssh_options, '-P', '22223', source, destination], timeout=600)

    def unit_state():
        result = subprocess.run([*control, 'show', name,
                                 '--property=ActiveState,MainPID,ControlGroup,Result,ExecMainCode,ExecMainStatus'],
                                text=True, capture_output=True, timeout=15)
        require(result.returncode in (0, 1), 'user_unit_observation')
        return dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)

    def interrupted(*_):
        raise InterruptedError('interrupted')

    old_signals = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        bins = args.tools / 'bin'
        run([bins / 'qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', args.image,
             scratch / 'overlay.qcow2', str(profile['scratch_gib']) + 'G'])
        for target, label in ((key, 'volparossa-opencode-user'), (hostkey, 'volparossa-opencode-host')):
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', label, '-f', target])
        known.write_text('[127.0.0.1]:22223 ' + hostkey.with_suffix('.pub').read_text())
        known.chmod(0o600)
        user = '#cloud-config\nusers:\n  - name: vpci\n    groups: [sudo]\n    sudo: "ALL=(ALL) NOPASSWD:ALL"\n'
        user += '    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ' + key.with_suffix('.pub').read_text()
        user += 'ssh_pwauth: false\ndisable_root: true\nssh_deletekeys: true\nssh_keys:\n  ed25519_private: |\n'
        user += ''.join('    ' + line + '\n' for line in hostkey.read_text().splitlines())
        user += '  ed25519_public: ' + hostkey.with_suffix('.pub').read_text()
        user += 'growpart:\n  mode: auto\n  devices: [/]\nresize_rootfs: true\n'
        (scratch / 'user-data').write_text(user)
        (scratch / 'meta-data').write_text('instance-id: ' + name + '\nlocal-hostname: volparossa-alpha\n')
        tool_env = dict(os.environ, PATH=str(bins) + ':' + os.environ['PATH'])
        run([bins / 'cloud-localds', scratch / 'seed.img', scratch / 'user-data', scratch / 'meta-data'], env=tool_env)
        # Check again immediately before launch; never rely on an earlier snapshot.
        available = available_memory()
        require(available >= profile['host_available_bytes'], profile['memory_failure'])
        receipt['host_available_bytes_at_launch'] = available
        qemu = qemu_command(args.tools, scratch,
                            Path('/usr/share/seabios/vgabios-stdvga.bin') if host_tools is not None else None,
                            profile['model_profile'], backend)
        run(['systemd-run', '--user', '--quiet', '--unit=' + name, '--property=Type=exec',
            '--property=RemainAfterExit=yes',
            '--property=MemoryMax=' + str(profile['qemu_memory_bytes']), '--property=MemorySwapMax=0',
            '--property=RuntimeMaxSec=7200', '--property=TimeoutStopSec=15', '--property=KillMode=control-group',
            '--property=StandardOutput=null', '--property=StandardError=append:' + str(scratch / 'qemu.stderr'), *qemu], env=tool_env)
        launched, receipt['vm_started'], receipt['phase'] = True, True, 'guest-boot'
        state = unit_state()
        require(boot_running(state), 'qemu_start')
        receipt['qemu_pid'] = int(state['MainPID'])
        receipt['owned_unit'] = name
        group = state['ControlGroup']
        require(group.startswith('/user.slice/') and group.endswith('/' + name) and '..' not in group.split('/'),
                'qemu_cgroup')
        group_path = Path('/sys/fs/cgroup' + group)
        receipt['qemu_memory_max'] = int((group_path / 'memory.max').read_text())
        receipt['qemu_swap_max'] = int((group_path / 'memory.swap.max').read_text())
        require(receipt['qemu_memory_max'] == profile['qemu_memory_bytes']
                and receipt['qemu_swap_max'] == 0, 'qemu_resource_limits')
        print(json.dumps({'phase': 'guest-boot', 'qemu_pid': receipt['qemu_pid'], 'unit': name}), flush=True)
        for _ in range(180):
            if ssh('true', timeout=10, check=False).returncode == 0:
                break
            require(boot_running(unit_state()), 'qemu_exited')
            time.sleep(1)
        else:
            raise ValueError('guest_boot_deadline')
        ssh('sudo', '-n', 'cloud-init', 'status', '--wait', timeout=120)
        receipt['phase'] = 'guest-stage'
        scp(args.bundle, 'vpci@127.0.0.1:/home/vpci/opencode-inputs.tar.gz')
        ssh('test', '!', '-e', str(INPUT))
        ssh('mkdir', '-m', '0700', str(INPUT))
        # Archive was completely verified locally; verify its bytes in the guest
        # before controlled extraction. Only regular relative entries are present.
        actual = ssh('sha256sum', '/home/vpci/opencode-inputs.tar.gz').stdout.decode().split()[0]
        require(actual == receipt['bundle_sha256'], 'guest_bundle_hash')
        ssh('tar', '-xzf', '/home/vpci/opencode-inputs.tar.gz', '-C', str(INPUT), '--no-same-owner')
        receipt['phase'] = 'guest-inference'
        print(json.dumps({'phase': receipt['phase'], 'model_profile': profile['model_profile']}), flush=True)
        executed = ssh('python3', '-B', str(INPUT / 'code/scripts/smoke_opencode_inference.py'),
                       'guest', '--model-profile', profile['model_profile'],
                       '--inference-backend', backend, timeout=6600, check=False)
        receipt['guest_exit_status'] = executed.returncode
        scp('vpci@127.0.0.1:/home/vpci/opencode-result.json', args.output / 'guest-result.json')
        result = load(args.output / 'guest-result.json', guest_receipt_limit(backend))
        validate_backend_fields(result, profile)
        require(result.get('core_revision') == profile['core_revision']
                and result.get('model_profile') == profile['model_profile'], 'guest_source_profile')
        if backend != 'torch' and result.get('passed') is True:
            validate_task_selection(result.get('task', {}), profile, backend)
        receipt['actual_model_execution_proven'] = bool(result.get('passed') and result.get('actual_model_provisioned'))
        require(executed.returncode == 0 and result.get('passed') is True, 'guest_trial_failed')
        receipt['phase'], status = 'complete', 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        receipt['failure'] = 'stage_failed'
        receipt['exception'] = closed_exception(error)
    finally:
        for sig, previous in old_signals.items():
            signal.signal(sig, previous)
        if launched:
            try:
                with (scratch / 'qemu.stderr').open('rb') as stream:
                    raw = stream.read(65537)
                receipt['qemu_before_cleanup'] = closed_qemu(unit_state(), raw)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                receipt['qemu_diagnostic_unavailable'] = True
            try:
                ssh('sudo', '-n', 'systemctl', 'poweroff', timeout=15, check=False)
            except (OSError, subprocess.SubprocessError):
                pass
            subprocess.run([*control, 'stop', name], capture_output=True, timeout=30, check=False)
            final = unit_state()
            receipt['qemu_joined'] = final.get('ActiveState') in ('inactive', 'failed') and final.get('MainPID') == '0'
        else:
            receipt['qemu_joined'] = True
        try:
            after = host_state()
            record(args.output / 'host-state-after.json', after)
            receipt['host_raw_route_dns_bytes_unchanged'] = before['raw_sha256'] == after['raw_sha256']
            receipt['host_observed_routes_dns_unchanged'] = same_host_configuration(before, after)
        except (OSError, ValueError, KeyError, TypeError):
            # An unknown format is not unchanged state; it must not skip cleanup.
            receipt['host_state_observation_failed'] = True
            receipt['host_observed_routes_dns_unchanged'] = None
        if receipt['qemu_joined']:
            shutil.rmtree(scratch)
            receipt['scratch_removed'] = not scratch.exists()
        receipt['passed'] = status == 0 and receipt['qemu_joined'] and receipt['scratch_removed'] \
            and receipt['host_observed_routes_dns_unchanged'] is True
        record(args.output / 'vm-result.json', receipt)
        if launched and receipt['qemu_joined']:
            subprocess.run([*control, 'reset-failed', name], capture_output=True, timeout=15, check=False)
        print(json.dumps({'phase': receipt['phase'], 'passed': receipt['passed'], 'failure': receipt['failure'],
                          'qemu_joined': receipt['qemu_joined'], 'scratch_removed': receipt['scratch_removed']}), flush=True)
    return 0 if receipt['passed'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode')
    packing = modes.add_parser('pack')
    packing.add_argument('--core', type=Path, required=True)
    packing.add_argument('--node', type=Path, required=True)
    packing.add_argument('--output', type=Path, required=True)
    guest_parser = modes.add_parser('guest')
    execution = modes.add_parser('execute')
    execution.add_argument('--yes', action='store_true')
    execution.add_argument('--host-tools-profile', choices=('workspace-debian', 'github-ubuntu-24.04'),
                           default='workspace-debian')
    for name in ('core', 'tools', 'image', 'bundle', 'output'):
        execution.add_argument('--' + name, type=Path, required=True)
    for subparser in (packing, guest_parser, execution):
        subparser.add_argument('--model-profile', choices=MODEL_PROFILES, default=MODEL)
        subparser.add_argument('--inference-backend', choices=INFERENCE_BACKENDS, default='torch')
    args = parser.parse_args()
    if args.mode == 'pack':
        pack(args)
    elif args.mode == 'guest':
        return guest(args)
    elif args.mode == 'execute':
        return execute(args)
    else:
        print(json.dumps({'execute': False, 'plan': 'one6GiB2vCPUdisposableKVM; pinnedQweninsideguestonly',
                          'host_install': False, 'host_model_execution': False, 'actual_inference': False}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({'passed': False, 'failure': 'guard_or_stage_failed'}))
        raise SystemExit(1)
