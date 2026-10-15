#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Fixed guest task lifetime: observe the original cgroup before its last exit.

The Node task, its permissions, private cleanup and result are unchanged. This
helper joins that child, then stays alone in the original bounded task cgroup
until its owner has read the real counters. Readiness is not task acceptance.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

CONTROL = 'task-observation.sock'
FRAME_MAX = 1024
TASK_SECONDS = 2550
OWNER_SECONDS = 2565


def require(value, reason='task_holder_contract'):
    if not value:
        raise ValueError(reason)


def remaining(deadline):
    require(type(deadline) is int and 0 < deadline < 2 ** 63)
    seconds = (deadline - time.monotonic_ns()) / 1_000_000_000
    require(0 < seconds <= OWNER_SECONDS, 'task_holder_deadline')
    return seconds


def binding(kind, nonce, status, receipt):
    require(kind in ('ready', 'release') and type(nonce) is str
            and re.fullmatch('[0-9a-f]{64}', nonce))
    require(type(status) is int and -64 <= status <= 255
            and (receipt is None or type(receipt) is str and re.fullmatch('[0-9a-f]{64}', receipt)))
    return (json.dumps(dict(version=1, kind='task_' + kind, nonce=nonce,
                           child_returncode=status, receipt_sha256=receipt),
                       sort_keys=True, separators=(',', ':')) + '\n').encode()


def decode_ready(raw, nonce):
    # Re-encoding also rejects duplicate/extra keys, bools, whitespace and EOF
    # ambiguity. The peer is a fixed source-bound helper, never a remote client.
    value = json.loads(raw)
    require(type(value) is dict)
    expected = binding('ready', nonce, value.get('child_returncode'), value.get('receipt_sha256'))
    require(raw == expected, 'task_holder_binding')
    return value


def send_frame(channel, raw, deadline):
    require(type(raw) is bytes and 0 < len(raw) <= FRAME_MAX)
    channel.settimeout(remaining(deadline))
    channel.sendall(raw)
    channel.shutdown(socket.SHUT_WR)


def receive_frame(channel, deadline):
    raw = bytearray()
    while True:
        channel.settimeout(remaining(deadline))
        block = channel.recv(FRAME_MAX + 1 - len(raw))
        if not block:
            require(0 < len(raw) <= FRAME_MAX, 'task_holder_frame')
            return bytes(raw)
        raw.extend(block)
        require(len(raw) <= FRAME_MAX, 'task_holder_frame')


def peer(channel, pid):
    require(type(pid) is int and 1 < pid < 2 ** 31)
    observed = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(observed == (pid, os.getuid(), os.getgid()), 'task_holder_peer')


def identity(info):
    return info.st_dev, info.st_ino


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def receipt_bytes(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'task_holder_receipt')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                and 0 < before.st_size <= 32768, 'task_holder_receipt')
        raw = stream.read(32769)
        after = os.fstat(stream.fileno())
        require(len(raw) == before.st_size and file_identity(before) == file_identity(after)
                and identity(path.lstat()) == identity(before), 'task_holder_receipt_changed')
        return raw


class Group:
    """One fixed task directory, held across both live-member and counter reads."""
    def __init__(self, path, pid):
        require(path.is_absolute() and path.resolve(strict=True) == path, 'task_holder_cgroup')
        self.path, self.pid = path, pid
        self.parent = identity(path.parent.lstat())
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.bound = identity(os.fstat(self.fd))

    def close(self):
        os.close(self.fd)

    def check(self):
        require(identity(self.path.parent.lstat()) == self.parent
                and identity(self.path.lstat()) == self.bound
                and stat.S_ISDIR(self.path.lstat().st_mode)
                and identity(os.fstat(self.fd)) == self.bound, 'task_holder_cgroup_changed')

    def read(self, name):
        require(name in ('memory.events', 'memory.max', 'memory.swap.max', 'memory.peak'))
        self.check()
        with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                               dir_fd=self.fd), 'rb') as stream:
            require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'task_holder_counter')
            raw = stream.read(4097)
            require(0 < len(raw) <= 4096, 'task_holder_counter')
        self.check()
        return raw

    def alone(self):
        self.check()
        paths = []
        for path in self.path.rglob('cgroup.procs'):
            require(len(paths) < 16 and path.resolve(strict=True) == path, 'task_holder_members')
            paths.append(path)
        require(self.path / 'cgroup.procs' in paths, 'task_holder_members')
        members = []
        for path in paths:
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC), 'rb') as stream:
                require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'task_holder_members')
                raw = stream.read(4097)
            require(len(raw) <= 4096 and all(re.fullmatch(rb'[0-9]{1,10}', row) for row in raw.splitlines()),
                    'task_holder_members')
            members.extend(int(row) for row in raw.splitlines())
        require(members == [self.pid], 'task_holder_members')
        self.check()

    def memory(self):
        self.alone()
        rows = [line.split() for line in self.read('memory.events').splitlines()]
        require(rows and all(len(row) == 2 and re.fullmatch(rb'[0-9]{1,20}', row[1]) for row in rows),
                'task_holder_counter')
        events = dict(rows)
        require(len(events) == len(rows) and b'oom_kill' in events, 'task_holder_counter')
        value = {}
        for key, name in (('maximum', 'memory.max'), ('swap', 'memory.swap.max'), ('peak', 'memory.peak')):
            raw = self.read(name)
            require(re.fullmatch(rb'[0-9]{1,20}\n?', raw), 'task_holder_counter')
            value[key] = int(raw)
        value['oom_kill'] = int(events[b'oom_kill'])
        self.alone()
        return value


def hold(command, path, receipt, nonce, deadline, parent_pid):
    """Internal seam for inert child tests; the executable CLI never accepts argv."""
    remaining(deadline)
    binding('ready', nonce, 0, None)
    child = subprocess.Popen(command)
    status = None
    try:
        status = child.wait(timeout=remaining(deadline))
        try:
            digest = hashlib.sha256(receipt_bytes(receipt)).hexdigest()
        except (OSError, ValueError, TypeError):
            # Preserve the joined child's original status even when receipt
            # ownership, metadata or readability fails. Null is no task proof.
            digest = None
        info = path.lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600, 'task_holder_socket')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            channel.settimeout(remaining(deadline))
            channel.connect(str(path))
            peer(channel, parent_pid)
            send_frame(channel, binding('ready', nonce, status, digest), deadline)
            require(receive_frame(channel, deadline) == binding('release', nonce, status, digest),
                    'task_holder_release')
        return status if status != 0 or digest is not None else 1
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        # An observation failure cannot turn a failed task into a success or
        # overwrite its actual nonzero/signal status. A successful task remains
        # non-accepted when the bounded release protocol fails.
        return status if status not in (None, 0) else 1
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deadline-monotonic-ns', type=int, required=True)
    parser.add_argument('--handshake-nonce', required=True)
    parser.add_argument('--parent-pid', type=int, required=True)
    parser.add_argument('--inference-backend', choices=('llama_cpp_bf16_v1',), required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('task_holder_trial', Path(__file__).with_name('smoke_opencode_inference.py'))
    trial = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(trial)
    require(os.getuid() > 0 and trial.pwd.getpwuid(os.getuid()).pw_name == 'vpci'
            and socket.gethostname() == 'volparossa-alpha'
            and trial.run(['systemd-detect-virt', '--vm'], text=True).stdout.strip() == 'kvm',
            'disposable_guest_required')
    require(remaining(args.deadline_monotonic_ns) <= TASK_SECONDS)
    binding('ready', args.handshake_nonce, 0, None)
    status = hold(trial.task_arguments(args.inference_backend), trial.BASE / CONTROL,
                  trial.BASE / 'task.json', args.handshake_nonce, args.deadline_monotonic_ns, args.parent_pid)
    if status < 0:
        # Preserve systemd Result=signal/ExecMainStatus for this own process only.
        if -status not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(-status, signal.SIG_DFL)
        os.kill(os.getpid(), -status)
    return status


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        sys.exit(1)
