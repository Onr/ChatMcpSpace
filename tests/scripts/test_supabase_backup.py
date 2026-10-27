"""Run: python3 -m unittest discover -s tests/scripts -p 'test_*.py'."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'backup', Path(__file__).resolve().parents[2] / 'scripts/supabase_backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class MemoryStorage:
    bucket = 'db-backups'

    def __init__(self):
        self.objects = {}

    def ensure_bucket(self):
        pass

    def object_path(self, name):
        return name

    def request(self, method, path, data=None, content_type=None):
        if method == 'POST':
            self.objects[path] = data
            return b'{}'
        return self.objects[path]

    put_verified = backup.Storage.put_verified

    def list_folder(self, prefix):
        # Mirrors Storage list: direct children only, folders without an id.
        children = {}
        for key in self.objects:
            if key.startswith(prefix + '/'):
                head, _, rest = key[len(prefix) + 1:].partition('/')
                children[head] = None if rest else 'object-id'
        return [{'name': name, 'id': children[name]} for name in sorted(children)]

    def delete_objects(self, names):
        for name in names:
            del self.objects[name]


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.storage = MemoryStorage()
        self.source = self.root / 'dump.sql.gz'
        self.source.write_bytes(b'database dump contents' * 30)

    def upload(self):
        with patch.object(backup, 'PART_SIZE', 40):
            return backup.upload(self.storage, self.source)

    def test_round_trip_multiple_parts_and_private_permissions(self):
        name = self.upload()
        output = self.root / 'restored.sql.gz'
        backup.download(self.storage, name, output)
        self.assertEqual(output.read_bytes(), self.source.read_bytes())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertGreater(len(self.storage.objects), 2)

    def test_corrupt_download_never_publishes_output(self):
        name = self.upload()
        part = json.loads(self.storage.objects[name])['parts'][0]['name']
        self.storage.objects[part] = b'corrupt'
        output = self.root / 'restored.sql.gz'
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            backup.download(self.storage, name, output)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob('*.partial-*')))

    def test_upload_verification_failure_has_no_manifest(self):
        original = self.storage.request

        def corrupt(method, path, *args):
            return b'corrupt' if method == 'GET' else original(method, path, *args)

        self.storage.request = corrupt
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            self.upload()
        self.assertFalse(any(key.endswith('manifest.json') for key in self.storage.objects))

    def test_download_refuses_overwrite(self):
        name = self.upload()
        output = self.root / 'existing'
        output.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            backup.download(self.storage, name, output)
        self.assertEqual(output.read_bytes(), b'keep')

    def test_public_bucket_refused(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SECRET_KEY': 'secret'}):
            storage = backup.Storage()
        storage.request = lambda *args: b'{"public":true}'
        with self.assertRaisesRegex(ValueError, 'public bucket'):
            storage.ensure_bucket()

    def test_creates_only_missing_private_bucket(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SECRET_KEY': 'secret'}):
            storage = backup.Storage()
        calls = []

        def request(method, path, data=None):
            calls.append((method, path, data))
            if len(calls) == 1:
                raise backup.StorageError('GET', 404)
            return b'{"public":false}'

        storage.request = request
        storage.ensure_bucket()
        self.assertFalse(json.loads(calls[1][2])['public'])
        self.assertEqual([c[0] for c in calls], ['GET', 'POST', 'GET'])

    def test_invalid_url_and_missing_credentials(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'http://attacker.invalid'}, clear=True):
            with self.assertRaises(ValueError):
                backup.Storage()
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'Configure'):
                backup.Storage()

    def test_repeated_uploads_do_not_overwrite(self):
        self.assertNotEqual(self.upload(), self.upload())

    def test_rejects_manifest_part_outside_backup_prefix(self):
        name = self.upload()
        manifest = json.loads(self.storage.objects[name])
        manifest['parts'][0]['name'] = 'unrelated/secret'
        self.storage.objects[name] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(ValueError, 'Invalid part name'):
            backup.download(self.storage, name, self.root / 'output')


    def upload_named(self, stamp):
        self.source = self.root / f'db_{stamp}.sql.gz'
        self.source.write_bytes(stamp.encode() * 30)
        return self.upload()

    def folders(self):
        return sorted({key.split('/')[1] for key in self.storage.objects})

    def test_prune_keeps_newest_complete_backups(self):
        names = [self.upload_named(f'2026102{day}T000000Z') for day in range(1, 6)]
        removed = backup.prune(self.storage, 3, names[-1])
        self.assertEqual(len(removed), 2)
        self.assertEqual([f.split('.sql')[0] for f in self.folders()],
                         ['db_20261023T000000Z', 'db_20261024T000000Z', 'db_20261025T000000Z'])
        output = self.root / 'restored.sql.gz'
        backup.download(self.storage, names[2], output)

    def test_prune_removes_only_old_incomplete_folders(self):
        old = self.upload_named('20261020T000000Z')
        del self.storage.objects[old]
        self.upload_named('20261021T000000Z')
        current = self.upload_named('20261023T000000Z')
        fresh = 'postgres/db_20261024T000000Z.sql.gz-x/part-00000'
        self.storage.objects[fresh] = b'in progress'
        backup.prune(self.storage, 2, current)
        self.assertEqual([f[:19] for f in self.folders()],
                         ['db_20261021T000000Z', 'db_20261023T000000Z', 'db_20261024T000000Z'])

    def test_prune_never_deletes_current_and_validates_keep(self):
        newer = self.upload_named('20261025T000000Z')
        current = self.upload_named('20261023T000000Z')
        backup.prune(self.storage, 1, current)
        self.assertIn(current, self.storage.objects)
        self.assertIn(newer, self.storage.objects)
        with self.assertRaisesRegex(ValueError, 'at least 1'):
            backup.prune(self.storage, 0, current)

    def test_prune_refuses_when_upload_not_listed(self):
        self.upload_named('20261021T000000Z')
        with self.assertRaisesRegex(ValueError, 'not pruning'):
            backup.prune(self.storage, 1, 'postgres/missing/manifest.json')
        self.assertEqual(len(self.folders()), 1)

    def test_storage_list_pages_and_delete_request_shapes(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SECRET_KEY': 'secret'}):
            storage = backup.Storage()
        calls = []

        def request(method, path, data=None):
            calls.append((method, path, json.loads(data)))
            if method == 'POST':
                return json.dumps([{'name': 'x', 'id': '1'}] * (2 if len(calls) == 1 else 1)).encode()
            return b'[]'

        storage.request = request
        with patch.object(backup, 'LIST_PAGE', 2):
            self.assertEqual(len(storage.list_folder('postgres')), 3)
            storage.delete_objects(['a', 'b', 'c'])
        self.assertEqual(calls[0][:2], ('POST', '/object/list/db-backups'))
        self.assertEqual(calls[0][2]['prefix'], 'postgres')
        self.assertEqual(calls[1][2]['offset'], 2)
        self.assertEqual(calls[2], ('DELETE', '/object/db-backups', {'prefixes': ['a', 'b']}))
        self.assertEqual(calls[3][2], {'prefixes': ['c']})


    def test_request_retries_transient_failures_only(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SECRET_KEY': 'secret'}):
            storage = backup.Storage()
        outcomes = [backup.StorageError('POST', 520), RuntimeError('network'), b'ok']
        calls = []

        def request_once(method, path, data, content_type):
            calls.append(method)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        storage.request_once = request_once
        with patch.object(backup.time, 'sleep') as sleep:
            self.assertEqual(storage.request('POST', '/x', b'data'), b'ok')
            self.assertEqual(len(calls), 3)
            outcomes[:] = [backup.StorageError('POST', 403), b'ok']
            with self.assertRaises(backup.StorageError):
                storage.request('POST', '/x', b'data')
            outcomes[:] = [backup.StorageError('GET', 503)] * 4
            with self.assertRaises(backup.StorageError):
                storage.request('GET', '/x')
        self.assertEqual(len(calls), 3 + 1 + 4)
        self.assertEqual(sleep.call_count, 2 + 0 + 3)

    def test_uploads_send_upsert_so_retries_do_not_conflict(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co',
                                    'SUPABASE_SECRET_KEY': 'secret'}):
            storage = backup.Storage()
        sent = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self):
                return b'{}'

        storage.opener.open = lambda req, timeout: sent.append(req) or Response()
        storage.request_once('POST', '/object/a', b'x', 'application/octet-stream')
        storage.request_once('POST', '/object/list/a', b'{}', 'application/json')
        self.assertEqual(sent[0].get_header('X-upsert'), 'true')
        self.assertIsNone(sent[1].get_header('X-upsert'))


if __name__ == '__main__':
    unittest.main()
