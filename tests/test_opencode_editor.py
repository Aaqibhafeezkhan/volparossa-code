# SPDX-License-Identifier: GPL-3.0-only
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('opencode_trial', ROOT / 'scripts/smoke_opencode_inference.py')
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class EditorProof(unittest.TestCase):
    def test_explicit_fixed_native_entry_and_unmodified_default(self):
        native = 'llama_cpp_bf16_v1'
        self.assertEqual(trial.task_arguments(native, True)[-2:], [str(trial.INPUT / 'code/scripts/opencode_editor.py'), 'run'])
        self.assertIn(str(trial.INPUT / 'code/scripts/smoke_opencode_inference.cjs'), trial.task_arguments(native))
        with self.assertRaisesRegex(ValueError, 'editor_requires_native'):
            trial.task_arguments('torch', True)

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
