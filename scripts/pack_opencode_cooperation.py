#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit offline capture for the core's disposable OpenCode/peer trial.

Capture committed Code blobs and an already source-built runtime. No downloads,
model execution, network participation or machine-wide installation occur here.
The resulting manifest is input provenance, never evidence of successful work.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PIN = 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
NODE_VERSION = '24.19.0'
NODE = (125989464, 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12')
NODE_LICENSE = (157606, '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5')
SOURCES = tuple('src/' + name for name in (
    'private-compute.cjs', 'private-conversation.cjs', 'private-native-session.cjs', 'responses-provider.cjs',
    'chat-completions-provider.cjs', 'opencode-config.cjs', 'opencode-client.cjs',
    'opencode-task.cjs', 'opencode-bridge.cjs', 'opencode-runtime.cjs',
    'cooperative-tool-client.cjs', 'cooperative-tool-server.cjs',
    'cooperative-delegation.cjs', 'opencode-cooperative-tool.js')) + (
    'scripts/opencode_session.py', 'scripts/opencode_session.cjs',
    'scripts/smoke_opencode_cooperation.cjs', 'third_party/opencode.json',
    'third_party/opencode-LICENSE.txt', 'patches/opencode-no-runtime-installs.patch',
    'LICENSE', 'THIRD_PARTY_LICENSES.md')
PROPOSAL_SOURCES = SOURCES + ('src/public-code-result.cjs', 'src/public-code-file.cjs',
    'src/workspace-verifier.cjs', 'scripts/smoke_opencode_inference.cjs',
    'scripts/smoke_public_code_proposal.cjs')


def require(value, reason):
    if not value:
        raise ValueError(reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def owned_file(path, maximum):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical_input')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1 and not info.st_mode & 0o6022
            and 0 < info.st_size <= maximum, 'owned_regular_input')
    return info


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def output_path(path, prefix='opencode-cooperative-inputs'):
    require(prefix in ('opencode-cooperative-inputs', 'public-code-proposal-inputs'), 'bundle_kind')
    require(path.is_absolute() and path.resolve() == path
            and path.parent == ROOT / 'build' and path.parent.is_dir()
            and re.fullmatch(prefix + r'-[A-Za-z0-9-]{1,64}', path.name)
            and not path.exists() and not path.is_symlink(), 'new_workspace_bundle')
    return path


def blobs(revision, sources=SOURCES):
    require(re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'exact_code_revision')
    result = {}
    for name in sources:
        data = subprocess.run(['git', '-C', str(ROOT), 'cat-file', 'blob', revision + ':' + name],
            check=True, capture_output=True, timeout=15).stdout
        require(0 < len(data) <= 2 * 1024**2, 'source_bound')
        result['code/' + name] = data
    return result


def pack(args):
    output_path(args.output)
    source = blobs(args.code_revision)
    pin = json.loads(source['code/third_party/opencode.json'])
    require(pin['commit'] == PIN and pin['tag'] == 'v1.18.34'
            and pin['local_patch'] == 'patches/opencode-no-runtime-installs.patch', 'source_runtime_pin')
    owned_file(args.build_report, 65536)
    build_raw = args.build_report.read_bytes()
    build = json.loads(build_raw)
    binary = Path(build['binary'])
    binary_info = owned_file(binary, 200 * 1024**2)
    require(build['version'] == 1 and build['source_build'] is True and build['source_commit'] == PIN
            and build['runtime_version'] == '1.18.34' and build['lock_sha256'] == pin['bun_lock_sha256']
            and build['patch_sha256'] == sha(source['code/' + pin['local_patch']])
            and build['license_sha256'] == sha(source['code/third_party/opencode-LICENSE.txt'])
            and build['binary_bytes'] == binary_info.st_size
            and build['binary_sha256'] == digest(binary) and os.access(binary, os.X_OK), 'source_build_binding')
    node_license = args.node.parent.parent / 'LICENSE'
    for candidate, expected in ((args.node, NODE), (node_license, NODE_LICENSE)):
        require(owned_file(candidate, 200 * 1024**2).st_size == expected[0]
                and digest(candidate) == expected[1], 'exact_node_input')
    require(os.access(args.node, os.X_OK), 'node_executable')
    source['runtime/build-report.json'] = build_raw
    inputs = {'runtime/opencode': (binary, build['binary_sha256']),
              'runtime/node': (args.node, NODE[1]), 'runtime/node-LICENSE': (node_license, NODE_LICENSE[1])}
    return capture(args, source, inputs, dict(version=1, kind='opencode-cooperative-inputs',
        code_revision=args.code_revision, opencode_revision=PIN,
        opencode_binary_sha256=build['binary_sha256'], node_version=NODE_VERSION))


def pack_proposal(args):
    output_path(args.output, 'public-code-proposal-inputs')
    source = blobs(args.code_revision, PROPOSAL_SOURCES)
    node_license = args.node.parent.parent / 'LICENSE'
    for candidate, expected in ((args.node, NODE), (node_license, NODE_LICENSE)):
        require(owned_file(candidate, 200 * 1024**2).st_size == expected[0]
                and digest(candidate) == expected[1], 'exact_node_input')
    require(os.access(args.node, os.X_OK), 'node_executable')
    inputs = {'runtime/node': (args.node, NODE[1]), 'runtime/node-LICENSE': (node_license, NODE_LICENSE[1])}
    return capture(args, source, inputs, dict(version=1, kind='public-code-proposal-inputs',
        code_revision=args.code_revision, node_version=NODE_VERSION))


def capture(args, source, inputs, manifest):
    # A partial capture has no INPUTS.json and is never an accepted executable bundle.
    # Retain it for inspection rather than recursively removing an operator's path.
    args.output.mkdir(mode=0o700)
    inventory = {}
    for name in sorted(set(source) | set(inputs)):
        target = args.output / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        mode = 0o700 if name in ('runtime/opencode', 'runtime/node') else 0o600
        with target.open('xb') as stream:
            if name in source:
                stream.write(source[name])
            else:
                with inputs[name][0].open('rb') as original:
                    while chunk := original.read(1024**2):
                        stream.write(chunk)
        target.chmod(mode)
        actual = digest(target)
        require(actual == (sha(source[name]) if name in source else inputs[name][1]), 'capture_changed')
        inventory[name] = dict(bytes=target.stat().st_size, sha256=actual, mode=mode)
    manifest['files'] = inventory
    encoded = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    with (args.output / 'INPUTS.json').open('xb') as stream:
        stream.write(encoded)
    (args.output / 'INPUTS.json').chmod(0o600)
    return dict(packed=True, manifest_sha256=sha(encoded), code_revision=args.code_revision,
        files=len(inventory), bytes=sum(row['bytes'] for row in inventory.values()),
        actual_runtime_execution=False, actual_peer_execution=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--public-code-proposal', action='store_true')
    parser.add_argument('--code-revision')
    for name in ('node', 'build-report', 'output'):
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps(dict(execute=False, plan='capture_exact_code_blobs_and_existing_source_build',
                             downloads=False, runtime_execution=False, network_participation=False)))
        return
    required = ('code_revision', 'node', 'output') if args.public_code_proposal else ('code_revision', 'node', 'build_report', 'output')
    require(all(getattr(args, name) is not None for name in required),
            'explicit_capture_inputs')
    if args.public_code_proposal:
        require(args.build_report is None, 'proposal_has_no_local_planner')
    print(json.dumps(pack_proposal(args) if args.public_code_proposal else pack(args)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps(dict(packed=False, failure='input_or_capture_failed')))
        raise SystemExit(1)
