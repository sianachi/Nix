#!/usr/bin/env python3
"""Failure-path tests: incomplete backups must never trigger retention."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_r2', Path(__file__).with_name('backup-r2.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_failed_dump_does_not_upload_or_prune(self):
        with tempfile.TemporaryDirectory() as state:
            with patch.object(module, 'run', side_effect=[None, subprocess.CalledProcessError(1, 'pg_dump')]):
                with patch.object(module, 'restic') as restic:
                    with self.assertRaises(subprocess.CalledProcessError):
                        module.backup(dict(objects_volume='objects', postgres_container='pg', zitadel_container='idp'), Path(state))
                    restic.assert_not_called()
                    self.assertEqual(list(Path(state).iterdir()), [])

    def test_partial_backup_and_failed_check_do_not_prune(self):
        for successful_calls in (0, 1):
            with self.subTest(successful_calls=successful_calls), tempfile.TemporaryDirectory() as state:
                config = dict(objects_volume='objects', postgres_container='pg', zitadel_container='idp', host='test', image='restic/restic:0.19.1')
                effects = [None] * successful_calls + [subprocess.CalledProcessError(3, 'restic')]
                with patch.object(module, 'run'), patch.object(module, 'restic', side_effect=effects) as restic:
                    with self.assertRaises(subprocess.CalledProcessError):
                        module.backup(config, Path(state))
                    self.assertFalse(any(call.args[1][0] == 'forget' for call in restic.call_args_list))
                    self.assertFalse((Path(state) / 'last-success.txt').exists())

    def test_credentials_must_be_private(self):
        with tempfile.TemporaryDirectory() as state:
            path = Path(state) / 'credentials'
            path.touch(mode=0o644)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                module.private_file(path)
            path.chmod(0o600)
            self.assertEqual(module.private_file(path), path.resolve())


if __name__ == '__main__':
    unittest.main()
