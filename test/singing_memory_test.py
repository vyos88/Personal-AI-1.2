import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('singing_memory', Path(__file__).parents[1] / 'scripts/singing_memory.py')
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


class MemoryAdmissionTest(unittest.TestCase):
    def test_free_ram_does_not_hide_commit_exhaustion(self):
        self.assertIn('commit', memory.admission_reason({'available_physical_mib': 5000, 'available_commit_mib': 92}))

    def test_unknown_is_not_admitted(self):
        self.assertIsNotNone(memory.admission_reason({}))

    def test_loaded_model_has_separate_remaining_budget(self):
        sample = {'available_physical_mib': 5000, 'available_commit_mib': 12000}
        self.assertIsNotNone(memory.admission_reason(sample))
        self.assertIsNone(memory.admission_reason(sample, loaded=True))

    def test_physical_ram_still_required(self):
        self.assertIsNotNone(memory.admission_reason({'available_physical_mib': 2000, 'available_commit_mib': 32000}))

    def test_loaded_model_does_not_pay_startup_allowance_twice(self):
        sample = {'available_physical_mib': 2500, 'available_commit_mib': 12000}
        self.assertIsNone(memory.admission_reason(sample, loaded=True))
        self.assertIsNotNone(memory.admission_reason(sample))
        sample['available_physical_mib'] = 1900
        self.assertIsNotNone(memory.admission_reason(sample, loaded=True))


if __name__ == '__main__':
    unittest.main()
