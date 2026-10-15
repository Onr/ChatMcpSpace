#!/usr/bin/env python3
"""Build a private immutable public-runner component kit; never run the executor."""
import argparse
import datetime
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGE = 'docker.io/library/node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c'
SOURCES = ['scripts/shared-agent-runner.js', 'scripts/external-agent-bridge.js',
           'public/js/shared-crypto.js', 'src/shared/bundle.js', 'src/shared/restrictedExecutor.js',
           'src/shared/executorCgroup.js', 'src/shared/executorHostPolicy.js', 'src/shared/executorSupervisor.js', 'src/shared/boundActionBroker.js',
           'src/shared/restricted-seccomp.json', 'src/shared/restricted-seccomp.LICENSE', 'src/shared/restricted-seccomp.NOTICE']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=pathlib.Path, required=True)
    parser.add_argument('--previous-round', required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    archive = subprocess.check_output(['git', 'archive', '--format=tar', commit, '--', *SOURCES], cwd=ROOT)
    assert len(archive) < 2 * 1024 * 1024
    args.destination.mkdir(mode=0o700, exist_ok=False)
    payload = args.destination / 'payload'
    payload.mkdir(mode=0o700)
    sources = {}
    with tempfile.TemporaryDirectory(prefix='.bundle-source-', dir=args.destination) as temporary:
        build = pathlib.Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as stream:
            members = stream.getmembers()
            assert len(members) < 64
            for member in members:
                relative = pathlib.PurePosixPath(member.name)
                assert not relative.is_absolute() and '..' not in relative.parts
                if member.isdir():
                    continue
                assert member.isfile() and member.name in SOURCES
                data = stream.extractfile(member).read()
                sources[member.name] = data
                target = build / member.name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(data)
        assert set(sources) == set(SOURCES)
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Node.js is required to build the public runner bundle')
        bundle = subprocess.check_output([node, '-e', 'process.stdout.write(require("./src/shared/bundle").generateSharedRunnerBundle())'],
                                         cwd=build, env={'PATH': os.defpath}, timeout=30)
    assets = {
        'shared-runner-bundle.js': bundle,
        'bridge-reference.js': sources['scripts/external-agent-bridge.js'],
        'shared-crypto-reference.js': sources['public/js/shared-crypto.js'],
        'bound-action-reference.js': sources['src/shared/boundActionBroker.js']
    }
    for name in ['runner-integration.js', 'runner-process.js', 'protocol.js', 'podman-phase-recorder.js']:
        assets[name] = (pathlib.Path(__file__).parent / name).read_bytes()
    round_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    metadata = {'roundId': round_id, 'previousRoundId': args.previous_round, 'sourceCommit': commit,
                'sourceSha256': sha(sources['src/shared/restrictedExecutor.js']),
                'bundleSha256': sha(bundle), 'image': IMAGE, 'diagnosticOnly': True,
                'component': 'actual public runner and Podman; in-memory API fixture only',
                'fixtureBudgetMs': 30000, 'excludeFromArchive': ['runner-fixture/private']}
    assets['verification-round.json'] = (json.dumps(metadata, indent=2) + '\n').encode()
    manifest = {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in assets.items()}
    assets['artifact-manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    for name, data in assets.items():
        with (payload / name).open('xb') as file:
            os.chmod(file.fileno(), 0o700 if name == 'podman-phase-recorder.js' else 0o600)
            file.write(data)
        if name.endswith('.js'):
            subprocess.run([node, '--check', str((payload / name).resolve())], env={'PATH': os.defpath},
                           capture_output=True, check=True, timeout=30)
    packet = args.destination / 'runner-integration-verification.tar.gz'
    with packet.open('xb') as output:
        os.chmod(output.fileno(), 0o600)
        with tarfile.open(fileobj=output, mode='w:gz') as stream:
            for file in sorted(payload.iterdir()):
                stream.add(file, arcname=file.name, recursive=False)
    print(json.dumps({**metadata, 'archiveBytes': packet.stat().st_size,
                      'archiveSha256': sha(packet.read_bytes()), 'manifestEntries': len(manifest)}, indent=2))


if __name__ == '__main__':
    main()
