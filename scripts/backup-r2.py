#!/usr/bin/env python3
"""Back up the local Docker Nix deployment to an encrypted restic repository.

Usage: backup-r2.py --config /absolute/path/config.json init|backup|check|snapshots
Restore to an empty directory with: ... restore --target /absolute/path
Configuration and credentials must be private files outside version control.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def private_file(path):
    path = Path(path).expanduser().resolve()
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError(f"Expected a private file (chmod 600): {path}")
    return path


def restic(config, args, mounts=()):
    credentials = private_file(config['credentials_file'])
    password = private_file(config['password_file'])
    command = [config.get('docker', 'docker'), 'run', '--rm', '--read-only',
               '--cap-drop=ALL', '--cap-add=DAC_READ_SEARCH',
               '--security-opt=no-new-privileges:true',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--memory=1g',
               '--env-file', str(credentials), '-e', 'AWS_DEFAULT_REGION=auto',
               '-e', 'RESTIC_REPOSITORY=' + config['repository'],
               '-e', 'RESTIC_PASSWORD_FILE=/run/secrets/password',
               '--mount', f'type=bind,src={password},dst=/run/secrets/password,readonly']
    if args and args[0] == 'restore':
        command.extend(['--cap-add=CHOWN', '--cap-add=FOWNER', '--cap-add=DAC_OVERRIDE'])
    for mount in mounts:
        command.extend(['--mount', mount])
    command.extend([config['image'], '--no-cache', *args])
    run(command)


def backup(config, state):
    docker = config.get('docker', 'docker')
    # Inspect first: Docker must never silently create an empty source volume.
    run([docker, 'volume', 'inspect', config['objects_volume']], stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='staging-', dir=state) as staging:
        stage = Path(staging)
        for name, container, database in (
            ('nix', config['postgres_container'], 'nix'),
            ('zitadel', config['zitadel_container'], 'zitadel'),
        ):
            # Compression is handled by restic; uncompressed dumps deduplicate better.
            with (stage / f'{name}.dump').open('wb') as output:
                run([docker, 'exec', container, 'pg_dump', '-U', 'postgres',
                     '-Fc', '-Z0', '-d', database], stdout=output)
            with (stage / f'{name}.dump').open('rb') as source:
                run([docker, 'exec', '-i', container, 'pg_restore', '--list'],
                    stdin=source, stdout=subprocess.DEVNULL)
            with (stage / f'{name}-roles.sql').open('wb') as output:
                run([docker, 'exec', container, 'pg_dumpall', '-U', 'postgres',
                     '--roles-only'], stdout=output)
        recovery = stage / 'recovery'
        recovery.mkdir()
        for index, source in enumerate(config.get('recovery_paths', [])):
            source = Path(source).expanduser().resolve(strict=True)
            destination = recovery / f'{index}-{source.name}'
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
        (stage / 'manifest.json').write_text(json.dumps({
            'format': 1, 'databases': ['nix', 'zitadel'],
            'objects_volume': config['objects_volume'],
            'recovery_paths': config.get('recovery_paths', []),
            'note': 'Database dumps precede live immutable object capture; this is not an atomic cross-service snapshot.',
        }, indent=2) + '\n')
        # Docker Desktop bind mounts can return EIO to restic's file reader.
        # Copy dumps into an isolated Docker volume before reading them with restic.
        token = uuid.uuid4().hex
        volume, helper = 'nix-backup-stage-' + token, 'nix-backup-copy-' + token
        run([docker, 'volume', 'create', volume], stdout=subprocess.DEVNULL)
        try:
            run([docker, 'create', '--name', helper, '--network=none',
                 '--mount', f'type=volume,src={volume},dst=/backup',
                 '--entrypoint', '/bin/true', config['image']], stdout=subprocess.DEVNULL)
            try:
                run([docker, 'cp', str(stage) + '/.', helper + ':/backup'])
                restic(config, ['backup', '--host', config['host'], '--tag', 'nix-pending',
                                '--tag', token,
                                '/backup', '/objects'], [
                    f'type=volume,src={volume},dst=/backup,readonly',
                    f"type=volume,src={config['objects_volume']},dst=/objects,readonly",
                ])
            finally:
                run([docker, 'rm', helper], stdout=subprocess.DEVNULL)
        finally:
            run([docker, 'volume', 'rm', volume], stdout=subprocess.DEVNULL)
        # Never expire recovery points following a failed or partial backup.
        restic(config, ['check'])
        restic(config, ['tag', '--tag', token, '--add', 'nix-complete',
                        '--remove', 'nix-pending', '--remove', token])
        restic(config, ['forget', '--host', config['host'], '--tag', 'nix-complete',
                        '--group-by', 'host,paths', '--keep-daily', '7',
                        '--keep-weekly', '4', '--prune'])
        (state / 'last-success.txt').write_text(
            datetime.now(timezone.utc).isoformat() + '\n')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=['init', 'backup', 'check', 'snapshots', 'restore'])
    parser.add_argument('--target')
    options = parser.parse_args()
    config = json.loads(private_file(options.config).read_text())
    state = Path(config['state_directory']).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if options.action == 'backup':
            # Fail on missing credentials or inaccessible repository before taking dumps.
            restic(config, ['snapshots', '--quiet'])
            backup(config, state)
        elif options.action == 'restore':
            if not options.target:
                parser.error('restore requires --target pointing to an empty directory')
            target = Path(options.target).expanduser().resolve()
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            if any(target.iterdir()):
                raise ValueError('Restore target must be empty')
            restic(config, ['restore', 'latest', '--host', config['host'],
                            '--tag', 'nix-complete', '--target', '/restore', '--verify'],
                   [f'type=bind,src={target},dst=/restore'])
        elif options.action == 'check':
            restic(config, ['check', '--read-data'])
        else:
            restic(config, [options.action])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Backup failed: {error}') from None
