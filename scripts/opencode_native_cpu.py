#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Guest-only source build and closed native provenance for the original trial.

No model is loaded here. The existing core provisioner owns conversion inside
its original disk/deadline budget; core separately verifies artifacts before use.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import struct
import subprocess
import sys
import time

SOURCE = '7fe450e19305b828c199d602c23a8337aaa1f03b'
ORIGIN = 'https://github.com/ggml-org/llama.cpp.git'
KIND = 'llama_cpp_bf16_v1'
OUTPUT_CONSTRAINT = 'qwen_tagged_tool_json_v1'
NATIVE_SESSION = 'connection_bound_v1'
LEGACY_WRAPPERS = ('CMakeLists.txt', 'adapter.h', 'adapter.cpp', 'bounded-tensor-validation.patch')
CONSTRAINED_WRAPPERS = LEGACY_WRAPPERS + ('output-constraint.h', 'output-constraint.cpp')
SESSION_WRAPPERS = CONSTRAINED_WRAPPERS + ('session-state.h',)
MODEL = 'qwen3-4b-instruct-2507-v1'
BASE = Path('/home/vpci/opencode-trial')
CORE = Path('/home/vpci/source')
CONTROL = 'native-build-control.sock'
FRAME_MAX = 1024
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def module(path, name):
    # The core archive is already source-pinned by the trial. Load its exact
    # sibling contract, never a same-named module from sys.path or a prior core.
    require(path.is_absolute() and path.resolve(strict=True) == path, 'native_module_path')
    file_identity(path, 1024 ** 2)
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    if path.name == 'build_llama_cpu.py':
        native = module(path.with_name('llama_cpu.py'), 'trial_native_contract')
        absent = object()
        previous = sys.modules.get('llama_cpu', absent)
        try:
            sys.modules['llama_cpu'] = native
            spec.loader.exec_module(value)
            require(getattr(value, 'native', None) is native, 'native_builder_contract')
        finally:
            if previous is absent:
                sys.modules.pop('llama_cpu', None)
            else:
                sys.modules['llama_cpu'] = previous
    else:
        spec.loader.exec_module(value)
    return value


def remaining(deadline):
    require(type(deadline) is int and 0 < deadline < 2 ** 63, 'native_deadline')
    seconds = (deadline - time.monotonic_ns()) / 1_000_000_000
    require(0 < seconds <= 1800, 'native_deadline')
    return seconds


def binding(kind, nonce, manifest):
    require(kind in ('ready', 'release') and type(nonce) is str
            and re.fullmatch('[0-9a-f]{64}', nonce) and type(manifest) is str
            and re.fullmatch('[0-9a-f]{64}', manifest), 'native_handshake_binding')
    return (json.dumps(dict(version=1, kind='native_build_' + kind, nonce=nonce,
                           source_commit=SOURCE, build_manifest_sha256=manifest),
                       sort_keys=True, separators=(',', ':')) + '\n').encode()


def send_frame(channel, raw, deadline):
    require(type(raw) is bytes and 0 < len(raw) <= FRAME_MAX, 'native_handshake_frame')
    channel.settimeout(remaining(deadline))
    channel.sendall(raw)
    channel.shutdown(socket.SHUT_WR)


def receive_frame(channel, deadline):
    raw = bytearray()
    while True:
        channel.settimeout(remaining(deadline))
        part = channel.recv(FRAME_MAX + 1 - len(raw))
        if not part:
            require(0 < len(raw) <= FRAME_MAX, 'native_handshake_frame')
            return bytes(raw)
        raw.extend(part)
        require(len(raw) <= FRAME_MAX, 'native_handshake_frame')


def peer(channel, expected_pid):
    observed = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(type(expected_pid) is int and expected_pid > 1
            and observed == (expected_pid, os.getuid(), os.getgid()), 'native_handshake_peer')


def await_release(base, build, nonce, deadline, parent_pid):
    # The compiler has been joined and its provenance verified before readiness.
    # Keep this sole remaining helper alive while its parent reads real cgroup counters.
    path = base / CONTROL
    info = path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600, 'native_handshake_socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(remaining(deadline))
        channel.connect(str(path))
        peer(channel, parent_pid)
        send_frame(channel, binding('ready', nonce, build['build_manifest_sha256']), deadline)
        require(receive_frame(channel, deadline) == binding('release', nonce, build['build_manifest_sha256']),
                'native_handshake_binding')
        remaining(deadline)


def file_identity(path, maximum):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and 0 < info.st_size <= maximum, 'native_file')
        return {'bytes': info.st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def document(path, maximum):
    file_identity(path, maximum)
    raw = path.read_bytes()
    require(len(raw) <= maximum, 'native_document_bound')
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def validate_build(core, base):
    builder = module(core / 'workers/volparossa-ml/build_llama_cpu.py', 'trial_native_builder')
    require(builder.SOURCE == SOURCE and builder.ORIGIN == ORIGIN and builder.KIND == KIND, 'native_builder_pin')
    tree = builder.verify_source(base / 'llama-source')
    value, report_hash = document(base / 'llama-build/build.json', 65536)
    builder.native.validate_build_provenance(value, require)
    require(type(value.get('version')) is int and value['version'] in (2, 3, 4), 'native_build_version')
    constrained, session = value['version'] >= 3, value['version'] == 4
    require(value.get('output_constraints') == [OUTPUT_CONSTRAINT] if constrained
            else 'output_constraints' not in value, 'native_build_constraint')
    require(value.get('native_sessions') == [NATIVE_SESSION] if session
            else 'native_sessions' not in value, 'native_build_session')
    require(value.get('kind') == KIND and value.get('source_commit') == SOURCE
            and value.get('source_tree') == tree and value.get('abi_version') == 1
            and value.get('jobs') == 2 and value.get('cpu') == 'avx2_fma_f16c'
            and value.get('models_loaded') is False and value.get('downloads') is False
            and value.get('install') is False and value.get('sanitizers') is False
            and value.get('provisionable') is True and value.get('quantization') is False,
            'native_build_provenance')
    library = file_identity(base / 'llama-build/libvolparossa_llama_cpu.so', 128 * 1024 ** 2)
    require(value.get('library') == {'path': 'libvolparossa_llama_cpu.so', **library}, 'native_library_binding')
    names = SESSION_WRAPPERS if session else (CONSTRAINED_WRAPPERS if constrained else LEGACY_WRAPPERS)
    wrapper = {name: file_identity(core / 'workers/volparossa-ml/native-cpu' / name, 1024 ** 2)
               for name in names}
    require(value.get('wrapper_sources') == wrapper, 'native_wrapper_binding')
    builder.verify_loader_compilation(base / 'llama-build',
                                      base / 'llama-build/loader-overlay/llama-model-loader.cpp')
    require(type(value.get('dynamic_dependencies')) is list
            and value['dynamic_dependencies'] and len(set(value['dynamic_dependencies'])) == len(value['dynamic_dependencies'])
            and set(value['dynamic_dependencies']) <= builder.ALLOWED_NEEDED, 'native_dependency_binding')
    result = dict(kind=KIND, source_commit=SOURCE, source_tree=tree, build_manifest_sha256=report_hash,
                library=library, wrapper_sources=wrapper, jobs=2, nice=19,
                cpu='avx2_fma_f16c', quantization=False, models_loaded=False)
    if constrained:
        result.update(build_version=value['version'], output_constraints=[OUTPUT_CONSTRAINT])
    if session:
        result['native_sessions'] = [NATIVE_SESSION]
    return result


def validate_provision(core, base, report, build):
    require(report.get('native_cpu_converter') == {'implementation': KIND,
            'dependencies': {'sentencepiece': '0.2.1'}}, 'native_converter_binding')
    backend = report.get('native_backend')
    require(type(backend) is dict and set(backend) == {'kind', 'root', 'backend_sha256'}
            and backend['kind'] == KIND and backend['root'] == str(base / 'ml/native-backend')
            and type(backend['backend_sha256']) is str and re.fullmatch('[0-9a-f]{64}', backend['backend_sha256']),
            'native_provision_binding')
    root = base / 'ml/native-backend'
    require(root.resolve(strict=True) == root and stat.S_IMODE(root.stat().st_mode) == 0o700, 'native_backend_root')
    value, manifest_hash = document(root / 'backend.json', 16384)
    native = module(core / 'workers/volparossa-ml/llama_cpu.py', 'trial_native_contract')
    native.validate_manifest(value, require)
    require(type(value.get('version')) is int and value['version'] in (1, 2, 3), 'native_manifest_version')
    constrained, session = value['version'] >= 2, value['version'] == 3
    expected_build = value['version'] + 1
    require((value.get('output_constraints') == [OUTPUT_CONSTRAINT]
             and build.get('build_version') == expected_build
             and build.get('output_constraints') == [OUTPUT_CONSTRAINT])
            if constrained else ('output_constraints' not in value and 'output_constraints' not in build
                                 and 'build_version' not in build), 'native_manifest_constraint')
    require((value.get('native_sessions') == build.get('native_sessions') == [NATIVE_SESSION])
            if session else ('native_sessions' not in value and 'native_sessions' not in build),
            'native_manifest_session')
    require(manifest_hash == backend['backend_sha256'] and value['model_profile'] == MODEL
            and value['build_manifest_sha256'] == build['build_manifest_sha256']
            and value['library'] == {'path': 'libvolparossa_llama_cpu.so', **build['library']}, 'native_manifest_binding')
    copied_build, build_hash = document(root / 'build.json', 65536)
    require(build_hash == build['build_manifest_sha256'], 'native_copied_build_binding')
    native.validate_build_provenance(copied_build, require)
    require(type(copied_build.get('version')) is int and copied_build['version'] == expected_build
            and (copied_build.get('output_constraints') == [OUTPUT_CONSTRAINT] if constrained
                 else 'output_constraints' not in copied_build), 'native_copied_build_constraint')
    require(copied_build.get('native_sessions') == [NATIVE_SESSION] if session
            else 'native_sessions' not in copied_build, 'native_copied_build_session')
    for name, maximum in (('library', 128 * 1024 ** 2), ('gguf', 9 * 1024 ** 3)):
        require(value[name] == {'path': value[name]['path'], **file_identity(root / value[name]['path'], maximum)},
                'native_artifact_binding')
    # Closed hashes/sizes only: no host paths, prompts, source code or model text.
    result = dict(kind=KIND, source_commit=SOURCE, manifest_sha256=manifest_hash,
                build_manifest_sha256=build_hash, library_sha256=value['library']['sha256'],
                gguf_sha256=value['gguf']['sha256'], gguf_bytes=value['gguf']['bytes'],
                source_weights_sha256=value['source_weights_sha256'])
    if constrained:
        result.update(backend_version=value['version'], build_version=expected_build,
                      output_constraints=[OUTPUT_CONSTRAINT])
    if session:
        result['native_sessions'] = [NATIVE_SESSION]
    return result


def require_output_constraint(build, backend):
    """Current trial requires both constrained output and the owner-session ABI.

    Historical validators above remain readable; neither an old constrained
    build nor a session capability on only one artifact authorizes this trial.
    """
    require(build.get('build_version') == 4 and backend.get('build_version') == 4
            and backend.get('backend_version') == 3
            and build.get('output_constraints') == backend.get('output_constraints') == [OUTPUT_CONSTRAINT]
            and build.get('native_sessions') == backend.get('native_sessions') == [NATIVE_SESSION],
            'native_output_constraint_required')


def guest_build(deadline=None):
    require(os.getuid() > 0 and pwd.getpwuid(os.getuid()).pw_name == 'vpci'
            and socket.gethostname() == 'volparossa-alpha'
            and subprocess.run(['systemd-detect-virt', '--vm'], check=True, capture_output=True,
                               text=True, timeout=10).stdout.strip() == 'kvm'
            and 'VERSION_ID="13"' in Path('/etc/os-release').read_text(), 'disposable_guest_required')
    remaining(deadline)
    os.umask(0o077)
    source, output = BASE / 'llama-source', BASE / 'llama-build'
    require(not source.exists() and not source.is_symlink() and not output.exists() and not output.is_symlink(),
            'native_fresh_directories')
    source.mkdir(mode=0o700)
    git = ['git', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never']
    for operation in (['init', '--quiet'], ['remote', 'add', 'origin', ORIGIN],
                      ['fetch', '--depth=1', '--no-tags', 'origin', SOURCE], ['checkout', '--detach', '--quiet', 'FETCH_HEAD']):
        subprocess.run([*git, *operation], cwd=source, env=ENV, check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=min(300, remaining(deadline)))
    builder = module(CORE / 'workers/volparossa-ml/build_llama_cpu.py', 'trial_native_build')
    require(builder.SOURCE == SOURCE and builder.ORIGIN == ORIGIN, 'native_builder_pin')
    builder.verify_source(source)
    # This whole helper is inside the single 1800-second guest cgroup. The
    # original builder independently fixes max two jobs and nice19, and owns
    # compiler cleanup. No source acquisition or compilation runs on the host.
    subprocess.run([os.sys.executable, '-B', str(CORE / 'workers/volparossa-ml/build_llama_cpu.py'),
                    '--source', str(source), '--output', str(output), '--execute'],
                   env=ENV, check=True, timeout=remaining(deadline))
    return validate_build(CORE, BASE)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', required=True)
    parser.add_argument('--deadline-monotonic-ns', type=int, required=True)
    parser.add_argument('--handshake-nonce', required=True)
    parser.add_argument('--parent-pid', type=int, required=True)
    args = parser.parse_args()
    try:
        binding('ready', args.handshake_nonce, '0' * 64)
        require(args.parent_pid > 1, 'native_handshake_peer')
        build = guest_build(args.deadline_monotonic_ns)
        await_release(BASE, build, args.handshake_nonce, args.deadline_monotonic_ns, args.parent_pid)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('NATIVE_GUEST_SOURCE_BUILD_FAILED')
        raise SystemExit(1)
