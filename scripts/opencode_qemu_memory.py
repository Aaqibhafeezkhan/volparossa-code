#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Bounded, read-only host observations; never admission or OOM-cause proof.

The four retained samples are sequential observations, not atomic snapshots or
the composition at the kernel's memory.peak. No guest data or cgroup names leave
this module. The sampler owns its descriptors until it actually exits.
"""
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import threading
import time

CGROUP_ROOT = Path('/sys/fs/cgroup')
MAX_FILE = 32768
MAX_JSON = 16384
MAX_NUMBER = 2**53 - 1
INTERVAL = 1.0
MAX_SECONDS = 7200
MAX_SAMPLES = 7200
JOIN_SECONDS = 2.0
EVENT_KEYS = ('max', 'oom', 'oom_kill', 'oom_group_kill')
STAT_KEYS = ('anon', 'file', 'shmem', 'kernel', 'pagetables', 'sec_pagetables',
             'file_dirty', 'file_writeback', 'inactive_file')
SCALARS = {'current_bytes': 'memory.current', 'peak_bytes': 'memory.peak',
           'maximum_bytes': 'memory.max', 'swap_current_bytes': 'memory.swap.current'}
STATES = ('observed', 'partial', 'rejected', 'numeric_overflow', 'identity_changed')
STOPS = ('owner_stop', 'sample_limit', 'bind_rejected', 'source_unavailable',
         'identity_changed', 'observer_error', 'join_timeout')


def require(value):
    if not value:
        raise ValueError('qemu_memory_contract')


def identity(info):
    # Directory link counts can change when unrelated sibling units are created.
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid


def number(raw):
    require(re.fullmatch(rb'[0-9]{1,20}', raw) is not None)
    value = int(raw)
    if value > MAX_NUMBER:
        raise OverflowError('qemu_memory_number')
    return value


def empty_sample(elapsed_ms, state):
    return dict(elapsed_ms=elapsed_ms, state=state, maximum_unlimited=False,
                **{key: None for key in SCALARS},
                events={key: None for key in EVENT_KEYS},
                events_local={key: None for key in EVENT_KEYS},
                stat={key: None for key in STAT_KEYS})


class Reader:
    def __init__(self, group, unit):
        self.fds, self.chain = [], []
        try:
            require(type(group) is str and type(unit) is str
                    and re.fullmatch(r'volparossa-opencode-vm-[0-9a-f]{12}\.service', unit)
                    and group.startswith('/user.slice/') and group.endswith('/' + unit))
            path = PurePosixPath(group)
            require(str(path) == group and '..' not in path.parts and len(path.parts) <= 17)
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            root = os.open(CGROUP_ROOT, flags)
            self.fds.append(root)
            self.root_identity = identity(os.fstat(root))
            parent = root
            for part in path.parts[1:]:
                fd = os.open(part, flags, dir_fd=parent)
                self.fds.append(fd)
                info = os.fstat(fd)
                require(info.st_dev == self.root_identity[0] and info.st_uid in (0, os.geteuid())
                        and not stat.S_IMODE(info.st_mode) & 0o022)
                self.chain.append((parent, part, fd, identity(info)))
                parent = fd
            self.directory = parent
            self.check()
        except BaseException:
            self.close()
            raise

    def check(self):
        require(identity(CGROUP_ROOT.lstat()) == self.root_identity
                and identity(os.fstat(self.fds[0])) == self.root_identity)
        for parent, name, fd, expected in self.chain:
            require(identity(os.fstat(fd)) == expected
                    and identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected)

    def read(self, name):
        self.check()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=self.directory)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                    and before.st_uid in (0, os.geteuid())
                    and not stat.S_IMODE(before.st_mode) & 0o022)
            parts, size = [], 0
            while size <= MAX_FILE:
                data = os.read(fd, MAX_FILE + 1 - size)
                if not data:
                    break
                parts.append(data)
                size += len(data)
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
            require(size <= MAX_FILE and after.st_nlink == named.st_nlink == 1
                    and identity(after) == identity(before) and identity(named) == identity(before))
            self.check()
            return b''.join(parts).strip()
        finally:
            os.close(fd)

    def sample(self, elapsed_ms):
        result = empty_sample(elapsed_ms, 'observed')
        issues = set()
        try:
            self.check()
        except (OSError, ValueError):
            return empty_sample(elapsed_ms, 'identity_changed')
        for key, filename in SCALARS.items():
            try:
                raw = self.read(filename)
                if key == 'maximum_bytes' and raw == b'max':
                    result['maximum_unlimited'] = True
                else:
                    result[key] = number(raw)
            except OSError:
                issues.add('partial')
            except ValueError:
                issues.add('rejected')
            except OverflowError:
                issues.add('numeric_overflow')
        for key, filename, keys in (('events', 'memory.events', EVENT_KEYS),
                                    ('events_local', 'memory.events.local', EVENT_KEYS),
                                    ('stat', 'memory.stat', STAT_KEYS)):
            try:
                rows = {}
                for line in self.read(filename).splitlines():
                    pair = line.split()
                    require(len(pair) == 2 and re.fullmatch(rb'[a-z_]+', pair[0])
                            and pair[0] not in rows)
                    rows[pair[0]] = pair[1]
                values = {name: number(rows[name.encode()]) if name.encode() in rows else None for name in keys}
                if any(value is None for value in values.values()):
                    issues.add('partial')
                result[key] = values
            except OSError:
                issues.add('partial')
            except ValueError:
                issues.add('rejected')
            except OverflowError:
                issues.add('numeric_overflow')
        try:
            self.check()
        except (OSError, ValueError):
            return empty_sample(elapsed_ms, 'identity_changed')
        result['state'] = next((state for state in reversed(STATES) if state in issues), 'observed')
        return result

    def close(self):
        while self.fds:
            fd = self.fds.pop()
            try:
                os.close(fd)
            except OSError:
                pass  # Never retry close: that descriptor number may be reused.


class Observer:
    def __init__(self, group, unit, source):
        self.source = dict(source)
        self.started = time.monotonic()
        self.stop_event = threading.Event()
        self.thread = None
        self.reader = None
        self.baseline = None
        # One immutable publication keeps a timed-out join from exposing a
        # partially updated result. Published sample dictionaries are never edited.
        self.published = (0, None, None, None, 'source_unavailable')
        try:
            validate_source(self.source)
            self.reader = Reader(group, unit)
            self.baseline = self.reader.sample(self.elapsed())
            self.thread = threading.Thread(target=self.run, name='qemu-memory-observer', daemon=True)
            self.thread.start()
        except (OSError, ValueError):
            self.published = (0, None, None, None, 'bind_rejected')
            if self.reader is not None:
                self.reader.close()
            self.thread = None
        except Exception:
            self.published = (0, None, None, None, 'observer_error')
            if self.reader is not None:
                self.reader.close()
            self.thread = None

    def elapsed(self):
        return min(MAX_NUMBER, max(0, int((time.monotonic() - self.started) * 1000)))

    def run(self):
        count, last, highest, terminal, reason = 0, None, None, None, 'owner_stop'
        try:
            for _ in range(MAX_SAMPLES):
                if self.stop_event.wait(INTERVAL):
                    break
                if time.monotonic() - self.started >= MAX_SECONDS:
                    reason = 'sample_limit'
                    break
                last = self.reader.sample(self.elapsed())
                count += 1
                if last['current_bytes'] is not None and (highest is None
                        or last['current_bytes'] > highest['current_bytes']):
                    highest = last
                self.published = (count, last, highest, None, reason)
                if last['state'] == 'identity_changed':
                    reason = 'identity_changed'
                    break
            else:
                reason = 'sample_limit'
            terminal = self.reader.sample(self.elapsed())
        except Exception:
            reason = 'observer_error'
        finally:
            self.reader.close()
            self.published = (count, last, highest, terminal, reason)

    def finish(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(JOIN_SECONDS)
        joined = self.thread is None or not self.thread.is_alive()
        count, last, highest, terminal, reason = self.published
        observed = [sample for sample in (self.baseline, highest, terminal if joined else None)
                    if sample is not None and sample['current_bytes'] is not None]
        highest = max(observed, key=lambda sample: sample['current_bytes']) if observed else None
        return dict(version=1, kind='qemu-host-memory-observation', diagnostic_only=True,
                    cause_proven=False, exact_peak_composition=False, source=self.source,
                    observer_started=self.thread is not None, observer_joined=joined,
                    stop_reason=reason if joined else 'join_timeout', periodic_samples=count,
                    interval_ms=int(INTERVAL * 1000), maximum_periodic_samples=MAX_SAMPLES,
                    maximum_duration_seconds=MAX_SECONDS, baseline=self.baseline,
                    last_observed=last, highest_sampled_current=highest,
                    terminal=terminal if joined else None)


def validate_source(value):
    require(type(value) is dict and set(value) == {
        'code_revision', 'core_revision', 'model_profile', 'inference_backend'})
    require(all(type(value[key]) is str and re.fullmatch('[0-9a-f]{40}', value[key])
                for key in ('code_revision', 'core_revision')))
    require(value['model_profile'] == 'qwen3-4b-instruct-2507-v1'
            and value['inference_backend'] == 'llama_cpp_bf16_v1')


def validate(value):
    require(type(value) is dict and set(value) == {
        'version', 'kind', 'diagnostic_only', 'cause_proven', 'exact_peak_composition', 'source',
        'observer_started', 'observer_joined', 'stop_reason', 'periodic_samples', 'interval_ms',
        'maximum_periodic_samples', 'maximum_duration_seconds', 'baseline', 'last_observed',
        'highest_sampled_current', 'terminal'})
    require(type(value['version']) is int and value['version'] == 1
            and value['kind'] == 'qemu-host-memory-observation' and value['diagnostic_only'] is True
            and value['cause_proven'] is False and value['exact_peak_composition'] is False)
    validate_source(value['source'])
    require(type(value['observer_started']) is bool and type(value['observer_joined']) is bool
            and value['stop_reason'] in STOPS and type(value['periodic_samples']) is int
            and 0 <= value['periodic_samples'] <= MAX_SAMPLES)
    for key, expected in (('interval_ms', 1000), ('maximum_periodic_samples', 7200),
                          ('maximum_duration_seconds', 7200)):
        require(type(value[key]) is int and value[key] == expected)
    for key in ('baseline', 'last_observed', 'highest_sampled_current', 'terminal'):
        sample = value[key]
        if sample is None:
            continue
        require(type(sample) is dict and set(sample) == set(empty_sample(0, 'observed')))
        require(sample['state'] in STATES and type(sample['maximum_unlimited']) is bool)
        for field in ('elapsed_ms', *SCALARS):
            number_value = sample[field]
            require((field != 'elapsed_ms' and number_value is None) or
                    type(number_value) is int and 0 <= number_value <= MAX_NUMBER)
        require(not sample['maximum_unlimited'] or sample['maximum_bytes'] is None)
        for field, keys in (('events', EVENT_KEYS), ('events_local', EVENT_KEYS), ('stat', STAT_KEYS)):
            require(type(sample[field]) is dict and set(sample[field]) == set(keys))
            require(all(item is None or type(item) is int and 0 <= item <= MAX_NUMBER
                        for item in sample[field].values()))
        counters = [sample[key] for key in SCALARS if key != 'maximum_bytes']
        counters += [item for field in ('events', 'events_local', 'stat') for item in sample[field].values()]
        if sample['state'] == 'observed':
            require(all(item is not None for item in counters)
                    and (sample['maximum_bytes'] is not None or sample['maximum_unlimited']))
        if sample['state'] == 'identity_changed':
            require(all(item is None for item in counters) and sample['maximum_bytes'] is None
                    and sample['maximum_unlimited'] is False)
    if not value['observer_joined']:
        require(value['observer_started'] and value['stop_reason'] == 'join_timeout' and value['terminal'] is None)
    else:
        require(value['stop_reason'] != 'join_timeout')
    if not value['observer_started']:
        require(value['observer_joined'] and value['periodic_samples'] == 0
                and all(value[key] is None for key in ('last_observed', 'terminal')))
    if value['periodic_samples'] == 0:
        require(value['last_observed'] is None)
    else:
        require(value['observer_started'] and value['last_observed'] is not None)
    if value['highest_sampled_current'] is not None:
        high = value['highest_sampled_current']['current_bytes']
        require(high is not None and all(sample is None or sample['current_bytes'] is None
                    or high >= sample['current_bytes']
                    for sample in (value['baseline'], value['last_observed'], value['terminal'])))
    require(len(json.dumps(value, allow_nan=False).encode()) <= MAX_JSON)
    return value


def load(path):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value)
            value[key] = item
        return value

    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                and 0 < before.st_size <= MAX_JSON)
        raw = os.read(fd, MAX_JSON + 1)
        after, named = os.fstat(fd), path.lstat()
        require(len(raw) == before.st_size and identity(after) == identity(named) == identity(before)
                and after.st_nlink == named.st_nlink == 1
                and before.st_size == after.st_size == named.st_size
                and before.st_mtime_ns == after.st_mtime_ns == named.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns == named.st_ctime_ns)
        return validate(json.loads(raw, object_pairs_hook=object_pairs,
                                   parse_constant=lambda _: require(False)))
    finally:
        os.close(fd)
