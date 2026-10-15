import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'scripts/shared-executor-verification/inspect-provider-fixture.py'
spec = importlib.util.spec_from_file_location('fixture_inspection', SOURCE)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class FixtureInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='provider-fixture-test-')
        self.root = pathlib.Path(self.temporary.name) / 'fixture'
        self.root.mkdir(mode=0o700)
        self.leaf = self.root / 'example.md'
        self.leaf.write_bytes(b'Invented example notes\n')
        self.leaf.chmod(0o600)
        self.plan = {'workspace': str(self.root), 'uid': os.getuid(), 'gid': os.getgid(),
                     'files': [{'name': self.leaf.name, 'bytes': self.leaf.stat().st_size,
                                'sha256': hashlib.sha256(self.leaf.read_bytes()).hexdigest()}]}

    def tearDown(self):
        self.temporary.cleanup()

    def denied(self, plan=None):
        with self.assertRaises(inspection.InspectionError):
            inspection.inspect_fixture(self.plan if plan is None else plan)

    def test_verified_capture_preserves_bytes_permissions_and_inode(self):
        before = self.leaf.stat()
        report = inspection.inspect_fixture(self.plan)
        self.assertEqual(report['files'][0]['sha256'], self.plan['files'][0]['sha256'])
        self.assertEqual(self.leaf.read_bytes(), b'Invented example notes\n')
        self.assertEqual(self.leaf.stat().st_ino, before.st_ino)
        self.assertEqual(self.leaf.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(report['mode'], '0700')

    def test_exact_file_set_excludes_extra_personal_material(self):
        (self.root / 'private.md').write_text('FAKE_PRIVATE_DATA')
        self.denied()

    def test_changed_bytes_same_length_are_denied(self):
        self.leaf.write_bytes(b'X' * self.plan['files'][0]['bytes'])
        self.denied()

    def test_growth_during_read_is_bounded_and_denied(self):
        original = os.read
        counts = []

        def grow(fd, length):
            with self.leaf.open('ab') as writer:
                writer.write(b'X' * 100000)
            data = original(fd, length)
            counts.append(len(data))
            return data

        with patch.object(inspection.os, 'read', grow):
            self.denied()
        self.assertLessEqual(sum(counts), self.plan['files'][0]['bytes'] + 1)

    def test_leaf_symlink_is_denied_without_reading_target(self):
        target = pathlib.Path(self.temporary.name) / 'private.md'
        self.leaf.rename(target)
        self.leaf.symlink_to(target)
        with patch.object(inspection.os, 'read', side_effect=AssertionError('No target read')):
            self.denied()

    def test_hardlinked_leaf_is_denied(self):
        os.link(self.leaf, pathlib.Path(self.temporary.name) / 'outside.md')
        self.denied()

    def test_fifo_is_denied_without_opening_for_read(self):
        self.leaf.unlink()
        os.mkfifo(self.leaf, 0o600)
        self.denied()

    def test_directory_and_parent_symlinks_are_denied(self):
        alias = pathlib.Path(self.temporary.name) / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        plan = copy.deepcopy(self.plan)
        plan['workspace'] = str(alias)
        self.denied(plan)
        alias.unlink()
        alias.symlink_to(self.root.parent, target_is_directory=True)
        plan['workspace'] = str(alias / 'fixture')
        self.denied(plan)

    def test_weak_permissions_are_denied(self):
        self.root.chmod(0o755)
        self.denied()
        self.root.chmod(0o700)
        self.leaf.chmod(0o644)
        self.denied()

    def test_wrong_account_is_denied(self):
        plan = copy.deepcopy(self.plan)
        plan['uid'] += 1
        self.denied(plan)

    def test_root_is_denied_even_when_manifest_matches_the_current_account(self):
        plan = copy.deepcopy(self.plan)
        plan['uid'] = plan['gid'] = 0
        with patch.object(inspection.os, 'getuid', return_value=0), patch.object(inspection.os, 'getgid', return_value=0):
            self.denied(plan)

    def test_unsupported_paths_counts_digests_and_budgets_fail_before_reads(self):
        candidates = []
        for name in ['..', '../private.md', '/private.md', 'sub/file.md', 'sub\\file.md']:
            plan = copy.deepcopy(self.plan)
            plan['files'][0]['name'] = name
            candidates.append(plan)
        for value in [0, True, 65537]:
            plan = copy.deepcopy(self.plan)
            plan['files'][0]['bytes'] = value
            candidates.append(plan)
        for value in ['', 'G' * 64, 'a' * 63]:
            plan = copy.deepcopy(self.plan)
            plan['files'][0]['sha256'] = value
            candidates.append(plan)
        plan = copy.deepcopy(self.plan)
        plan['files'] *= 2
        candidates.append(plan)
        plan = copy.deepcopy(self.plan)
        plan['credentials'] = 'FAKE_SECRET_VALUE'
        candidates.append(plan)
        plan = copy.deepcopy(self.plan)
        plan['files'] = [{'name': 'example' + str(i) + '.md', 'bytes': 65536, 'sha256': 'a' * 64} for i in range(5)]
        candidates.append(plan)
        plan = copy.deepcopy(self.plan)
        plan['files'] = [{'name': 'example' + str(i) + '.md', 'bytes': 1, 'sha256': 'a' * 64} for i in range(11)]
        candidates.append(plan)
        with patch.object(inspection.os, 'read', side_effect=AssertionError('No file read')):
            for plan in candidates:
                with self.subTest(plan=plan):
                    self.denied(plan)

    def test_replacement_during_capture_is_denied(self):
        original = os.read

        def replace(fd, length):
            data = original(fd, length)
            replacement = self.root / 'replacement'
            replacement.write_bytes(b'Invented example notes\n')
            replacement.chmod(0o600)
            os.replace(replacement, self.leaf)
            return data

        with patch.object(inspection.os, 'read', replace):
            self.denied()

    def test_cli_never_claims_provider_or_release_readiness_and_never_prints_contents(self):
        manifest = pathlib.Path(self.temporary.name) / 'manifest.json'
        manifest.write_text(json.dumps(self.plan))
        result = subprocess.run(['python3', str(SOURCE), str(manifest)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertTrue(report['fixtureVerified'])
        for field in ['agentExecuted', 'compatibilityReady', 'releaseReady']:
            self.assertFalse(report[field])
        self.assertNotIn('Invented example notes', result.stdout + result.stderr)
        self.leaf.write_text('FAKE_SECRET_VALUE')
        result = subprocess.run(['python3', str(SOURCE), str(manifest)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('FAKE_SECRET_VALUE', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
