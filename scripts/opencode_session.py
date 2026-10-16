#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit pinned OpenCode session; no downloads, participation or host changes."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
PIN = 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
FIELDS = {'version', 'opencode', 'opencodeSha256', 'buildReport', 'node', 'nodeSha256', 'socketPath'}
COOPERATIVE_FIELD = 'cooperativeSocketPath'
OUTPUT_CONSTRAINT = 'qwen_tagged_tool_json_v1'
SOURCES = ('private-compute.cjs', 'private-conversation.cjs', 'private-native-session.cjs', 'responses-provider.cjs',
           'chat-completions-provider.cjs', 'opencode-config.cjs', 'opencode-client.cjs',
           'opencode-task.cjs', 'opencode-bridge.cjs')


def require(value):
    if not value:
        raise ValueError('opencode-session-scope')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def owned(value, kind):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path)
    info = path.lstat()
    require(info.st_uid == os.getuid() and not info.st_mode & 0o6022 and kind(info.st_mode))
    return path


def file(value, expected, executable=False):
    path = owned(value, stat.S_ISREG)
    require(type(expected) is str and len(expected) == 64 and digest(path) == expected
            and (not executable or os.access(path, os.X_OK)))
    return path


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def private_socket(value):
    ipc = owned(value, stat.S_ISSOCK)
    require(stat.S_IMODE(ipc.stat().st_mode) == 0o600)
    parent = owned(str(ipc.parent), stat.S_ISDIR)
    require(stat.S_IMODE(parent.stat().st_mode) == 0o700)
    return ipc


def account_home():
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    # The same-owner core service can run under its dedicated system account.
    # This is an empty directory in the namespace, never a bind of host state.
    require(os.getuid() != 0 and account.pw_uid == os.getuid()
            and home.is_absolute() and '..' not in home.parts
            and (home.parent == Path('/home')
                 or account.pw_name == 'volparossa' and home == Path('/var/lib/volparossa')))
    return home


def validate(config, workspace):
    require(os.getuid() != 0 and type(config) is dict and FIELDS <= set(config)
            and set(config) <= FIELDS | {COOPERATIVE_FIELD, 'outputConstraint'}
            and type(config['version']) is int and config['version'] == 1)
    require('outputConstraint' not in config or config['outputConstraint'] == OUTPUT_CONSTRAINT)
    require(all(type(config[name]) is str and 0 < len(config[name]) <= 4096 and '\0' not in config[name]
                for name in set(config) - {'version'}))
    binary = file(config['opencode'], config['opencodeSha256'], True)
    node = file(config['node'], config['nodeSha256'], True)
    report_path = owned(config['buildReport'], stat.S_ISREG)
    require(report_path.stat().st_size <= 65536)
    report = json.loads(report_path.read_text(), object_pairs_hook=no_duplicates)
    pin = json.loads((ROOT / 'third_party/opencode.json').read_text())
    require(type(report) is dict and report.get('version') == 1 and report.get('source_commit') == PIN
            and report.get('source_build') is True
            and report.get('lock_sha256') == pin['bun_lock_sha256']
            and report.get('patch_sha256') == digest(ROOT / pin['local_patch'])
            and report.get('binary_sha256') == config['opencodeSha256']
            and report.get('runtime_version') == pin['tag'][1:])
    ipc = private_socket(config['socketPath'])
    cooperative = private_socket(config[COOPERATIVE_FIELD]) if COOPERATIVE_FIELD in config else None
    require(cooperative is None or cooperative != ipc)
    project = owned(workspace, stat.S_ISDIR)
    home = account_home()
    broad = {Path(name) for name in ('/', '/home', '/root', '/tmp', '/var', '/var/tmp',
                                   '/usr', '/etc', '/run', '/media', '/mnt', '/opt')}
    broad.update((home, *home.parents))
    require(project not in broad and not project.is_mount() and os.access(project, os.R_OK | os.W_OK | os.X_OK))
    authorities = (binary, node, report_path, ipc, ROOT) + ((cooperative,) if cooperative else ())
    require(all(not item.is_relative_to(project) for item in authorities)
            and not project.is_relative_to(ROOT) and not project.is_relative_to(report_path.parent))
    values = binary, node, ipc, project, home, cooperative
    return values + (OUTPUT_CONSTRAINT,) if 'outputConstraint' in config else values


def command(binary, node, ipc, project, home, cooperative=None, output_constraint=None):
    require(output_constraint is None or output_constraint == OUTPUT_CONSTRAINT)
    result = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
        '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-net', '--unshare-pid',
        '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--dir', '/etc', '--ro-bind', '/etc/passwd', '/etc/passwd',
        '--ro-bind', '/etc/group', '/etc/group', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
        '--tmpfs', '/tmp', '--dir', '/run', '--tmpfs', '/opt', '--dir', '/opt/src',
        '--dir', '/opt/scripts', '--dir', str(home), '--perms', '0700', '--dir', '/opt/core',
        '--proc', '/proc', '--dev', '/dev', '--ro-bind', str(binary), '/opt/opencode',
        '--ro-bind', str(node), '/opt/node', '--ro-bind', str(ipc), '/opt/core/compute.sock',
        '--bind', str(project), '/workspace']
    for name in SOURCES:
        result += ['--ro-bind', str(ROOT / 'src' / name), '/opt/src/' + name]
    if cooperative is not None:
        result += ['--ro-bind', str(cooperative), '/opt/core/cooperative.sock']
        for name in ('cooperative-tool-client.cjs', 'opencode-cooperative-tool.js'):
            result += ['--ro-bind', str(ROOT / 'src' / name), '/opt/src/' + name]
    for name in ('opencode_session.py', 'opencode_session.cjs'):
        result += ['--ro-bind', str(ROOT / 'scripts' / name), '/opt/scripts/' + name]
    return result + ['--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'LANG', 'C.UTF-8', '--', '/usr/bin/python3', '-B', '/opt/scripts/opencode_session.py',
        '--inside', os.readlink('/proc/self/ns/net')] + ([OUTPUT_CONSTRAINT] if output_constraint is not None else [])


def main():
    if len(sys.argv) in (3, 4) and sys.argv[1] == '--inside':
        require(len(sys.argv) == 3 or sys.argv[3] == OUTPUT_CONSTRAINT)
        require(os.getuid() != 0 and os.readlink('/proc/self/ns/net') != sys.argv[2]
                and {name for _, name in socket.if_nameindex()} <= {'lo'})
        require(set(os.environ) <= {'PATH', 'LANG', 'LC_CTYPE', 'PWD'}
                and os.environ.get('PWD', '/workspace') == '/workspace')
        require(not list(Path(pwd.getpwuid(os.getuid()).pw_dir).iterdir()))
        caps = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
                    if line.startswith('CapEff:'))
        require(int(caps, 16) == 0)
        selected = ['--output-constraint', OUTPUT_CONSTRAINT] if len(sys.argv) == 4 else []
        os.execve('/opt/node', ['/opt/node', '/opt/scripts/opencode_session.cjs', *selected],
                  {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    require(len(sys.argv) == 4 and sys.argv[1] == '--execute' and len(sys.argv[2]) <= 32768)
    values = validate(json.loads(sys.argv[2], object_pairs_hook=no_duplicates), sys.argv[3])
    os.execve('/usr/bin/bwrap', command(*values), {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        sys.exit(1)
