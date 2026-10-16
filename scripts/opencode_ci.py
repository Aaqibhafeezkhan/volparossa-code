#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit hosted-CI plumbing; never a model, task, or VM implementation.

Ubuntu packages are an explicitly different host-tool profile, not the pinned
Debian workspace-tool receipt. Model/resource choices are explicit closed profiles;
the original 0.6B profile remains the default.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
BASELINE = 'afdb28495cacd74de3bd8467491bdbb9a8b50949'
PROFILE = 'github-ubuntu-24.04'
MODEL = 'qwen3-0.6b-v1'
MODEL_PROFILES = (MODEL, 'qwen3-4b-instruct-2507-v1')
INFERENCE_BACKENDS = ('torch', 'llama_cpp_bf16_v1')
TOOLS = {'qemu-system-x86_64': ('/usr/bin/qemu-system-x86_64', 'qemu-system-x86'),
         'qemu-img': ('/usr/bin/qemu-img', 'qemu-utils'),
         'cloud-localds': ('/usr/bin/cloud-localds', 'cloud-image-utils'),
         'vgabios-stdvga.bin': ('/usr/share/seabios/vgabios-stdvga.bin', 'seabios')}
EXPORTS = ('ci-source.json', 'ci-host-tools.json', 'ci-preflight.json', 'ci-build.json',
           'ci-inputs.json', 'ci-build-cleanup.json', 'ci-host-cleanup.json')
VM_EXPORTS = ('vm-result.json', 'guest-result.json', 'host-state-before.json', 'host-state-after.json',
              'qemu-memory.json')


def require(value, reason):
    if not value:
        raise ValueError(reason)


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 30), **kwargs)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def record(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write('\n')
    path.chmod(0o600)


def guard():
    require(os.getuid() > 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux'
            and os.environ.get('GITHUB_REPOSITORY') == 'VOLPAROSSA/volparossa-code'
            and re.fullmatch('[0-9]+', os.environ.get('GITHUB_RUN_ID', '')), 'hosted_ci_only')
    release = dict(row.split('=', 1) for row in Path('/etc/os-release').read_text().splitlines() if '=' in row)
    require(release.get('ID', '').strip('"') == 'ubuntu'
            and release.get('VERSION_ID', '').strip('"') == '24.04'
            and os.uname().machine == 'x86_64', 'ubuntu_24_amd64_only')


def trial_profile(model_profile=MODEL, inference_backend='torch'):
    trial = module(ROOT / 'scripts/smoke_opencode_inference.py', 'ci_trial_profile')
    return trial.trial_profile(model_profile, inference_backend)


def backend_fields(profile):
    return {key: profile[key] for key in ('inference_backend', 'native_source_commit') if key in profile}


def exact_sources(core, expected, model_profile=MODEL, inference_backend='torch'):
    guard()
    profile = trial_profile(model_profile, inference_backend)
    require(re.fullmatch('[0-9a-f]{40}', expected or '')
            and expected == os.environ.get('GITHUB_SHA'), 'exact_dispatched_source')
    require(core.resolve(strict=True) == core and core == BUILD / 'ci-core', 'core_checkout_scope')
    for repo, sha in ((ROOT, expected), (core, profile['core_revision'])):
        require(run(['git', '-C', repo, 'rev-parse', 'HEAD'], text=True).stdout.strip() == sha
                and not run(['git', '-C', repo, 'status', '--porcelain'], text=True).stdout,
                'clean_exact_checkout')
    run(['git', '-C', ROOT, 'merge-base', '--is-ancestor', BASELINE, expected])
    return {'version': 1, 'code_revision': expected, 'code_baseline': BASELINE,
            'code_tree': run(['git', '-C', ROOT, 'rev-parse', 'HEAD^{tree}'], text=True).stdout.strip(),
            'core_revision': profile['core_revision'], 'model_profile': model_profile, 'code_checkout_clean': True,
            'host_tools_profile': PROFILE, 'actual_inference_proven': False, **backend_fields(profile)}


def verify_host_tools(tools):
    guard()
    require(tools == Path('/usr') and tools.resolve(strict=True) == tools, 'ci_system_tools_only')
    files, packages = {}, {}
    for name, (value, package) in TOOLS.items():
        path = Path(value)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o6022
                and path.resolve(strict=True) == path, 'official_root_owned_tool')
        owner = run(['dpkg-query', '-S', path], text=True).stdout.strip()
        require(owner in (f'{package}: {path}', f'{package}:amd64: {path}'), 'official_package_owner')
        require(not run(['dpkg', '--verify', package], text=True).stdout, 'package_integrity')
        version = run(['dpkg-query', '-W', '-f=${Version}', package], text=True).stdout
        require(re.fullmatch('[0-9A-Za-z.+:~_-]{1,100}', version), 'package_version')
        packages[package] = version
        files[name] = {'bytes': info.st_size, 'sha256': digest(path)}
    return {'version': 1, 'profile': PROFILE, 'distribution_packages': packages, 'files': files,
            'source_built_host_tools': False, 'debian_workspace_pins_claimed': False}


def preflight(model_profile=MODEL, inference_backend='torch'):
    tools = verify_host_tools(Path('/usr'))
    trial = module(ROOT / 'scripts/smoke_opencode_inference.py', 'ci_trial_preflight')
    profile = trial.trial_profile(model_profile, inference_backend)
    require(trial.available_memory() >= profile['host_available_bytes'], profile['memory_failure'])
    name = 'volparossa-opencode-preflight-' + uuid.uuid4().hex[:12] + '.service'
    # The service itself, not merely the invoking shell, proves KVM access and
    # effective limits. No VM/model is started by this short admission probe.
    probe = '''import fcntl, os
from pathlib import Path
assert os.getuid() > 0
with open('/dev/kvm', 'rb+', buffering=0) as kvm:
    assert fcntl.ioctl(kvm.fileno(), 0xAE00, 0) == 12
group = Path('/proc/self/cgroup').read_text().strip().split(':', 2)[2]
assert group.startswith('/user.slice/') and group.endswith('/' + __import__('sys').argv[1])
base = Path('/sys/fs/cgroup' + group)
assert int((base / 'memory.max').read_text()) == int(__import__('sys').argv[2])
assert int((base / 'memory.swap.max').read_text()) == 0
'''
    try:
        run(['systemd-run', '--user', '--quiet', '--wait', '--pipe', '--unit=' + name,
             '--property=Type=exec', '--property=MemoryMax=' + str(profile['qemu_memory_bytes']),
             '--property=MemorySwapMax=0', '--property=RuntimeMaxSec=15',
             '--property=TimeoutStopSec=5', '--property=KillMode=control-group',
             '/usr/bin/python3', '-I', '-c', probe, name, str(profile['qemu_memory_bytes'])], timeout=45)
    finally:
        stopped = subprocess.run(['systemctl', '--user', 'stop', name], capture_output=True, timeout=15)
        require(stopped.returncode in (0, 5), 'preflight_stop')
        observed = subprocess.run(['systemctl', '--user', 'show', name, '--property=MainPID,ActiveState'],
                                  text=True, capture_output=True, timeout=15)
        require(observed.returncode in (0, 1), 'preflight_observation')
        state = observed.stdout
        require('MainPID=0\n' in state and ('ActiveState=inactive\n' in state or 'ActiveState=failed\n' in state),
                'preflight_cleanup')
        subprocess.run(['systemctl', '--user', 'reset-failed', name], capture_output=True, timeout=15)
    record(BUILD / 'ci-host-tools.json', tools)
    record(BUILD / 'ci-preflight.json', {'version': 1, 'passed': True, 'actual_kvm_api': 12,
        'actual_user_cgroup': True, 'model_profile': model_profile,
        'memory_max': profile['qemu_memory_bytes'], 'host_available_required': profile['host_available_bytes'], 'swap_max': 0,
        'preflight_service_joined': True, 'vm_started': False, **backend_fields(profile)})


def source_build():
    guard()
    builder = module(ROOT / 'scripts/build_opencode_runtime.py', 'ci_opencode_builder')
    # Exercise the real builder's exact sparse mounts/user namespaces first.
    # The full source build remains the existing implementation, not a new one.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='opencode-build-probe-', dir=BUILD) as temporary:
        build = Path(temporary)
        for network in (True, False):
            code = '''import os
from pathlib import Path
assert os.getuid() > 0
status = dict(row.split(':',1) for row in Path('/proc/self/status').read_text().splitlines() if ':' in row)
assert int(status['CapEff'],16) == int(status['CapPrm'],16) == 0
assert int(status['NoNewPrivs']) == 1
assert not list(Path('/run').iterdir())
assert not list(Path(__import__('pwd').getpwuid(os.getuid()).pw_dir).iterdir())
assert 'volparossa_ci_native_child' in Path('/proc/self/attr/current').read_text()
'''
            run(builder.sandbox(build, network=network) + ['/usr/bin/python3', '-I', '-c', code],
                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    builder.main(['--execute'])
    value = json.loads((BUILD / 'opencode-runtime/build-report.json').read_text())
    # The original report with its runner-local binary path stays in the bundle;
    # the public build receipt retains the checked provenance without that path.
    value.pop('binary')
    record(BUILD / 'ci-build.json', value)


def assets(core, model_profile=MODEL, inference_backend='torch'):
    guard()
    profile = trial_profile(model_profile, inference_backend)
    require(run(['git', '-C', core, 'rev-parse', 'HEAD'], text=True).stdout.strip()
            == profile['core_revision'], 'exact_core')
    private = module(core / 'tests/integration/agent-private-conversation.py', 'ci_node_assets')
    pin = private.pins()['runtime']
    private.fetch(pin['url'], BUILD / 'ci-node.tar.xz', pin)
    with tarfile.open(BUILD / 'ci-node.tar.xz', 'r:xz') as archive:
        private.extract_node(archive, BUILD / 'ci-node', pin['files'])


def capture(model_profile=MODEL, inference_backend='torch'):
    guard()
    trial = module(ROOT / 'scripts/smoke_opencode_inference.py', 'ci_trial_inputs')
    profile = trial.trial_profile(model_profile, inference_backend)
    path = BUILD / 'ci-inputs.tar.gz'
    manifest = trial.validate_bundle(path, model_profile, inference_backend)
    source = json.loads((BUILD / 'ci-source.json').read_text())
    trial.validate_backend_fields(source, profile)
    require(source['code_revision'] == manifest['code_base_revision'] == os.environ['GITHUB_SHA'], 'input_source')
    require(source['core_revision'] == manifest['core_revision'] == profile['core_revision']
            and source['model_profile'] == manifest['model_profile'] == model_profile, 'input_profile')
    record(BUILD / 'ci-inputs.json', {'version': 1, 'bundle_sha256': digest(path),
           'code_revision': source['code_revision'], 'core_revision': profile['core_revision'], 'model_profile': model_profile,
           'code_checkout_clean': True, 'input_manifest': manifest, **backend_fields(profile)})


def export():
    guard()
    output = BUILD / 'ci-public-receipts'
    output.mkdir(mode=0o700)
    # Fixed producer paths only. Never archive build/, runtime logs, the bundle,
    # qcow2 images, private SSH files, guest console, or model caches.
    for directory, names in ((BUILD, EXPORTS), (BUILD / 'ci-vm', VM_EXPORTS)):
        for name in names:
            source = directory / name
            if not source.exists():
                continue
            info = source.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and not info.st_mode & 0o077 and info.st_size <= 256 * 1024, 'closed_receipt_file')
            if name == 'qemu-memory.json':
                observer = module(ROOT / 'scripts/opencode_qemu_memory.py', 'ci_qemu_memory')
                value = observer.load(source)
                sources = json.loads((BUILD / 'ci-source.json').read_bytes())
                vm = json.loads((BUILD / 'ci-vm/vm-result.json').read_bytes())
                require(value['source'] == {key: sources[key] for key in value['source']}
                        and all(value['source'][key] == vm[key] for key in
                                ('core_revision', 'model_profile', 'inference_backend')), 'qemu_memory_source')
            else:
                value = json.loads(source.read_bytes())
            require(type(value) is dict, 'closed_receipt_object')
            # Pretty-printing must not expand a bounded input beyond the same
            # public-receipt ceiling. No raw logs or additional paths are added.
            encoded = json.dumps(value, sort_keys=True, indent=2, allow_nan=False).encode() + b'\n'
            require(len(encoded) <= (observer.MAX_JSON if name == 'qemu-memory.json' else 256 * 1024),
                    'closed_receipt_file')
            record(output / name, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('guard', 'select', 'source', 'preflight', 'build', 'assets', 'capture', 'export'))
    parser.add_argument('--core', type=Path)
    parser.add_argument('--expected-code')
    parser.add_argument('--model-profile', choices=MODEL_PROFILES, default=MODEL)
    parser.add_argument('--inference-backend', choices=INFERENCE_BACKENDS, default='torch')
    args = parser.parse_args()
    if args.mode == 'guard':
        guard()
    elif args.mode == 'select':
        guard()
        print('core_revision=' + trial_profile(args.model_profile, args.inference_backend)['core_revision'])
    elif args.mode == 'source':
        record(BUILD / 'ci-source.json', exact_sources(args.core, args.expected_code, args.model_profile, args.inference_backend))
    elif args.mode == 'assets':
        assets(args.core, args.model_profile, args.inference_backend)
    elif args.mode == 'preflight':
        preflight(args.model_profile, args.inference_backend)
    elif args.mode == 'capture':
        capture(args.model_profile, args.inference_backend)
    else:
        {'build': source_build, 'export': export}[args.mode]()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        reasons = {'hosted_ci_only', 'ubuntu_24_amd64_only', 'exact_dispatched_source', 'core_checkout_scope',
                   'clean_exact_checkout', 'ci_system_tools_only', 'official_root_owned_tool',
                   'official_package_owner', 'package_integrity', 'package_version',
                   'host_available_memory_below_8GiB', 'host_available_memory_below_14GiB',
                   'preflight_stop', 'preflight_observation', 'unknown_model_profile', 'larger_core_not_pinned',
                   'unknown_inference_backend', 'native_backend_requires_qwen4b', 'native_core_not_pinned', 'input_backend',
                   'preflight_cleanup', 'exact_core', 'input_source', 'input_profile',
                   'closed_receipt_file', 'closed_receipt_object'}
        reason = error.args[0] if error.args and isinstance(error.args[0], str) else None
        print(json.dumps({'passed': False, 'failure': reason if reason in reasons else 'hosted_ci_stage_failed',
                          'subprocess_status': error.returncode if isinstance(error, subprocess.CalledProcessError) else None}))
        raise SystemExit(1)
