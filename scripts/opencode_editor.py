# SPDX-License-Identifier: GPL-3.0-only
"""Provision the fixed VSCodium release or drive it inside the disposable OpenCode guest."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import socket
import subprocess
import sys
from urllib.request import urlopen

BASE = Path('/home/vpci/opencode-trial')
INPUT = Path('/home/vpci/opencode-input')
UI = Path('/home/vpci/opencode-projects/ui')
PROJECT = UI / 'project'
NODE = INPUT / 'runtime/node'
CODE = INPUT / 'code'
DRIVER = CODE / 'scripts/opencode_editor_ui.cjs'
EDITOR = BASE / 'editor/usr/share/codium'
RELEASE = '1.135.06055'
DEB_NAME = 'codium_' + RELEASE + '_amd64.deb'
DEB_URL = 'https://github.com/VSCodium/vscodium/releases/download/' + RELEASE + '/' + DEB_NAME
DEB_SIZE = 168033440
DEB_SHA = '5f5c00a9da9d232e4c84e9eee68bbdeb4d8737462022626ce3bdb6948f3d8649'
BINARY_SHA = '51ea8d7fb3795a03754b6518fb738d202fbb13185336de6719c4fd8b4ba984aa'
SOURCE = '1a46a584725d5dd330e0bcd7f5510f24990efcf2'
PACKAGES = ['libgtk-3-0t64', 'libnss3', 'libnspr4', 'libatk-bridge2.0-0t64', 'libasound2t64',
            'libgbm1', 'libxkbcommon0', 'libcups2t64', 'libxdamage1', 'libxrandr2', 'fonts-dejavu-core']
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
PROFILE = 'qwen3-4b-instruct-2507-v1'
CONSTRAINT = 'qwen_tagged_tool_json_v1'


def require(value, reason):
    if not value:
        raise ValueError(reason)


def guard():
    require(os.getuid() != 0 and pwd.getpwuid(os.getuid()).pw_name == 'vpci'
            and socket.gethostname() == 'volparossa-alpha'
            and subprocess.check_output(['/usr/bin/systemd-detect-virt', '--vm'], env=ENV).strip() == b'kvm',
            'disposable_guest_required')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def provision():
    guard()
    package = BASE / DEB_NAME
    with urlopen(DEB_URL, timeout=120) as source, package.open('xb') as dest:
        while block := source.read(1024**2):
            require(dest.tell() + len(block) <= DEB_SIZE, 'editor_package_size')
            dest.write(block)
    require(package.stat().st_size == DEB_SIZE and digest(package) == DEB_SHA, 'editor_package')
    subprocess.run(['dpkg-deb', '-x', package, BASE / 'editor'], check=True, timeout=90, env=ENV)
    package.unlink()
    product = json.loads((EDITOR / 'resources/app/product.json').read_text())
    require(digest(EDITOR / 'codium') == BINARY_SHA and product['commit'] == SOURCE, 'editor_identity')
    return {'package_sha256': DEB_SHA, 'binary_sha256': BINARY_SHA, 'source_commit': SOURCE, 'version': RELEASE}


def sandbox():
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
            '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-net', '--unshare-pid',
            '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
            '--dir', '/run', '--dir', '/etc']
    for name in ('/etc/passwd', '/etc/group', '/etc/ld.so.cache', '/etc/fonts',
                 '/sys/devices/virtual/dmi/id', '/sys/class/dmi/id'):
        args.extend(['--ro-bind', name, name])
    for directory in (Path('/home/vpci'), BASE, INPUT, UI.parent):
        args.extend(['--perms', '0700', '--dir', str(directory)])
    for name in (BASE / 'private.sock', EDITOR, CODE, INPUT / 'runtime'):
        args.extend(['--ro-bind', str(name), str(name)])
    return [*args, '--bind', str(UI), str(UI), '--chdir', str(UI), '--clearenv', '--setenv', 'HOME',
            '/home/vpci', '--setenv', 'PATH', ENV['PATH'], '--setenv', 'LANG', ENV['LANG'],
            '--', '/usr/bin/python3', '-B', str(CODE / 'scripts/opencode_editor.py'), 'inside']


def inside():
    guard()
    require({name for _, name in socket.if_nameindex()} == {'lo'} and Path.cwd() == UI, 'editor_network')
    require(int(next(v.split()[1] for v in Path('/proc/self/status').read_text().splitlines()
                     if v.startswith('CapEff:')), 16) == 0, 'editor_capabilities')
    profile = UI / 'profile'
    (profile / 'User').mkdir(parents=True, mode=0o700)
    extensions = UI / 'extensions'
    extensions.mkdir(mode=0o700)
    build = json.loads((INPUT / 'runtime/build-report.json').read_text())
    settings = {'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none',
                'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': 'off',
                'extensions.autoCheckUpdates': False, 'security.workspace.trust.enabled': True,
                'volparossaCode.privateSocket': str(BASE / 'private.sock'),
                'volparossaCode.openCodeRuntime': {'version': 1, 'opencode': str(INPUT / 'runtime/opencode'),
                    'opencodeSha256': build['binary_sha256'], 'buildReport': str(INPUT / 'runtime/build-report.json'),
                    'node': str(NODE), 'nodeSha256': digest(NODE), 'outputConstraint': CONSTRAINT},
                'volparossaCode.ownerVerification': {'executable': str(Path('/usr/bin/python3').resolve()), 'args':
                    ['-B', '-m', 'unittest', '-v', 'test_fixture.py'], 'timeoutMs': 15000, 'maxRounds': 4}}
    (profile / 'User/settings.json').write_text(json.dumps(settings))
    args = [EDITOR / 'codium', '--new-window', '--ozone-platform=headless', '--disable-gpu',
            '--disable-updates', '--disable-telemetry', '--disable-crash-reporter', '--locale=en',
            '--user-data-dir='+str(profile), '--extensions-dir='+str(extensions), '--extensionDevelopmentPath='+str(CODE),
            '--skip-welcome', '--skip-release-notes', '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=9222', PROJECT]
    with (UI / 'editor.log').open('xb') as log:
        editor = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
        try:
            subprocess.run([NODE, DRIVER, PROJECT, UI / 'rendered.json'], timeout=2510, check=True)
            require(editor.wait(timeout=20) == 0, 'editor_exit')
        finally:
            if editor.poll() is None:
                os.killpg(editor.pid, signal.SIGTERM)
                try:
                    editor.wait(timeout=7)
                except subprocess.TimeoutExpired:
                    os.killpg(editor.pid, signal.SIGKILL)
                    editor.wait(timeout=7)


def run():
    guard()
    os.umask(0o077)
    UI.mkdir(mode=0o700)
    receipt = {'kind': 'opencode-vscodium-task', 'version': 2, 'passed': False, 'phase': 'fixture',
               'model_profile': PROFILE, 'output_constraint': CONSTRAINT,
               'protected_peer_execution_proven': False, 'general_coding_quality_proven': False}
    try:
        subprocess.run([NODE, DRIVER, '--fixture', 'prepare'], env=ENV, check=True, timeout=25)
        receipt['baseline_tests_failed'] = True
        receipt['phase'] = 'editor'
        completed = subprocess.run(sandbox(), env=ENV, timeout=2530, check=False)
        rendered = UI / 'rendered.json'
        if rendered.is_file():
            require(rendered.stat().st_size <= 8192, 'editor_receipt')
            receipt['rendered'] = json.loads(rendered.read_text())
        require(completed.returncode == 0 and receipt.get('rendered', {}).get('passed') is True
                and receipt['rendered']['model_profile'] == PROFILE, 'editor_failed')
        receipt['editor_exited'] = True
        receipt['phase'] = 'independent-check'
        data = subprocess.check_output([NODE, DRIVER, '--fixture', 'verify'], env=ENV, timeout=25)
        receipt.update(json.loads(data), independent_test_passed=True, phase='complete')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        receipt['failure'] = 'stage_failed'
    finally:
        shutil.rmtree(UI)
        receipt['project_removed'] = not UI.exists()
        receipt['passed'] = receipt['phase'] == 'complete' and receipt['project_removed']
        with (BASE / 'task.json').open('x') as stream:
            json.dump(receipt, stream)
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['inside']:
        inside()
    elif sys.argv[1:] == ['run']:
        sys.exit(run())
    else:
        sys.exit('expected an explicit disposable-guest action')
