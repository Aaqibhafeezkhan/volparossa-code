# SPDX-License-Identifier: GPL-3.0-only
"""Inert real-file/descriptor/thread tests, never a cgroup or QEMU launch."""
import copy
import importlib.util
import inspect
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


M = module('opencode_qemu_memory')
TRIAL = module('smoke_opencode_inference')
CI = module('opencode_ci')
UNIT = 'volparossa-opencode-vm-' + 'a' * 12 + '.service'
GROUP = '/user.slice/user-1000.slice/' + UNIT
SOURCE = dict(code_revision='a' * 40, core_revision=TRIAL.NATIVE_CORE,
              model_profile=TRIAL.LARGE_MODEL, inference_backend='llama_cpp_bf16_v1')


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.group = self.root / GROUP[1:]
        self.group.mkdir(parents=True, mode=0o700)
        for directory in (self.root / 'user.slice', self.group.parent):
            directory.chmod(0o700)
        self.patch = patch.object(M, 'CGROUP_ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.files = {'memory.current': '100', 'memory.peak': '200', 'memory.max': str(13 * 1024**3),
                      'memory.swap.current': '0', 'memory.events': 'max 3\noom 2\noom_kill 1\noom_group_kill 0\n',
                      'memory.events.local': 'max 1\noom 0\noom_kill 1\noom_group_kill 0\n',
                      'memory.stat': '\n'.join(f'{key} {index}' for index, key in enumerate(M.STAT_KEYS))}
        for name, value in self.files.items():
            self.write(name, value)

    def write(self, name, value):
        path = self.group / name
        path.write_text(value)
        path.chmod(0o600)

    def reader(self):
        reader = M.Reader(GROUP, UNIT)
        self.addCleanup(reader.close)
        return reader

    def receipt(self):
        observer = M.Observer(GROUP, UNIT, SOURCE)
        result = observer.finish()
        self.assertTrue(result['observer_joined'])
        self.assertFalse(observer.reader.fds)
        return M.validate(result)

    def test_real_readonly_descriptor_chain_and_exact_counters(self):
        reader = self.reader()
        self.assertTrue(all(not os.get_inheritable(fd) for fd in reader.fds))
        sample = reader.sample(23)
        self.assertEqual(sample['state'], 'observed')
        self.assertEqual(sample['current_bytes'], 100)
        self.assertEqual(sample['peak_bytes'], 200)
        self.assertEqual(sample['events']['oom'], 2)
        self.assertEqual(sample['events_local']['oom'], 0)
        self.assertEqual(set(sample['stat']), set(M.STAT_KEYS))
        self.assertNotIn(str(self.root), json.dumps(sample))
        self.assertEqual({name: (self.group / name).read_text() for name in self.files}, self.files)

    def test_missing_file_and_missing_counter_are_null_not_zero(self):
        reader = self.reader()
        (self.group / 'memory.current').unlink()
        self.write('memory.events.local', 'max 0\noom 0\noom_kill 0\n')
        sample = reader.sample(0)
        self.assertEqual(sample['state'], 'partial')
        self.assertIsNone(sample['current_bytes'])
        self.assertIsNone(sample['events_local']['oom_group_kill'])
        self.assertEqual(sample['events_local']['oom'], 0)

    def test_unlimited_maximum_is_distinct_from_missing(self):
        reader = self.reader()
        self.write('memory.max', 'max')
        sample = reader.sample(0)
        self.assertIsNone(sample['maximum_bytes'])
        self.assertTrue(sample['maximum_unlimited'])
        (self.group / 'memory.max').unlink()
        sample = reader.sample(0)
        self.assertIsNone(sample['maximum_bytes'])
        self.assertFalse(sample['maximum_unlimited'])

    def test_malformed_duplicate_and_oversized_counters_never_export_raw(self):
        reader = self.reader()
        for raw in ('-1', 'True', '1.5', '/private/canary', '9' * (M.MAX_FILE + 1)):
            with self.subTest(raw=raw[:20]):
                self.write('memory.current', raw)
                sample = reader.sample(0)
                self.assertEqual(sample['state'], 'rejected')
                self.assertIsNone(sample['current_bytes'])
                self.assertNotIn('/private/canary', json.dumps(sample))
        self.write('memory.current', '100')
        self.write('memory.events', 'oom 0\noom 1\n')
        sample = reader.sample(0)
        self.assertEqual(sample['state'], 'rejected')
        self.assertTrue(all(value is None for value in sample['events'].values()))

    def test_counter_overflow_is_unknown_and_new_kernel_keys_are_not_exported(self):
        reader = self.reader()
        self.write('memory.peak', str(2**64 - 1))
        self.write('memory.stat', self.files['memory.stat'] + '\nfuture_counter 123\n')
        sample = reader.sample(0)
        self.assertEqual(sample['state'], 'numeric_overflow')
        self.assertIsNone(sample['peak_bytes'])
        self.assertNotIn('future_counter', sample['stat'])

    def test_symlink_fifo_hardlink_and_world_writable_files_are_denied(self):
        reader = self.reader()
        target = self.group / 'memory.current'
        target.unlink()
        outside = self.root / 'outside'
        outside.write_text('314159')
        outside.chmod(0o600)
        for kind in ('symlink', 'fifo', 'hardlink', 'mode'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    target.symlink_to(outside)
                elif kind == 'fifo':
                    os.mkfifo(target, 0o600)
                elif kind == 'hardlink':
                    os.link(outside, target)
                else:
                    target.write_text('314159')
                    target.chmod(0o666)
                self.assertIsNone(reader.sample(0)['current_bytes'])
                target.unlink()

    def test_foreign_uid_counter_is_denied_without_chown(self):
        reader = self.reader()
        real = os.fstat
        def foreign(fd):
            info = real(fd)
            if stat.S_ISREG(info.st_mode):
                values = list(info)
                values[4] = os.geteuid() + 123
                return os.stat_result(values)
            return info
        with patch.object(M.os, 'fstat', side_effect=foreign):
            sample = reader.sample(0)
        self.assertEqual(sample['state'], 'rejected')
        self.assertIsNone(sample['current_bytes'])

    def test_directory_replacement_is_not_observed_as_original_group(self):
        reader = self.reader()
        self.group.rename(self.group.with_name(UNIT + '.old'))
        self.group.mkdir(mode=0o700)
        self.write('memory.current', '999')
        sample = reader.sample(0)
        self.assertEqual(sample['state'], 'identity_changed')
        self.assertIsNone(sample['current_bytes'])

    def test_parent_replacement_and_symlink_binding_are_rejected(self):
        reader = self.reader()
        parent = self.group.parent
        parent.rename(parent.with_name('old-parent'))
        parent.symlink_to(parent.with_name('old-parent'), target_is_directory=True)
        self.assertEqual(reader.sample(0)['state'], 'identity_changed')
        with self.assertRaises(OSError):
            M.Reader(GROUP, UNIT)

    def test_unrelated_sibling_directory_changes_do_not_invalidate_group(self):
        reader = self.reader()
        (self.group.parent / 'unrelated.service').mkdir()
        self.assertEqual(reader.sample(0)['state'], 'observed')

    def test_counter_replaced_during_read_is_rejected(self):
        reader = self.reader()
        real = os.read
        changed = False
        def replaced(fd, length):
            nonlocal changed
            value = real(fd, length)
            if not changed:
                changed = True
                target = self.group / 'memory.current'
                target.rename(target.with_name('old-current'))
                self.write('memory.current', '999')
            return value
        with patch.object(M.os, 'read', side_effect=replaced):
            sample = reader.sample(0)
        self.assertIsNone(sample['current_bytes'])

    def test_only_exact_private_owned_unit_and_canonical_group_bind(self):
        for group, unit in (('/system.slice/' + UNIT, UNIT),
                            (GROUP.replace('/user-1000.slice/', '/./user-1000.slice/'), UNIT),
                            (GROUP.replace('/user-1000.slice/', '/../user-1000.slice/'), UNIT),
                            (GROUP, 'other.service'), (GROUP, UNIT + '/extra')):
            with self.subTest(group=group, unit=unit), self.assertRaises(ValueError):
                M.Reader(group, unit)

    def test_actual_thread_stops_joins_and_closes_before_return(self):
        value = self.receipt()
        self.assertTrue(value['observer_started'])
        self.assertEqual(value['stop_reason'], 'owner_stop')
        self.assertIsNotNone(value['baseline'])
        self.assertIsNotNone(value['terminal'])
        self.assertEqual(value['highest_sampled_current']['current_bytes'], 100)
        self.assertFalse(value['cause_proven'])
        self.assertFalse(value['exact_peak_composition'])

    def test_actual_thread_retains_one_periodic_real_file_sample_then_joins(self):
        sampled, calls = threading.Event(), []
        original = M.Reader.sample
        def observe(reader, elapsed):
            value = original(reader, elapsed)
            calls.append(value)
            if len(calls) >= 2:
                sampled.set()
            return value
        with patch.object(M.Reader, 'sample', observe):
            observer = M.Observer(GROUP, UNIT, SOURCE)
            try:
                self.write('memory.current', '777')
                self.assertTrue(sampled.wait(2.0))
            finally:
                value = M.validate(observer.finish())
        self.assertGreaterEqual(value['periodic_samples'], 1)
        self.assertEqual(value['last_observed']['current_bytes'], 777)
        self.assertEqual(value['highest_sampled_current']['current_bytes'], 777)
        self.assertTrue(value['observer_joined'])
        self.assertFalse(observer.reader.fds)

    def scripted(self, numbers):
        observer = object.__new__(M.Observer)
        observer.source, observer.started = dict(SOURCE), M.time.monotonic()
        observer.reader = self.reader()
        observer.baseline = observer.reader.sample(0)
        observer.thread = None
        observer.published = (0, None, None, None, 'source_unavailable')
        sequence = iter(numbers)
        def wait(_):
            value = next(sequence, None)
            if value is None:
                return True
            self.write('memory.current', str(value))
            self.write('memory.stat', self.files['memory.stat'].replace('file 1', f'file {value // 2}'))
            return False
        observer.stop_event = Mock(wait=wait)
        return observer

    def test_last_and_highest_are_separate_sampled_compositions_not_kernel_peak(self):
        observer = self.scripted([120, 180, 90])
        observer.run()
        count, last, high, terminal, reason = observer.published
        self.assertEqual((count, last['current_bytes'], high['current_bytes']), (3, 90, 180))
        self.assertEqual(high['stat']['file'], 90)
        self.assertEqual(high['peak_bytes'], 200)
        self.assertEqual(terminal['current_bytes'], 90)
        self.assertEqual(reason, 'owner_stop')
        self.assertFalse(observer.reader.fds)

    def test_sample_count_and_duration_are_independently_bounded(self):
        observer = self.scripted([1, 2, 3])
        with patch.object(M, 'MAX_SAMPLES', 2):
            observer.run()
        self.assertEqual(observer.published[0], 2)
        self.assertEqual(observer.published[-1], 'sample_limit')
        observer = self.scripted([1, 2, 3])
        observer.started -= M.MAX_SECONDS
        observer.run()
        self.assertEqual(observer.published[0], 0)
        self.assertEqual(observer.published[-1], 'sample_limit')

    def test_sampling_exception_closes_fds_and_keeps_finite_failure(self):
        observer = self.scripted([1])
        with patch.object(observer.reader, 'sample', side_effect=RuntimeError('/private/canary')):
            observer.run()
        self.assertEqual(observer.published[-1], 'observer_error')
        self.assertFalse(observer.reader.fds)
        self.assertNotIn('/private/canary', repr(observer.published))

    def test_binding_failure_and_thread_start_failure_are_closed_unknowns(self):
        observer = M.Observer('/untrusted/private/path', UNIT, SOURCE)
        value = M.validate(observer.finish())
        self.assertFalse(value['observer_started'])
        self.assertIsNone(value['baseline'])
        self.assertEqual(value['stop_reason'], 'bind_rejected')
        self.assertNotIn('/untrusted/private/path', json.dumps(value))
        with patch.object(M.threading.Thread, 'start', side_effect=RuntimeError('/private/canary')):
            observer = M.Observer(GROUP, UNIT, SOURCE)
        value = M.validate(observer.finish())
        self.assertFalse(value['observer_started'])
        self.assertEqual(value['stop_reason'], 'observer_error')
        self.assertFalse(observer.reader.fds)

    def test_group_disappearance_stops_sampling_without_rebinding(self):
        observer = self.scripted([1, 2, 3])
        real_wait = observer.stop_event.wait
        def moved(interval):
            result = real_wait(interval)
            self.group.rename(self.group.with_name(UNIT + '.gone'))
            return result
        observer.stop_event.wait = moved
        observer.run()
        self.assertEqual(observer.published[0], 1)
        self.assertEqual(observer.published[-1], 'identity_changed')
        self.assertIsNone(observer.published[1]['current_bytes'])
        self.assertFalse(observer.reader.fds)

    def test_join_timeout_does_not_close_live_readers_or_claim_terminal_sample(self):
        observer = self.scripted([])
        observer.thread = Mock(is_alive=lambda: True)
        value = observer.finish()
        observer.thread.join.assert_called_once_with(2.0)
        self.assertFalse(value['observer_joined'])
        self.assertEqual(value['stop_reason'], 'join_timeout')
        self.assertIsNone(value['terminal'])
        self.assertTrue(observer.reader.fds)
        M.validate(value)

    def test_close_error_never_retries_fd_or_masks_other_closes(self):
        reader = self.reader()
        fds = list(reader.fds)
        real, calls = os.close, []
        def close(fd):
            calls.append(fd)
            real(fd)
            if len(calls) == 1:
                raise OSError('/private/canary')
        with patch.object(M.os, 'close', side_effect=close):
            reader.close()
        self.assertEqual(calls, list(reversed(fds)))
        self.assertFalse(reader.fds)

    def test_validator_rejects_unknown_fields_types_cause_claims_and_raw_strings(self):
        value = self.receipt()
        for mutation in (
                lambda v: v.update(version=True), lambda v: v.update(cause_proven=True),
                lambda v: v.update(exact_peak_composition=True), lambda v: v.update(path='/private/canary'),
                lambda v: v.update(stop_reason='/private/canary'), lambda v: v.update(periodic_samples=True),
                lambda v: v['baseline'].update(current_bytes=True),
                lambda v: v['baseline'].update(current_bytes=2**64),
                lambda v: v['baseline'].update(state='observed', current_bytes=None),
                lambda v: v['baseline'].update(state='identity_changed'),
                lambda v: v['baseline']['stat'].update(secret='/private/canary'),
                lambda v: v['source'].update(code_revision='unknown')):
            changed = copy.deepcopy(value)
            mutation(changed)
            with self.assertRaises(ValueError):
                M.validate(changed)

    def test_maximum_closed_receipt_stays_within_small_independent_export_cap(self):
        value = self.receipt()
        sample = M.empty_sample(M.MAX_NUMBER, 'observed')
        for key in M.SCALARS:
            sample[key] = M.MAX_NUMBER
        for key in ('events', 'events_local', 'stat'):
            sample[key] = dict.fromkeys(sample[key], M.MAX_NUMBER)
        for key in ('baseline', 'last_observed', 'highest_sampled_current', 'terminal'):
            value[key] = copy.deepcopy(sample)
        value['periodic_samples'] = M.MAX_SAMPLES
        M.validate(value)
        self.assertLessEqual(len((json.dumps(value, indent=2) + '\n').encode()), M.MAX_JSON)

    def test_real_receipt_read_rejects_duplicate_nonfinite_links_and_modes(self):
        value = self.receipt()
        target = self.root / 'qemu-memory.json'
        target.write_text(json.dumps(value))
        target.chmod(0o600)
        self.assertEqual(M.load(target), value)
        for raw in ('{"version":1,"version":1}', '{"version":NaN}'):
            target.write_text(raw)
            with self.assertRaises(ValueError):
                M.load(target)
        target.write_text(json.dumps(value))
        target.chmod(0o644)
        with self.assertRaises(ValueError):
            M.load(target)
        target.chmod(0o600)
        os.link(target, self.root / 'hardlink')
        with self.assertRaises(ValueError):
            M.load(target)

    def test_host_wrapper_only_native_no_effect_on_primary_results_or_cleanup(self):
        with patch.object(TRIAL, 'module') as load:
            self.assertIsNone(TRIAL.start_qemu_memory(GROUP, UNIT, {}, 'torch'))
            load.assert_not_called()
        with patch.object(TRIAL, 'module', side_effect=RuntimeError('/private/canary')):
            self.assertIsNone(TRIAL.start_qemu_memory(GROUP, UNIT, {}, 'llama_cpp_bf16_v1'))
        for failure in (OSError('/private/canary'), RuntimeError('/private/canary')):
            owner = Mock(finish=Mock(side_effect=failure))
            TRIAL.finish_qemu_memory((M, owner), self.root)
            self.assertFalse((self.root / 'qemu-memory.json').exists())
        source = inspect.getsource(TRIAL.execute)
        self.assertLess(source.index('qemu_resource_limits'), source.index('start_qemu_memory('))
        final = source.split('    finally:', 1)[1]
        self.assertLess(final.index('finish_qemu_memory('), final.index("ssh('sudo', '-n', 'systemctl', 'poweroff'"))
        self.assertLess(final.index('finish_qemu_memory('), final.index('shutil.rmtree(scratch)'))
        self.assertNotIn('qemu_memory', inspect.getsource(TRIAL.guest))
        self.assertNotIn('cache=', inspect.getsource(TRIAL.qemu_command))

    def test_new_closed_export_binds_sources_and_preserves_legacy_receipts(self):
        value = self.receipt()
        build = self.root / 'build'
        vm = build / 'ci-vm'
        vm.mkdir(parents=True)
        source = dict(SOURCE, version=1, unrelated_historical_field=True)
        legacy = dict(version=1, core_revision=SOURCE['core_revision'], model_profile=SOURCE['model_profile'],
                      inference_backend=SOURCE['inference_backend'], passed=False, failure='stage_failed')
        for path, data in ((build / 'ci-source.json', source), (vm / 'vm-result.json', legacy),
                           (vm / 'qemu-memory.json', value)):
            path.write_text(json.dumps(data))
            path.chmod(0o600)
        (vm / 'private-model.log').write_text('/private/canary')
        with patch.object(CI, 'BUILD', build), patch.object(CI, 'guard'):
            CI.export()
        exported = build / 'ci-public-receipts'
        self.assertEqual(json.loads((exported / 'vm-result.json').read_bytes()), legacy)
        self.assertEqual(M.load(exported / 'qemu-memory.json'), value)
        self.assertEqual(set(p.name for p in exported.iterdir()), {'ci-source.json', 'vm-result.json', 'qemu-memory.json'})
        self.assertNotIn('/private/canary', ''.join(p.read_text() for p in exported.iterdir()))

    def test_export_rejects_wrong_source_and_does_not_relabel_old_receipts(self):
        value = self.receipt()
        for include, change in ((False, False), (True, True)):
            with self.subTest(include=include, change=change), tempfile.TemporaryDirectory() as directory:
                build = Path(directory)
                vm = build / 'ci-vm'
                vm.mkdir()
                legacy = dict(version=1, core_revision=SOURCE['core_revision'], model_profile=SOURCE['model_profile'],
                              inference_backend=SOURCE['inference_backend'], passed=False)
                for path, data in ((build / 'ci-source.json', dict(SOURCE, code_revision='b' * 40)),
                                   (vm / 'vm-result.json', legacy)):
                    path.write_text(json.dumps(data))
                    path.chmod(0o600)
                if include:
                    target = vm / 'qemu-memory.json'
                    target.write_text(json.dumps(value))
                    target.chmod(0o600)
                with patch.object(CI, 'BUILD', build), patch.object(CI, 'guard'):
                    if change:
                        with self.assertRaisesRegex(ValueError, 'qemu_memory_source'):
                            CI.export()
                    else:
                        CI.export()
                        self.assertEqual(json.loads((build / 'ci-public-receipts/vm-result.json').read_bytes()), legacy)
                        self.assertFalse((build / 'ci-public-receipts/qemu-memory.json').exists())

    def test_read_flags_no_retry_and_producer_to_closed_export_pipeline(self):
        real, opened = os.open, []
        def opened_readonly(path, flags, *args, **kwargs):
            opened.append((path, flags))
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_CLOEXEC)
            if path in self.files:
                self.assertTrue(flags & os.O_NONBLOCK)
            return real(path, flags, *args, **kwargs)
        manifest = dict(SOURCE, code_base_revision=SOURCE['code_revision'])
        with patch.object(M.os, 'open', side_effect=opened_readonly), patch.object(TRIAL, 'module', return_value=M):
            observation = TRIAL.start_qemu_memory(GROUP, UNIT, manifest, 'llama_cpp_bf16_v1')
            TRIAL.finish_qemu_memory(observation, self.root)
        value = M.load(self.root / 'qemu-memory.json')
        self.assertEqual(value['source'], SOURCE)
        self.assertTrue(value['observer_joined'])
        self.assertTrue(opened)
        # Missing/failed diagnostic output cannot become a new task failure.
        with patch.object(TRIAL, 'record', side_effect=OSError('/private/canary')):
            TRIAL.finish_qemu_memory(observation, self.root)


if __name__ == '__main__':
    unittest.main()
