#!/usr/bin/env python3
"""Upload verified database dump parts to private Storage; download for restore."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PART_SIZE = 6 * 1024 * 1024
LIST_PAGE = 1000
# Seconds to wait before each retry of a transient (5xx, 429, network) failure.
RETRY_DELAYS = (5, 30, 120)


class StorageError(RuntimeError):
    def __init__(self, method, status):
        self.status = status
        super().__init__(f'Supabase Storage {method} failed (HTTP {status})')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Storage:
    def __init__(self):
        url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        if not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co', url):
            raise ValueError('SUPABASE_URL must be an HTTPS Supabase project URL')
        self.key = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not self.key:
            raise ValueError('Configure SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in the server .env')
        self.url = url + '/storage/v1'
        self.bucket = os.environ.get('SUPABASE_BACKUP_BUCKET', 'db-backups')
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', self.bucket):
            raise ValueError('Invalid backup bucket name')
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, data=None, content_type='application/json'):
        for delay in RETRY_DELAYS:
            try:
                return self.request_once(method, path, data, content_type)
            except StorageError as error:
                if error.status != 429 and error.status < 500:
                    raise
            except RuntimeError:
                pass
            time.sleep(delay)
        return self.request_once(method, path, data, content_type)

    def request_once(self, method, path, data, content_type):
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key,
                   'Content-Type': content_type}
        if content_type == 'application/octet-stream':
            # Object names are unique per run, so overwriting is only ever a
            # retry of an upload whose response was lost.
            headers['x-upsert'] = 'true'
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=180) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            # Never log server responses or headers, which might contain secrets.
            status = error.code
            try:
                detail = json.loads(error.read())
                if detail.get('message') == 'Bucket not found':
                    status = 404
            except (ValueError, AttributeError):
                pass
            raise StorageError(method, status) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise RuntimeError('Supabase Storage network request failed') from None

    def ensure_bucket(self):
        try:
            info = json.loads(self.request('GET', '/bucket/' + self.bucket))
        except StorageError as error:
            if error.status != 404:
                raise
            self.request('POST', '/bucket', json.dumps({
                'id': self.bucket, 'name': self.bucket, 'public': False,
                'file_size_limit': PART_SIZE,
            }).encode())
            info = json.loads(self.request('GET', '/bucket/' + self.bucket))
        if info.get('public') is not False:
            raise ValueError('Refusing to store a database backup in a public bucket')

    def object_path(self, name):
        return '/object/' + self.bucket + '/' + urllib.parse.quote(name, safe='/')

    def list_folder(self, prefix):
        """Return the entries directly under prefix; sub-folders have no id."""
        entries, offset = [], 0
        while True:
            page = json.loads(self.request('POST', '/object/list/' + self.bucket, json.dumps({
                'prefix': prefix, 'limit': LIST_PAGE, 'offset': offset,
                'sortBy': {'column': 'name', 'order': 'asc'},
            }).encode()))
            entries.extend(page)
            if len(page) < LIST_PAGE:
                return entries
            offset += LIST_PAGE

    def delete_objects(self, names):
        for start in range(0, len(names), LIST_PAGE):
            self.request('DELETE', '/object/' + self.bucket, json.dumps({
                'prefixes': names[start:start + LIST_PAGE]}).encode())

    def put_verified(self, name, data):
        self.request('POST', self.object_path(name), data, 'application/octet-stream')
        downloaded = self.request('GET', self.object_path(name))
        if hashlib.sha256(downloaded).digest() != hashlib.sha256(data).digest():
            raise ValueError('Remote backup verification failed')


def upload(storage, file):
    storage.ensure_bucket()
    prefix = 'postgres/' + file.name + '-' + uuid.uuid4().hex
    manifest = {'version': 1, 'filename': file.name, 'parts': [], 'size': 0}
    digest = hashlib.sha256()
    with file.open('rb') as source:
        while data := source.read(PART_SIZE):
            name = f'{prefix}/part-{len(manifest["parts"]):05d}'
            storage.put_verified(name, data)
            manifest['parts'].append({'name': name, 'size': len(data),
                                      'sha256': hashlib.sha256(data).hexdigest()})
            manifest['size'] += len(data)
            digest.update(data)
    if not manifest['parts']:
        raise ValueError('Refusing an empty backup')
    manifest['sha256'] = digest.hexdigest()
    # Publish the manifest only after every part has passed download verification.
    name = prefix + '/manifest.json'
    storage.put_verified(name, json.dumps(manifest).encode())
    print(f'[supabase-backup] Uploaded and verified {manifest["size"]} bytes: {storage.bucket}/{name}')
    return name


def prune(storage, keep, current):
    """Keep the newest complete backups and delete older run folders.

    Run folders start with the timestamped dump filename, so name order is age
    order. A folder is complete only once its manifest has been published.
    Incomplete folders newer than the oldest kept backup are left alone.
    """
    if keep < 1:
        raise ValueError('SUPABASE_BACKUP_KEEP must be at least 1')
    current_folder = current.removesuffix('/manifest.json')
    folders = {}
    for entry in storage.list_folder('postgres'):
        if entry.get('id') is None:
            folder = 'postgres/' + entry['name']
            folders[folder] = [folder + '/' + item['name']
                               for item in storage.list_folder(folder) if item.get('id')]
    if current_folder not in folders:
        raise ValueError('Uploaded backup missing from Storage listing; not pruning')
    complete = sorted((f for f, names in folders.items()
                       if f + '/manifest.json' in names), reverse=True)
    kept = set(complete[:keep]) | {current_folder}
    oldest_kept = min(kept)
    stale = [f for f in folders if f not in kept and (f in complete or f < oldest_kept)]
    names = [name for folder in sorted(stale) for name in folders[folder]]
    if names:
        storage.delete_objects(names)
    print(f'[supabase-backup] Kept {len(kept)} remote backups; removed {len(stale)} older folders')
    return sorted(stale)


def download(storage, manifest_name, output):
    if not manifest_name.startswith('postgres/') or not manifest_name.endswith('/manifest.json'):
        raise ValueError('Expected a postgres/.../manifest.json object name')
    manifest = json.loads(storage.request('GET', storage.object_path(manifest_name)))
    if manifest.get('version') != 1 or not manifest.get('parts'):
        raise ValueError('Invalid backup manifest')
    prefix = manifest_name.removesuffix('manifest.json')
    temporary = output.with_name(output.name + '.partial-' + uuid.uuid4().hex)
    digest = hashlib.sha256()
    size = 0
    try:
        with temporary.open('xb') as target:
            os.chmod(temporary, 0o600)
            for index, part in enumerate(manifest['parts']):
                if part['name'] != f'{prefix}part-{index:05d}':
                    raise ValueError('Invalid part name in backup manifest')
                data = storage.request('GET', storage.object_path(part['name']))
                if len(data) != part['size'] or hashlib.sha256(data).hexdigest() != part['sha256']:
                    raise ValueError('Backup part checksum mismatch')
                target.write(data)
                digest.update(data)
                size += len(data)
        if size != manifest['size'] or digest.hexdigest() != manifest['sha256']:
            raise ValueError('Backup checksum mismatch')
        # Atomic and refuses to overwrite an existing file.
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'[supabase-backup] Downloaded and verified: {output}')


def main():
    # Read only backup settings, without evaluating shell expressions. Explicit
    # process environment values take precedence for operator overrides.
    env_file = Path(__file__).resolve().parents[1] / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and key in {'SUPABASE_URL', 'SUPABASE_SECRET_KEY',
                                     'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BACKUP_BUCKET',
                                     'SUPABASE_BACKUP_KEEP'}:
                if len(value) >= 2 and value[0] == value[-1] and value[0] in '\"\'':
                    value = value[1:-1]
                os.environ.setdefault(key, value)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('check')
    up = commands.add_parser('upload')
    up.add_argument('file', type=Path)
    down = commands.add_parser('download')
    down.add_argument('manifest')
    down.add_argument('output', type=Path)
    args = parser.parse_args()
    storage = Storage()
    if args.command == 'check':
        storage.ensure_bucket()
        print('[supabase-backup] Private bucket ready')
    elif args.command == 'upload':
        keep = int(os.environ.get('SUPABASE_BACKUP_KEEP', '5'))
        prune(storage, keep, upload(storage, args.file))
    else:
        download(storage, args.manifest, args.output)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        print(f'[supabase-backup] {error}', file=sys.stderr)
        sys.exit(1)
