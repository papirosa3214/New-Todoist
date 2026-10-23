#!/usr/bin/env python3
"""Process ownership for isolated role bash. Execute as the dedicated role UID."""
from collections import Counter
import argparse
import json
import os
from pathlib import Path
import re
import signal
import time

LEASE_ROOT = Path('/tmp/taskflow-role-leases-1000')
TOKEN = re.compile(r'^[a-f0-9-]{36}$')


def identity(pid, proc=Path('/proc')):
    try:
        s = (proc / str(pid) / 'stat').read_text()
        v = s[s.rindex(')')+2:].split()
        return v[19] if v[0] != 'Z' else None
    except (OSError, ValueError, IndexError):
        return None


def processes(proc=Path('/proc')):
    rows=[]
    uptime=float(Path('/proc/uptime').read_text().split()[0])
    hz=os.sysconf('SC_CLK_TCK')
    for p in proc.glob('[0-9]*'):
        try:
            status=(p/'status').read_text()
            uid=int(next(l for l in status.splitlines() if l.startswith('Uid:')).split()[1])
            if uid != os.getuid(): continue
            env=dict(x.split('=',1) for x in (p/'environ').read_bytes().decode(errors='replace').split('\0') if '=' in x)
            lease=env.get('TF_PROCESS_LEASE','');command=env.get('TF_PROCESS_COMMAND','')
            start=identity(p.name,proc)
            if not start:continue
            argv=(p/'cmdline').read_bytes().decode(errors='replace').split('\0')
            executable=Path(argv[0]).name
            cmd=' '.join(argv)
            browser=executable in {'chrome','google-chrome','chrome-headless-shell','chrome_crashpad_handler','MiniBrowser','WebKitWebProcess','WebKitNetworkProcess'}
            build=executable=='esbuild' or (executable in {'node','nodejs'} and any('node_modules/.bin/vite' in a or 'vite/bin/vite' in a for a in argv[1:3]))
            kind='browser' if browser else 'build' if build else 'other'
            if not TOKEN.fullmatch(lease):
                # Legacy/uninstrumented QA children must not silently bypass the guard.
                # Only dedicated role UID + TaskFlow cgroup + recognized QA binary + 2m grace.
                if kind=='other' or uptime-int(start)/hz<120:continue
                if 'taskflow-server.service' not in (p/'cgroup').read_text():continue
                lease='unmanaged'
            rows.append({'pid':int(p.name),'start':start,'lease':lease,'command':command,'kind':kind})
        except (OSError, ValueError, StopIteration):pass
    return rows


def invalid_lease(token, root=LEASE_ROOT, proc=Path('/proc'), now=None):
    if token=='unmanaged':return 'unmanaged QA process older than 120s'
    try:
        data=json.loads((root/(token+'.json')).read_text())
        if identity(data['owner_pid'],proc) != str(data['owner_start']):return 'owner exited'
        if (time.time() if now is None else now)-data['heartbeat'] > 180:return 'lease heartbeat expired'
        return None
    except (OSError,ValueError,KeyError,TypeError):return 'lease closed or missing'


def terminate(rows):
    def signal_rows(sig):
        for r in sorted(rows,key=lambda x:x['pid'],reverse=True):
            if r['pid']==os.getpid() or identity(r['pid']) != r['start']:continue
            try:os.kill(r['pid'],sig)
            except ProcessLookupError:pass
    signal_rows(signal.SIGTERM)
    deadline=time.monotonic()+1
    while time.monotonic()<deadline:
        if not any(identity(r['pid'])==r['start'] for r in rows):break
        time.sleep(.05)
    signal_rows(signal.SIGKILL)
    deadline=time.monotonic()+.5
    while time.monotonic()<deadline and any(identity(r['pid'])==r['start'] for r in rows):time.sleep(.02)
    return [r['pid'] for r in rows if identity(r['pid'])==r['start']]


def main():
    p=argparse.ArgumentParser();p.add_argument('--lease');p.add_argument('--command');p.add_argument('--sweep',action='store_true');p.add_argument('--inspect',action='store_true');p.add_argument('--probe');a=p.parse_args()
    rows=processes();reasons={}
    if a.probe:
        rows=[r for r in rows if r['lease']==a.probe and invalid_lease(r['lease'])]
    elif a.lease:rows=[r for r in rows if r['lease']==a.lease]
    elif a.command:rows=[r for r in rows if r['command']==a.command]
    elif a.sweep:
        reasons={r['lease']:invalid_lease(r['lease']) for r in rows}
        rows=[r for r in rows if reasons[r['lease']]]
    elif not a.inspect:p.error('select lease, command, sweep or inspect')
    remaining=[] if a.inspect else terminate(rows)
    contexts={}
    for token in set(r['lease'] for r in rows):
        try:contexts[token]=json.loads((LEASE_ROOT/(token+'.json')).read_text()).get('context',{})
        except (OSError,ValueError):pass
    print(json.dumps({'contexts':contexts,'matched':len(rows),'pids':[r['pid'] for r in rows],'remaining':remaining,'reasons':reasons,'by_kind':dict(Counter(r['kind'] for r in rows)),'leases':len(set(r['lease'] for r in rows))}))
    return 1 if remaining else 0

if __name__=='__main__':raise SystemExit(main())
