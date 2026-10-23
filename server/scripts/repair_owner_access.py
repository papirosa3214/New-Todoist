#!/usr/bin/env python3
"""Restore owner access without root. Preserve role isolation and existing ACL entries.

New directories inherit access for the human owner. Existing role-owned inodes
are repaired as their owning UID using the configured sudo-to-tfrole rule.
Symlinks are never followed; dependency caches and Git object stores are skipped.
"""
import argparse
import os
import pwd
import subprocess
from pathlib import Path

OWNER = 'maksim'
ROLE = 'tfrole'
SKIP = {'node_modules', '.venv', 'venv', '__pycache__', 'objects'}


def paths(root):
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name not in SKIP and not Path(current, name).is_symlink()]
        yield Path(current)
        for name in files:
            path = Path(current, name)
            if not path.is_symlink() and path.is_file():
                yield path


def repair(roots, backup):
    groups = {}
    all_paths = []
    for root in roots:
        for path in paths(root):
            uid = path.stat().st_uid
            account = pwd.getpwuid(uid).pw_name
            if account not in {OWNER, ROLE}:
                raise RuntimeError(f'unsupported inode owner: {account}: {path}')
            groups.setdefault((account, path.is_dir()), []).append(str(path))
            all_paths.append(str(path))
    backup.parent.mkdir(parents=True, exist_ok=True)
    with backup.open('x') as output:
        os.chmod(backup, 0o600)
        for start in range(0, len(all_paths), 300):
            subprocess.run(['getfacl', '-p', '--', *all_paths[start:start+300]], stdout=output, check=True)
    for (account, is_dir), names in groups.items():
        acl = f'u:{OWNER}:rwX'
        if is_dir:
            acl += f',d:u:{OWNER}:rwx'
        prefix = ['sudo', '-n', '-u', ROLE, '/bin/bash', '-c', 'exec "$@"', 'owner-access'] if account == ROLE else []
        for start in range(0, len(names), 200):
            subprocess.run([*prefix, 'setfacl', '-m', acl, '--', *names[start:start+200]], check=True)
    return len(all_paths)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('roots', nargs='+', type=Path)
    args = parser.parse_args()
    print(f'repaired {repair(args.roots, args.backup)} files/directories; ACL backup: {args.backup}')


if __name__ == '__main__':
    main()
