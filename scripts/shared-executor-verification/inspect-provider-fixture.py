#!/usr/bin/env python3
"""Read-only inspection of the exact files in an owner-reviewed fixture manifest."""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

MAX_MANIFEST_BYTES = 8192
MAX_FILE_BYTES = 65536
MAX_TOTAL_BYTES = 262144


class InspectionError(Exception):
    pass


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def inspect_fixture(plan):
    if not isinstance(plan, dict) or set(plan) != {'workspace', 'uid', 'gid', 'files'}:
        raise InspectionError('Invalid fixture manifest')
    root = plan['workspace']
    if not isinstance(root, str) or '\x00' in root or not pathlib.Path(root).is_absolute():
        raise InspectionError('An absolute fixture directory is required')
    if str(pathlib.Path(root)) != root or '..' in pathlib.Path(root).parts:
        raise InspectionError('Fixture path aliases are unsupported')
    if any(type(plan[key]) is not int or plan[key] < 0 for key in ['uid', 'gid']):
        raise InspectionError('Invalid fixture ownership')
    if plan['uid'] == 0:
        raise InspectionError('Root is not an approved fixture account')
    if (os.getuid(), os.getgid()) != (plan['uid'], plan['gid']):
        raise InspectionError('Use the approved ordinary fixture account')
    files = plan['files']
    if not isinstance(files, list) or not 1 <= len(files) <= 10:
        raise InspectionError('The manifest must select between one and ten files')
    selected = {}
    for item in files:
        if not isinstance(item, dict) or set(item) != {'name', 'bytes', 'sha256'}:
            raise InspectionError('Invalid fixture file entry')
        name = item['name']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,119}', name):
            raise InspectionError('Fixture files must be direct regular leaves')
        if name in selected or type(item['bytes']) is not int or not 1 <= item['bytes'] <= MAX_FILE_BYTES:
            raise InspectionError('Duplicate or oversized fixture file')
        if not isinstance(item['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
            raise InspectionError('A fixed SHA-256 is required for every file')
        selected[name] = item
    if sum(item['bytes'] for item in selected.values()) > MAX_TOTAL_BYTES:
        raise InspectionError('Fixture exceeds the aggregate inspection budget')
    required = ['O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK']
    if any(not getattr(os, flag, 0) for flag in required):
        raise InspectionError('No-follow directory inspection is unavailable')
    try:
        before = os.lstat(root)
        if not stat.S_ISDIR(before.st_mode) or os.path.realpath(root) != root:
            raise InspectionError('Fixture directory must not use symlinks')
        if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (plan['uid'], plan['gid'], 0o700):
            raise InspectionError('Fixture directory must have approved ownership and mode 0700')
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(directory)
            if identity(opened) != identity(before) or sorted(os.listdir(directory)) != sorted(selected):
                raise InspectionError('Fixture directory identity or exact file set changed')
            observations = []
            for name, item in sorted(selected.items()):
                original = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
                    raise InspectionError('Fixture leaves must be regular files without links')
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    info = os.fstat(file)
                    if identity(original) != identity(info):
                        raise InspectionError('Fixture file changed while opening')
                    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_size) != (
                            plan['uid'], plan['gid'], 0o600, item['bytes']):
                        raise InspectionError('Fixture file ownership, permissions or length differs')
                    data = bytearray()
                    while len(data) < item['bytes'] + 1:
                        chunk = os.read(file, item['bytes'] + 1 - len(data))
                        if not chunk:
                            break
                        data.extend(chunk)
                    digest = hashlib.sha256(data).hexdigest()
                    if len(data) != item['bytes'] or digest != item['sha256']:
                        raise InspectionError('Fixture bytes differ from the reviewed manifest')
                    if identity(os.fstat(file)) != identity(info) or identity(os.stat(
                            name, dir_fd=directory, follow_symlinks=False)) != identity(info):
                        raise InspectionError('Fixture file changed during inspection')
                    observations.append({'name': name, 'bytes': len(data), 'sha256': digest, 'mode': '0600'})
                finally:
                    os.close(file)
            if identity(os.fstat(directory)) != identity(opened) or identity(os.lstat(root)) != identity(opened):
                raise InspectionError('Fixture directory changed during inspection')
            if sorted(os.listdir(directory)) != sorted(selected):
                raise InspectionError('Fixture file set changed during inspection')
            return {'workspace': root, 'uid': plan['uid'], 'gid': plan['gid'], 'mode': '0700', 'files': observations}
        finally:
            os.close(directory)
    except OSError:
        raise InspectionError('Fixture filesystem inspection could not be verified') from None


def read_manifest(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= MAX_MANIFEST_BYTES:
            raise InspectionError('Manifest must be a bounded regular file')
        data = bytearray()
        while len(data) < MAX_MANIFEST_BYTES + 1:
            chunk = os.read(fd, MAX_MANIFEST_BYTES + 1 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != info.st_size or identity(os.fstat(fd)) != identity(info):
            raise InspectionError('Manifest changed during inspection')
        return json.loads(data)
    finally:
        os.close(fd)


def main():
    report = {'kind': 'provider-fixture-inspection-only', 'fixtureVerified': False,
              'agentExecuted': False, 'compatibilityReady': False, 'releaseReady': False}
    try:
        if len(sys.argv) != 2:
            raise InspectionError('Supply the reviewed fixture manifest path')
        report['observation'] = inspect_fixture(read_manifest(sys.argv[1]))
        report['fixtureVerified'] = True
    except (InspectionError, OSError, ValueError):
        report['error'] = 'Fixture verification failed; preserve the workspace and review the manifest'
        print(json.dumps(report))
        return 2
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
