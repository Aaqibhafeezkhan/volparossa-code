# SPDX-License-Identifier: GPL-3.0-only
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('opencode_trial', ROOT / 'scripts/smoke_opencode_inference.py')
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


editor_spec = importlib.util.spec_from_file_location('editor_service', ROOT / 'scripts/opencode_editor.py')
editor = importlib.util.module_from_spec(editor_spec)
editor_spec.loader.exec_module(editor)


class EditorProof(unittest.TestCase):
    def test_guest_service_retains_system_ownership_and_only_binds_the_selected_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, selected = Path(tmp) / 'private', Path(tmp) / 'projects'
            base.mkdir()
            selected.mkdir()
            with patch.object(editor, 'BASE', base), patch.object(editor, 'UI', selected / 'ui'), patch.object(editor, 'guard'):
                options = editor.service_properties()
            self.assertIn('--property=RootDirectory=' + str(base / 'editor-service-root'), options)
            self.assertIn('--property=ProtectSystem=strict', options)
            self.assertIn('--property=ProtectProc=invisible', options)
            self.assertIn('--property=ReadOnlyPaths=/sys', options)
            self.assertIn('--property=CPUAffinity=2', options)
            self.assertNotIn('--property=ProtectKernelTunables=yes', options)
            self.assertIn('--property=BindPaths=' + str(selected), options)
            files = next(x.removeprefix('--property=BindReadOnlyPaths=') for x in options if x.startswith('--property=BindReadOnlyPaths=')).split()
            self.assertIn('/usr', files)
            self.assertIn(str(base / 'private.sock') + ':' + str(selected / 'private.sock'), files)
            self.assertNotIn(str(base), files)
            self.assertNotIn(str(base / 'ml'), files)


    def test_explicit_fixed_native_entry_and_unmodified_default(self):
        native = 'llama_cpp_bf16_v1'
        self.assertEqual(trial.task_arguments(native, True)[-2:], [str(trial.INPUT / 'code/scripts/opencode_editor.py'), 'run'])
        self.assertIn(str(trial.INPUT / 'code/scripts/smoke_opencode_inference.cjs'), trial.task_arguments(native))
        with self.assertRaisesRegex(ValueError, 'editor_requires_native'):
            trial.task_arguments('torch', True)

    def test_editor_ram_is_bounded_inside_the_same_host_resource_ceiling(self):
        native = 'llama_cpp_bf16_v1'
        headless = trial.trial_profile(trial.LARGE_MODEL, native)
        profile = trial.trial_profile(trial.LARGE_MODEL, native, editor_ui=True)
        self.assertEqual(headless['guest_memory_mib'], 12288)
        self.assertEqual(profile, dict(headless, guest_memory_mib=12800, guest_vcpus=3))
        command = trial.qemu_command(Path('/tools'), Path('/scratch'), model_profile=trial.LARGE_MODEL,
                                     inference_backend=native, editor_ui=True)
        self.assertEqual(command[command.index('-m') + 1], str(profile['guest_memory_mib']))
        self.assertEqual(command[command.index('-smp') + 1], '3')
        with self.assertRaisesRegex(ValueError, 'editor_requires_native'):
            trial.trial_profile(trial.LARGE_MODEL, 'torch', editor_ui=True)

    def test_headless_result_cannot_satisfy_the_editor_acceptance_and_conversely(self):
        native = 'llama_cpp_bf16_v1'
        profile = trial.trial_profile(trial.LARGE_MODEL, native)
        task = dict(version=2, model_profile=trial.LARGE_MODEL, output_constraint=trial.OUTPUT_CONSTRAINT, passed=True)
        with self.assertRaisesRegex(ValueError, 'frontend_mismatch'):
            trial.validate_task_selection(task, profile, native, True)
        task['kind'] = 'opencode-vscodium-task'
        with self.assertRaisesRegex(ValueError, 'frontend_mismatch'):
            trial.validate_task_selection(task, profile, native)
        with self.assertRaisesRegex(ValueError, 'editor_acceptance'):
            trial.validate_task_selection(task, profile, native, True)
