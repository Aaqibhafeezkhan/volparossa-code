# SPDX-License-Identifier: GPL-3.0-only
import contextlib
import importlib.util
import io
import json
import re
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pack_cooperation', ROOT / 'scripts/pack_opencode_cooperation.py')
PACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACK)


class CooperationCaptureTests(unittest.TestCase):
    def test_proposal_mode_has_exact_additive_node_only_inventory_and_module_closure(self):
        self.assertEqual(len(PACK.SOURCES), 22)
        self.assertEqual(len(PACK.PROPOSAL_SOURCES), 27)
        self.assertEqual(len(set(PACK.PROPOSAL_SOURCES)), 27)
        for name in PACK.PROPOSAL_SOURCES:
            if not name.endswith('.cjs'):
                continue
            for dependency in re.findall(r"require\(['\"](\.[^'\"]+)['\"]\)", (ROOT / name).read_text()):
                target = ((ROOT / name).parent / dependency).resolve().relative_to(ROOT).as_posix()
                self.assertIn(target, PACK.PROPOSAL_SOURCES, (name, dependency))
        with patch.object(PACK, 'pack_proposal', side_effect=AssertionError('must not capture')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            PACK.main(['--public-code-proposal'])
        self.assertIs(json.loads(output.getvalue())['execute'], False)

    def test_proposal_capture_has_no_opencode_binary_or_local_planner_and_requires_pinned_node(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(PACK, 'ROOT', Path(directory)):
            root = Path(directory)
            (root / 'build').mkdir()
            node = root / 'node-package/bin/node'
            node.parent.mkdir(parents=True)
            license = root / 'node-package/LICENSE'
            for file, data in ((node, b'synthetic Node'), (license, b'synthetic license')):
                file.write_bytes(data)
                file.chmod(0o700)
            source = {'code/' + name: b'synthetic committed source' for name in PACK.PROPOSAL_SOURCES}
            output = root / 'build/public-code-proposal-inputs-fixture'
            args = SimpleNamespace(code_revision='b' * 40, node=node, output=output)
            with patch.object(PACK, 'blobs', return_value=source):
                with self.assertRaises(ValueError):
                    PACK.pack_proposal(args)
            self.assertFalse(output.exists())
            with patch.object(PACK, 'blobs', return_value=source) as selected, \
                    patch.object(PACK, 'NODE', (node.stat().st_size, PACK.digest(node))), \
                    patch.object(PACK, 'NODE_LICENSE', (license.stat().st_size, PACK.digest(license))):
                result = PACK.pack_proposal(args)
            selected.assert_called_once_with('b' * 40, PACK.PROPOSAL_SOURCES)
            manifest = json.loads((output / 'INPUTS.json').read_text())
            self.assertEqual(set(manifest), {'version', 'kind', 'code_revision', 'node_version', 'files'})
            self.assertEqual(manifest['kind'], 'public-code-proposal-inputs')
            self.assertEqual(result['files'], 29)
            self.assertIs(result['actual_runtime_execution'], False)
            self.assertEqual({name for name in manifest['files'] if name.startswith('runtime/')},
                             {'runtime/node', 'runtime/node-LICENSE'})
            for name, expected in manifest['files'].items():
                actual = output / name
                self.assertEqual(expected, dict(bytes=actual.stat().st_size,
                    sha256=PACK.digest(actual), mode=actual.stat().st_mode & 0o777))
            with self.assertRaises(ValueError):
                PACK.output_path(output)

    def test_preview_is_inert_and_outputs_must_be_new_under_build(self):
        with patch.object(PACK, 'pack', side_effect=AssertionError('must not capture')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            PACK.main([])
        self.assertIs(json.loads(output.getvalue())['execute'], False)
        with tempfile.TemporaryDirectory() as directory, patch.object(PACK, 'ROOT', Path(directory)):
            root = Path(directory)
            (root / 'build').mkdir()
            target = root / 'build/opencode-cooperative-inputs-fixture'
            self.assertEqual(PACK.output_path(target), target)
            for invalid in (root, root / 'build', root / 'outside', target / 'child'):
                with self.assertRaises(ValueError):
                    PACK.output_path(invalid)
            target.mkdir()
            with self.assertRaises(ValueError):
                PACK.output_path(target)

    def test_exact_committed_sources_and_existing_binary_are_captured_not_executed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(PACK, 'ROOT', Path(directory)):
            root = Path(directory)
            (root / 'build').mkdir()
            node = root / 'node-package/bin/node'
            node.parent.mkdir(parents=True)
            license = root / 'node-package/LICENSE'
            binary = root / 'opencode'
            for file, data in ((node, b'synthetic Node'), (license, b'synthetic license'), (binary, b'synthetic OpenCode')):
                file.write_bytes(data)
                file.chmod(0o700)
            source = {'code/' + name: b'synthetic committed source' for name in PACK.SOURCES}
            source['code/third_party/opencode.json'] = json.dumps(dict(commit=PACK.PIN, tag='v1.18.34',
                local_patch='patches/opencode-no-runtime-installs.patch', bun_lock_sha256='a' * 64)).encode()
            report = root / 'build-report.json'
            report.write_text(json.dumps(dict(version=1, source_build=True, source_commit=PACK.PIN,
                runtime_version='1.18.34', lock_sha256='a' * 64,
                patch_sha256=PACK.sha(source['code/patches/opencode-no-runtime-installs.patch']),
                license_sha256=PACK.sha(source['code/third_party/opencode-LICENSE.txt']),
                binary=str(binary), binary_bytes=binary.stat().st_size, binary_sha256=PACK.digest(binary))))
            report.chmod(0o600)
            output = root / 'build/opencode-cooperative-inputs-fixture'
            args = SimpleNamespace(code_revision='b' * 40, node=node, build_report=report, output=output)
            with patch.object(PACK, 'blobs', return_value=source) as selected, \
                    patch.object(PACK, 'NODE', (node.stat().st_size, PACK.digest(node))), \
                    patch.object(PACK, 'NODE_LICENSE', (license.stat().st_size, PACK.digest(license))):
                result = PACK.pack(args)
            selected.assert_called_once_with('b' * 40)
            manifest = json.loads((output / 'INPUTS.json').read_text())
            self.assertEqual(result['manifest_sha256'], PACK.digest(output / 'INPUTS.json'))
            self.assertEqual(result['files'], 26)
            self.assertIs(result['actual_peer_execution'], False)
            for name, expected in manifest['files'].items():
                actual = output / name
                self.assertEqual(expected, dict(bytes=actual.stat().st_size,
                    sha256=PACK.digest(actual), mode=actual.stat().st_mode & 0o777))


if __name__ == '__main__':
    unittest.main()
