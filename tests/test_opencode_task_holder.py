# SPDX-License-Identifier: GPL-3.0-only
"""Inert real-child/socket/counter fixtures, never systemd, a VM or a model."""
import ast
from contextlib import ExitStack
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


H = module('opencode_task_holder')
T = module('smoke_opencode_inference')
NONCE = 'a' * 64
HASH = 'b' * 64
BACKEND = 'llama_cpp_bf16_v1'


def deadline(seconds=5):
    return time.monotonic_ns() + int(seconds * 1e9)


def counters(root, pid):
    root.mkdir()
    for name, value in {'cgroup.procs': str(pid), 'memory.max': str(768 * 1024**2),
                        'memory.swap.max': '0', 'memory.peak': '123456',
                        'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0'}.items():
        (root / name).write_text(value + '\n')


# The test-only runner imports the real helper and uses only a harmless Python
# child. Production main has no command/path option and requires the fixed VM.
RUNNER = '''import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('holder',sys.argv[1]); h=importlib.util.module_from_spec(s); s.loader.exec_module(h)
status=h.hold(json.loads(sys.argv[2]),pathlib.Path(sys.argv[3]),pathlib.Path(sys.argv[4]),sys.argv[5],int(sys.argv[6]),int(sys.argv[7]))
sys.exit(status)
'''


class Cases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vp-task-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.receipt = self.root / 'task.json'
        self.receipt.write_bytes(b'{"inert":true}\n')
        self.receipt.chmod(0o600)
        self.processes = []
        self.addCleanup(self.join_children)

    def join_children(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)

    def spawn(self, path, *, status=0, nonce=NONCE, until=None, command=None):
        command = command or [sys.executable, '-B', '-c', f'raise SystemExit({status})']
        process = subprocess.Popen([sys.executable, '-B', '-c', RUNNER,
            str(ROOT / 'scripts/opencode_task_holder.py'), json.dumps(command), str(path),
            str(self.receipt), nonce, str(until or deadline()), str(os.getpid())],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def listener(self):
        path = self.root / H.CONTROL
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(str(path))
        path.chmod(0o600)
        server.listen(1)
        server.settimeout(3)
        return path, server

    def test_frame_roundtrip_and_closed_shape(self):
        raw = H.binding('ready', NONCE, 0, HASH)
        self.assertEqual(H.decode_ready(raw, NONCE)['receipt_sha256'], HASH)
        value = json.loads(raw)
        alternatives = [raw.replace(b'"version":1', b'"version":true'), raw + b' ',
                        raw.replace(b'"version":1', b'"version":1,"version":1'),
                        json.dumps(value | {'extra': 'private-canary'}).encode()]
        for key, bad in [('kind', 'task_release'), ('version', 2), ('nonce', 'c' * 64),
                         ('child_returncode', True), ('child_returncode', 256),
                         ('receipt_sha256', 'private-canary')]:
            alternatives.append((json.dumps(value | {key: bad}, sort_keys=True, separators=(',', ':')) + '\n').encode())
        for raw in alternatives:
            with self.subTest(raw=raw), self.assertRaises((ValueError, TypeError)):
                H.decode_ready(raw, NONCE)
        for key in value:
            with self.subTest(missing=key), self.assertRaises(ValueError):
                H.decode_ready(json.dumps({k: v for k, v in value.items() if k != key}).encode(), NONCE)

    def test_frame_eof_bound_and_original_absolute_deadline(self):
        for raw in (b'', b'x' * (H.FRAME_MAX + 1)):
            left, right = socket.socketpair()
            with left, right:
                left.sendall(raw)
                left.shutdown(socket.SHUT_WR)
                with self.assertRaises(ValueError):
                    H.receive_frame(right, deadline())
        for until in (True, 0, deadline(-1), deadline(3000)):
            with self.assertRaises(ValueError):
                H.remaining(until)
        left, right = socket.socketpair()
        with left, right, self.assertRaises(TimeoutError):
            H.receive_frame(right, deadline(.03))

    def test_peer_binds_pid_uid_gid(self):
        left, right = socket.socketpair()
        with left, right:
            H.peer(right, os.getpid())
            with self.assertRaisesRegex(ValueError, 'task_holder_peer'):
                H.peer(right, os.getpid() + 100000)

    def test_joined_child_holds_original_group_until_exact_owner_release(self):
        path, server = self.listener()
        process = self.spawn(path)
        channel, _ = server.accept()
        with channel:
            H.peer(channel, process.pid)
            ready = H.decode_ready(H.receive_frame(channel, deadline()), NONCE)
            self.assertEqual(ready['child_returncode'], 0)
            self.assertEqual(ready['receipt_sha256'], hashlib.sha256(self.receipt.read_bytes()).hexdigest())
            self.assertIsNone(process.poll())
            group_path = self.root / 'group'
            counters(group_path, process.pid)
            group = H.Group(group_path, process.pid)
            try:
                self.assertEqual(group.memory(), dict(maximum=768 * 1024**2, swap=0, peak=123456, oom_kill=0))
            finally:
                group.close()
            self.assertIsNone(process.poll())
            H.send_frame(channel, H.binding('release', NONCE, 0, ready['receipt_sha256']), deadline())
        self.assertEqual(process.wait(timeout=3), 0)

    def test_wrong_release_and_owner_eof_fail_closed(self):
        for raw in (b'', H.binding('release', 'c' * 64, 0, HASH)):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory(dir=self.root) as folder:
                path = Path(folder) / H.CONTROL
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                    server.bind(str(path)); path.chmod(0o600); server.listen(1); server.settimeout(3)
                    process = self.spawn(path)
                    channel, _ = server.accept()
                    with channel:
                        H.receive_frame(channel, deadline())
                        channel.sendall(raw); channel.shutdown(socket.SHUT_WR)
                    self.assertEqual(process.wait(timeout=3), 1)

    def test_nonzero_child_status_survives_failed_release(self):
        path, server = self.listener()
        process = self.spawn(path, status=17)
        channel, _ = server.accept()
        with channel:
            ready = H.decode_ready(H.receive_frame(channel, deadline()), NONCE)
            self.assertEqual(ready['child_returncode'], 17)
            channel.shutdown(socket.SHUT_WR)
        self.assertEqual(process.wait(timeout=3), 17)

    def test_failed_child_without_receipt_still_reports_original_status(self):
        self.receipt.unlink()
        path, server = self.listener()
        process = self.spawn(path, status=19)
        channel, _ = server.accept()
        with channel:
            ready = H.decode_ready(H.receive_frame(channel, deadline()), NONCE)
            self.assertIsNone(ready['receipt_sha256'])
            H.send_frame(channel, H.binding('release', NONCE, 19, None), deadline())
        self.assertEqual(process.wait(timeout=3), 19)

    def test_signal_status_is_closed_and_propagated_only_to_holder_itself(self):
        path, server = self.listener()
        process = self.spawn(path, command=[sys.executable, '-B', '-c',
                            'import os,signal; os.kill(os.getpid(), signal.SIGTERM)'])
        channel, _ = server.accept()
        with channel:
            ready = H.decode_ready(H.receive_frame(channel, deadline()), NONCE)
            self.assertEqual(ready['child_returncode'], -signal.SIGTERM)
            H.send_frame(channel, H.binding('release', NONCE, -signal.SIGTERM,
                                          ready['receipt_sha256']), deadline())
        # The inert runner exits normally with the negative result; production
        # main instead reproduces the signal on its own process, tested below.
        process.wait(timeout=3)
        trial = SimpleNamespace(BASE=self.root, task_arguments=lambda _: ['fixed-node-command'],
            pwd=SimpleNamespace(getpwuid=lambda _: SimpleNamespace(pw_name='vpci')),
            run=lambda *a, **kw: SimpleNamespace(stdout='kvm\n'))
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
        argv = ['holder', '--deadline-monotonic-ns', str(deadline()), '--handshake-nonce', NONCE,
                '--parent-pid', str(os.getpid()), '--inference-backend', BACKEND]
        with patch.object(sys, 'argv', argv), patch.object(H.importlib.util, 'spec_from_file_location', return_value=spec), \
                patch.object(H.importlib.util, 'module_from_spec', return_value=trial), \
                patch.object(H.os, 'getuid', return_value=985), \
                patch.object(H.socket, 'gethostname', return_value='volparossa-alpha'), \
                patch.object(H, 'hold', return_value=-signal.SIGTERM), \
                patch.object(H.signal, 'signal') as handler, patch.object(H.os, 'kill') as kill:
            self.assertEqual(H.main(), -signal.SIGTERM)
            handler.assert_called_once_with(signal.SIGTERM, signal.SIG_DFL)
            kill.assert_called_once_with(os.getpid(), signal.SIGTERM)

    def test_success_without_receipt_retains_status_but_cannot_succeed(self):
        self.receipt.unlink()
        path, server = self.listener()
        process = self.spawn(path)
        channel, _ = server.accept()
        with channel:
            ready = H.decode_ready(H.receive_frame(channel, deadline()), NONCE)
            self.assertEqual(ready['child_returncode'], 0)
            self.assertIsNone(ready['receipt_sha256'])
            H.send_frame(channel, H.binding('release', NONCE, 0, None), deadline())
        self.assertEqual(process.wait(timeout=3), 1)

    def test_original_deadline_terminates_and_joins_running_child(self):
        pidfile = self.root / 'child.pid'
        command = [sys.executable, '-B', '-c',
                   'import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)',
                   str(pidfile)]
        process = self.spawn(self.root / H.CONTROL, until=deadline(.3), command=command)
        self.assertEqual(process.wait(timeout=3), 1)
        pid = int(pidfile.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_receipt_permissions_links_and_bounds_are_real(self):
        self.assertEqual(H.receipt_bytes(self.receipt), b'{"inert":true}\n')
        self.receipt.chmod(0o644)
        with self.assertRaises(ValueError): H.receipt_bytes(self.receipt)
        self.receipt.chmod(0o600)
        linked = self.root / 'linked'; os.link(self.receipt, linked)
        with self.assertRaises(ValueError): H.receipt_bytes(self.receipt)
        linked.unlink(); linked.symlink_to(self.receipt)
        with self.assertRaises(ValueError): H.receipt_bytes(linked)
        for content in (b'', b'x' * 32769):
            self.receipt.write_bytes(content)
            with self.assertRaises(ValueError): H.receipt_bytes(self.receipt)

    def test_receipt_foreign_uid_and_path_replacement_rejected(self):
        original = H.os.fstat
        def foreign(fd):
            values = list(original(fd)); values[4] += 1
            return os.stat_result(values)
        with patch.object(H.os, 'fstat', side_effect=foreign), self.assertRaises(ValueError):
            H.receipt_bytes(self.receipt)
        original_lstat = Path.lstat
        def replaced(path):
            if path == self.receipt:
                values = list(original_lstat(path)); values[1] += 1
                return os.stat_result(values)
            return original_lstat(path)
        with patch.object(Path, 'lstat', replaced), self.assertRaises(ValueError):
            H.receipt_bytes(self.receipt)

    def test_group_missing_malformed_duplicate_and_linked_counters_rejected(self):
        path = self.root / 'group'; counters(path, os.getpid())
        group = H.Group(path, os.getpid())
        try:
            for name, content in [('memory.max', 'max\n'), ('memory.peak', '-1\n'),
                                  ('memory.events', 'oom_kill 0\noom_kill 0\n'),
                                  ('memory.events', 'oom 0\n'), ('memory.events', 'oom_kill unknown\n')]:
                target = path / name; old = target.read_bytes(); target.write_text(content)
                with self.subTest(name=name, content=content), self.assertRaises(ValueError): group.memory()
                target.write_bytes(old)
            target = path / 'memory.peak'; target.unlink()
            with self.assertRaises(FileNotFoundError): group.memory()
            target.symlink_to(self.receipt)
            with self.assertRaises(OSError): group.memory()
        finally:
            group.close()

    def test_group_rejects_extra_descendant_or_foreign_members(self):
        path = self.root / 'group'; counters(path, os.getpid())
        group = H.Group(path, os.getpid())
        try:
            for members in ('', '1\n', f'{os.getpid()}\n1\n'):
                (path / 'cgroup.procs').write_text(members)
                with self.assertRaises(ValueError): group.memory()
            (path / 'cgroup.procs').write_text(str(os.getpid()))
            child = path / 'child'; child.mkdir(); (child / 'cgroup.procs').write_text('1\n')
            with self.assertRaises(ValueError): group.memory()
        finally: group.close()

    def test_group_rejects_replaced_path_or_parent_identity(self):
        parent = self.root / 'parent'; parent.mkdir()
        path = parent / 'group'; counters(path, os.getpid())
        group = H.Group(path, os.getpid())
        try:
            path.rename(parent / 'old'); counters(path, os.getpid())
            with self.assertRaisesRegex(ValueError, 'cgroup_changed'): group.memory()
        finally: group.close()
        group = H.Group(path, os.getpid())
        try:
            parent.rename(self.root / 'old-parent'); parent.mkdir(); counters(path, os.getpid())
            with self.assertRaisesRegex(ValueError, 'cgroup_changed'): group.memory()
        finally: group.close()

    def run_parent(self, *, status=0, broken_counter=False, release_error=False, mismatch=False,
                   receipt_changed=False, interrupted=False, receipt_mode=0o600, malformed=False):
        task = dict(version=2, output_constraint=T.OUTPUT_CONSTRAINT, model_profile=T.LARGE_MODEL, passed=status == 0)
        self.receipt.write_text('{invalid private fixture' if malformed else json.dumps(task))
        self.receipt.chmod(receipt_mode)
        group_path = self.root / 'group'
        process = None
        starts = []
        def start(name, command, limit, seconds):
            nonlocal process
            starts.append((name, command, limit, seconds))
            values = dict(zip(command[3::2], command[4::2]))
            process = self.spawn(self.root / H.CONTROL, status=status,
                                 nonce=values['--handshake-nonce'], until=int(values['--deadline-monotonic-ns']))
            counters(group_path, process.pid)
            if broken_counter: (group_path / 'memory.peak').unlink()
        def properties(name):
            rc = process.poll()
            if rc is None: return dict(ActiveState='active', SubState='running', MainPID=str(process.pid))
            # Reproduce the original systemd lifetime: after its last process
            # leaves, the task cgroup may disappear despite RemainAfterExit.
            for path in group_path.iterdir(): path.unlink()
            group_path.rmdir()
            return dict(ActiveState='active', SubState='exited', MainPID='0',
                        Result='success' if rc == 0 else 'exit-code', ExecMainStatus=str(rc + int(mismatch)))
        report = {}
        profile = T.trial_profile(T.LARGE_MODEL, BACKEND)
        with ExitStack() as stack:
            for key, value in dict(BASE=self.root, INPUT=self.root / 'inputs', module=lambda *_: H,
                start=start, properties=properties, cgroup=lambda _: group_path, empty=lambda _: process.poll() is not None,
                memory=lambda _: dict(maximum=11 * T.GIB, swap=0, peak=123, oom_kill=0)).items():
                stack.enter_context(patch.object(T, key, value))
            if release_error:
                stack.enter_context(patch.object(H, 'send_frame', side_effect=OSError('synthetic release')))
            if receipt_changed:
                stack.enter_context(patch.object(H, 'receipt_bytes', return_value=b'changed private fixture'))
            if interrupted:
                stack.enter_context(patch.object(H.Group, 'memory', side_effect=KeyboardInterrupt))
            try:
                T.run_native_task(profile, BACKEND, report)
            except BaseException as error:
                return report, error, process, starts
        return report, None, process, starts

    def test_real_parent_socket_group_observation_and_release_chain(self):
        report, error, process, starts = self.run_parent()
        self.assertIsNone(error)
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertTrue(report['task']['passed'])
        self.assertEqual(report['task_exit_status'], 0)
        self.assertEqual(report['task_unit_result'], 'success')
        self.assertEqual(report['task_memory']['peak'], 123456)
        self.assertFalse((self.root / 'group').exists())
        # Same post-exit observation as the original implementation now fails:
        with patch.object(T, 'cgroup', return_value=self.root / 'group'), self.assertRaises(FileNotFoundError):
            T.memory(T.TASK_UNIT)
        self.assertEqual(starts[0][2:], (768 * 1024**2, 2550))

    def test_missing_counter_preserves_task_status_but_never_accepts(self):
        report, error, process, _ = self.run_parent(broken_counter=True)
        self.assertIsInstance(error, FileNotFoundError)
        self.assertEqual(report['task_exit_status'], 0)
        self.assertTrue(report['task']['passed'])
        self.assertNotIn('task_memory', report)
        self.assertNotIn('task_unit_result', report)
        self.assertEqual(process.wait(timeout=3), 0)

    def test_release_failure_cannot_mask_first_observation_error(self):
        report, error, process, _ = self.run_parent(broken_counter=True, release_error=True)
        self.assertIsInstance(error, FileNotFoundError)
        self.assertNotIn('task_memory', report)
        self.assertEqual(process.wait(timeout=3), 1)

    def test_failed_child_survives_parent_counter_failure(self):
        report, error, process, _ = self.run_parent(status=17, broken_counter=True)
        self.assertIsInstance(error, FileNotFoundError)
        self.assertEqual(report['task_exit_status'], 17)
        self.assertFalse(report['task']['passed'])
        self.assertEqual(process.wait(timeout=3), 17)

    def test_failed_child_with_invalid_receipt_mode_retains_status(self):
        report, error, process, _ = self.run_parent(status=17, receipt_mode=0o644)
        self.assertIsNone(error)
        self.assertEqual(report['task_exit_status'], 17)
        self.assertEqual(report['task_unit_result'], 'exit-code')
        self.assertNotIn('task', report)
        self.assertEqual(process.wait(timeout=3), 17)
        # The unchanged guest task acceptance gate still refuses this result.
        self.assertFalse(report['task_exit_status'] == 0 and report.get('task', {}).get('passed') is True)

    def test_successful_child_with_invalid_receipt_mode_is_not_accepted(self):
        report, error, process, _ = self.run_parent(receipt_mode=0o644)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), 'task_holder_missing_success_receipt')
        self.assertEqual(report['task_exit_status'], 0)
        self.assertNotIn('task', report)
        self.assertNotIn('task_unit_result', report)
        self.assertEqual(process.wait(timeout=3), 1)

    def test_failed_child_with_malformed_json_retains_status(self):
        report, error, process, _ = self.run_parent(status=17, malformed=True)
        self.assertIsInstance(error, json.JSONDecodeError)
        self.assertEqual(report['task_exit_status'], 17)
        self.assertNotIn('task', report)
        self.assertNotIn('task_unit_result', report)
        self.assertEqual(process.wait(timeout=3), 17)

    def test_successful_child_with_malformed_json_is_not_accepted(self):
        report, error, process, _ = self.run_parent(malformed=True)
        self.assertIsInstance(error, json.JSONDecodeError)
        self.assertEqual(report['task_exit_status'], 0)
        self.assertNotIn('task', report)
        self.assertNotIn('task_unit_result', report)
        # Holder exit preserves the actual successful child exit, but the
        # parent rejected the receipt and never accepted a completed trial.
        self.assertEqual(process.wait(timeout=3), 0)

    def test_terminal_unit_must_match_joined_child(self):
        report, error, process, _ = self.run_parent(mismatch=True)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), 'task_holder_exit')
        self.assertEqual(process.wait(timeout=3), 0)

    def test_receipt_hash_mismatch_releases_holder_but_refuses_task(self):
        report, error, process, _ = self.run_parent(receipt_changed=True)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), 'task_receipt_changed')
        self.assertNotIn('task', report)
        self.assertNotIn('task_memory', report)
        self.assertEqual(process.wait(timeout=3), 0)

    def test_owner_interruption_releases_holder_without_accepting(self):
        report, error, process, _ = self.run_parent(interrupted=True)
        self.assertIsInstance(error, KeyboardInterrupt)
        self.assertNotIn('task_memory', report)
        self.assertNotIn('task_unit_result', report)
        self.assertEqual(process.wait(timeout=3), 0)

    def test_release_failure_after_valid_counters_still_refuses_completion(self):
        report, error, process, _ = self.run_parent(release_error=True)
        self.assertIsInstance(error, OSError)
        self.assertIn('task_memory', report)
        self.assertNotIn('task_unit_result', report)
        self.assertEqual(process.wait(timeout=3), 1)

    def test_wiring_native_only_fixed_command_original_caps_and_cleanup(self):
        parent = inspect.getsource(T.run_native_task)
        self.assertIn('started + 2550 * 1_000_000_000', parent)
        self.assertIn('started + 2565 * 1_000_000_000', parent)
        self.assertEqual(parent.count('start(TASK_UNIT,'), 1)
        self.assertNotIn('task_arguments(', parent)
        main = inspect.getsource(H.main)
        self.assertIn("choices=('llama_cpp_bf16_v1',)", main)
        self.assertIn("trial.task_arguments(args.inference_backend)", main)
        self.assertIn("trial.BASE / 'task.json'", main)
        self.assertIn("'volparossa-alpha'", main)
        self.assertIn("'vpci'", main)
        self.assertIn('os.kill(os.getpid(), -status)', main)
        self.assertIn("'scripts/opencode_task_holder.py'", inspect.getsource(T.pack))
        guest = inspect.getsource(T.guest)
        self.assertIn("if backend != 'torch':\n            run_native_task(profile, backend, report)\n        else:", guest)
        self.assertIn("require(report['task_exit_status'] == 0 and report.get('task', {}).get('passed') is True", guest)
        final = guest.split('    finally:', 1)[1]
        self.assertIn("unit(name, 'stop', check=False)", final)
        self.assertIn('empty(name)', final)
        # No command/path/limit CLI parameter was introduced in the helper.
        parser = ast.parse(main)
        options = [node.args[0].value for node in ast.walk(parser) if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_argument']
        self.assertEqual(set(options), {'--deadline-monotonic-ns', '--handshake-nonce', '--parent-pid', '--inference-backend'})

    def test_final_cleanup_preserves_live_native_task_sample_without_skipping_stop(self):
        tree = ast.parse(inspect.getsource(T.guest))
        condition = next(node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Name) and target.id == 'observed_task'
                                 for target in node.targets))
        for backend in ('torch', BACKEND):
            for name in (T.TASK_UNIT, T.CORE_UNIT, T.NATIVE_UNIT):
                for observed in (False, True):
                    skip = eval(compile(ast.Expression(condition), '<original-cleanup-condition>', 'eval'),
                                dict(backend=backend, name=name, TASK_UNIT=T.TASK_UNIT,
                                     report={'task_memory': {}} if observed else {}))
                    self.assertEqual(skip, backend == BACKEND and name == T.TASK_UNIT and observed)
        # Stop remains outside the observation guard; a missing observation is
        # not replaced with zero and cannot skip the original cleanup.
        units = next(node for node in ast.walk(tree) if isinstance(node, ast.For)
                     and isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name)
                     and node.iter.func.id == 'reversed')
        self.assertIsInstance(units.body[-1], ast.Expr)
        self.assertEqual(units.body[-1].value.func.id, 'unit')


if __name__ == '__main__':
    unittest.main()
