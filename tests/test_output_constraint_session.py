# SPDX-License-Identifier: GPL-3.0-only
"""Session argument contracts only; no namespace, executable, socket or model runs."""
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('output_constraint_session', ROOT / 'scripts/opencode_session.py')
SESSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SESSION)
PROFILE = 'qwen_tagged_tool_json_v1'
HASH = 'a' * 64
VALUES = (Path('/inert/runtime/opencode'), Path('/inert/runtime/node'),
          Path('/inert/private/compute.sock'), Path('/inert/project'), Path('/home/fixture'), None)
PROXY = Path('/inert/cooperative/proxy.sock')


def configuration():
    return {'version': 1, 'opencode': str(VALUES[0]), 'opencodeSha256': HASH,
            'node': str(VALUES[1]), 'nodeSha256': HASH,
            'buildReport': '/inert/runtime/build.json', 'socketPath': str(VALUES[2])}


@contextmanager
def validation_inputs():
    # Existing suites exercise real path/owner/socket safety. Stub those inputs
    # here to test the exact new shape/tuple without opening any files or sockets.
    pin = {'bun_lock_sha256': HASH, 'local_patch': 'inert.patch', 'tag': 'v1.0'}
    report = {'version': 1, 'source_commit': SESSION.PIN, 'source_build': True,
              'lock_sha256': HASH, 'patch_sha256': HASH,
              'binary_sha256': HASH, 'runtime_version': '1.0'}
    with patch.object(SESSION.os, 'getuid', return_value=1234), \
            patch.object(SESSION, 'file', side_effect=lambda value, *_: Path(value)), \
            patch.object(SESSION, 'owned', side_effect=lambda value, _: Path(value)), \
            patch.object(SESSION, 'private_socket', side_effect=Path), \
            patch.object(SESSION, 'account_home', return_value=VALUES[4]), \
            patch.object(SESSION, 'digest', return_value=HASH), \
            patch.object(Path, 'stat', return_value=SimpleNamespace(st_size=128)), \
            patch.object(Path, 'read_text', side_effect=[json.dumps(report), json.dumps(pin)]), \
            patch.object(Path, 'is_mount', return_value=False), \
            patch.object(SESSION.os, 'access', return_value=True):
        yield


class Executed(Exception):
    """Stop immediately at the mocked exec boundary; nothing is executed."""


class OutputConstraintSessionTests(unittest.TestCase):
    def test_legacy_validation_tuple_is_unchanged(self):
        with validation_inputs():
            self.assertEqual(SESSION.validate(configuration(), str(VALUES[3])), VALUES)

    def test_selected_validation_only_appends_profile(self):
        with validation_inputs():
            self.assertEqual(SESSION.validate(configuration() | {'outputConstraint': PROFILE},
                                             str(VALUES[3])), VALUES + (PROFILE,))

    def test_cooperative_position_is_preserved_with_or_without_selection(self):
        base = VALUES[:-1] + (PROXY,)
        for selected in (False, True):
            config = configuration() | {'cooperativeSocketPath': str(PROXY)}
            if selected:
                config['outputConstraint'] = PROFILE
            with self.subTest(selected=selected), validation_inputs():
                self.assertEqual(SESSION.validate(config, str(VALUES[3])),
                                 base + ((PROFILE,) if selected else ()))

    def test_unknown_null_or_nonstring_selection_is_rejected_before_artifacts(self):
        for invalid in (None, False, True, 1, '', 'greedy_v1', 'arbitrary-grammar',
                        PROFILE + '\0', [PROFILE], {'profile': PROFILE}):
            with self.subTest(value=invalid), patch.object(SESSION.os, 'getuid', return_value=1234), \
                    patch.object(SESSION, 'file') as artifact:
                with self.assertRaises(ValueError):
                    SESSION.validate(configuration() | {'outputConstraint': invalid}, str(VALUES[3]))
                artifact.assert_not_called()

    def test_arbitrary_grammar_or_alias_fields_are_not_config_authority(self):
        for extra in ({'grammar': 'root ::= anything'}, {'outputConstraintTools': ['vp_0']},
                      {'output_constraint': PROFILE}):
            with self.subTest(extra=extra), patch.object(SESSION.os, 'getuid', return_value=1234), \
                    patch.object(SESSION, 'file') as artifact:
                with self.assertRaises(ValueError):
                    SESSION.validate(configuration() | {'outputConstraint': PROFILE} | extra, str(VALUES[3]))
                artifact.assert_not_called()

    def test_command_selection_only_appends_inside_argument(self):
        for cooperative in (None, PROXY):
            values = VALUES[:-1] + (cooperative,)
            with self.subTest(cooperative=cooperative), \
                    patch.object(SESSION.os, 'readlink', return_value='net:[inert-parent]'):
                legacy = SESSION.command(*values)
                selected = SESSION.command(*values, PROFILE)
            self.assertEqual(selected, legacy + [PROFILE])
            self.assertEqual(legacy[-2:], ['--inside', 'net:[inert-parent]'])
            self.assertNotIn(PROFILE, legacy)
            self.assertNotIn('--output-constraint', selected)
            self.assertEqual(selected.count('--bind'), 1)
            self.assertIn('--unshare-net', selected)
            self.assertIn('--clearenv', selected)
            self.assertEqual('/opt/core/cooperative.sock' in selected, cooperative is not None)

    def test_command_unknown_selection_cannot_reach_namespace_observation(self):
        with patch.object(SESSION.os, 'readlink') as namespace:
            with self.assertRaises(ValueError):
                SESSION.command(*VALUES, 'unknown')
            namespace.assert_not_called()

    def test_inside_arguments_preserve_old_node_argv_and_add_only_selected_flag(self):
        for selected in (False, True):
            argv = ['session.py', '--inside', 'net:[inert-parent]'] + ([PROFILE] if selected else [])
            with self.subTest(selected=selected), patch.object(SESSION.sys, 'argv', argv), \
                    patch.object(SESSION.os, 'getuid', return_value=1234), \
                    patch.object(SESSION.os, 'readlink', return_value='net:[inert-child]'), \
                    patch.object(SESSION.socket, 'if_nameindex', return_value=[(1, 'lo')]), \
                    patch.dict(SESSION.os.environ, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, clear=True), \
                    patch.object(SESSION.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir='/home/fixture')), \
                    patch.object(Path, 'iterdir', return_value=iter(())), \
                    patch.object(Path, 'read_text', return_value='CapEff:\t0000000000000000\n'), \
                    patch.object(SESSION.os, 'execve', side_effect=Executed) as execute:
                with self.assertRaises(Executed):
                    SESSION.main()
                expected = ['/opt/node', '/opt/scripts/opencode_session.cjs']
                if selected:
                    expected += ['--output-constraint', PROFILE]
                execute.assert_called_once_with('/opt/node', expected,
                                                {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})

    def test_inside_unknown_or_extra_argument_never_executes(self):
        for extra in (['unknown'], [''], [PROFILE, 'extra']):
            with self.subTest(extra=extra), \
                    patch.object(SESSION.sys, 'argv', ['session.py', '--inside', 'net:[inert-parent]', *extra]), \
                    patch.object(SESSION.os, 'execve') as execute:
                with self.assertRaises(ValueError):
                    SESSION.main()
                execute.assert_not_called()

    def test_execute_preserves_validated_legacy_cooperative_and_selected_tuples(self):
        for cooperative in (None, PROXY):
            for selected in (False, True):
                values = VALUES[:-1] + (cooperative,) + ((PROFILE,) if selected else ())
                config = configuration()
                if cooperative is not None:
                    config['cooperativeSocketPath'] = str(cooperative)
                if selected:
                    config['outputConstraint'] = PROFILE
                with self.subTest(cooperative=cooperative, selected=selected), \
                        patch.object(SESSION.sys, 'argv', ['session.py', '--execute', json.dumps(config), str(VALUES[3])]), \
                        patch.object(SESSION, 'validate', return_value=values) as validate, \
                        patch.object(SESSION, 'command', return_value=['inert-bwrap-argv']) as command, \
                        patch.object(SESSION.os, 'execve', side_effect=Executed) as execute:
                    with self.assertRaises(Executed):
                        SESSION.main()
                    validate.assert_called_once_with(config, str(VALUES[3]))
                    command.assert_called_once_with(*values)
                    execute.assert_called_once_with('/usr/bin/bwrap', ['inert-bwrap-argv'],
                                                    {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


if __name__ == '__main__':
    unittest.main()
