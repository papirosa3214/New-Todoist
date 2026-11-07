"""Live integration check: role creates an inode, owner edits/renames/deletes it."""
import os
import subprocess
import tempfile
from pathlib import Path


def verify(root):
    root = Path(root)
    name = '.owner-access-check-' + next(tempfile._get_candidate_names())
    test = root / name
    try:
        subprocess.run(['sudo','-n','-u','tfrole','/bin/bash','-c',
            'umask 077; mkdir "$1"; mkdir "$1/nested"; printf role > "$1/nested/new.txt"',
            'owner-access',str(test)],check=True)
        file = test / 'nested/new.txt'
        assert file.read_text() == 'role'
        file.write_text('owner')
        renamed = file.with_name('renamed.txt')
        file.rename(renamed)
        assert renamed.read_text() == 'owner'
        renamed.unlink()
        (test/'nested').rmdir()
        test.rmdir()
        print(f'PASS: tfrole umask 077 -> maksim read/write/rename/delete: {root}')
    finally:
        if test.exists():
            subprocess.run(['sudo','-n','-u','tfrole','/bin/bash','-c',
                'rm -f -- "$1/nested/new.txt" "$1/nested/renamed.txt"; rmdir -- "$1/nested" "$1"',
                'cleanup',str(test)],check=True)


if __name__ == '__main__':
    for root in ['/home/maksim/Проекты/New-Todoist',
                 '/home/maksim/Проекты/New-Todoist/server/src/runtime/schedules',
                 '/home/maksim/.local/state/taskflow-runs/worktrees']:
        verify(root)
    for name in ['rules.ts','tick.ts']:
        path = Path('/home/maksim/Проекты/New-Todoist/server/src/runtime/schedules')/name
        # No content change: obtaining write access alone reproduced the original failure.
        with path.open('r+'):
            pass
    print('PASS: original role-owned source files open for write')
