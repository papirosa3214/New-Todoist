#!/usr/bin/env python3
"""Independent owner-UID watchdog; all signals execute through tfrole helper."""
import datetime as dt
import json
import os
import signal
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
STATE=Path.home()/'.local/state/taskflow-role-process-watch.json'
GUARD=ROOT/'scripts/role_process_guard.py'
DB=ROOT/'taskflow.db'


def role_guard(*args):
    command=shlex.join(['/usr/bin/python3',str(GUARD),*args])
    r=subprocess.run(['sudo','-n','-u','tfrole','/bin/bash','-c',command],capture_output=True,text=True,timeout=20)
    if r.returncode:raise RuntimeError(r.stderr[:300] or r.stdout[:300])
    return json.loads(r.stdout)


def probe():
    token=str(uuid.uuid4())
    # Real detached process, no lease. Must be detected by the same sweep path.
    command=f'TF_PROCESS_LEASE={token} TF_PROCESS_COMMAND={uuid.uuid4()} nohup setsid /bin/sleep 60 >/dev/null 2>&1 &'
    subprocess.run(['sudo','-n','-u','tfrole','/bin/bash','-c',command],check=True,timeout=5)
    time.sleep(.1)
    cleaned=role_guard('--probe',token)
    if not cleaned['matched']:raise RuntimeError('probe process was not reaped')
    return True


def unbounded_nas_find(argv, age, targets):
    return (bool(argv) and Path(argv[0]).name == 'find' and '/' in argv[1:]
            and '-xdev' not in argv and '-mount' not in argv and age >= 60
            and any('/gvfs/' in target for target in targets))


def stop_nas_searches():
    stopped=[]
    uptime=float(Path('/proc/uptime').read_text().split()[0]);hz=os.sysconf('SC_CLK_TCK')
    for p in Path('/proc').glob('[0-9]*'):
        try:
            uid=int(next(l for l in (p/'status').read_text().splitlines() if l.startswith('Uid:')).split()[1])
            if uid != os.getuid():continue
            argv=(p/'cmdline').read_bytes().decode(errors='replace').strip('\0').split('\0')
            if not argv or Path(argv[0]).name!='find':continue
            stat=(p/'stat').read_text();start=stat[stat.rindex(')')+2:].split()[19]
            targets=[]
            for fd in (p/'fd').iterdir():
                try:targets.append(os.readlink(fd))
                except OSError:pass
            if not unbounded_nas_find(argv,uptime-int(start)/hz,targets):continue
            check=(p/'stat').read_text()
            if check[check.rindex(')')+2:].split()[19]!=start:continue
            os.kill(int(p.name),signal.SIGTERM);stopped.append(int(p.name))
        except (OSError,ValueError,StopIteration):pass
    return stopped


def notify(text, kind='role_process_watch'):
    with sqlite3.connect(DB,timeout=10) as db:
        if db.execute("SELECT 1 FROM notifications WHERE type=? AND created_at>=datetime('now','-1 day') LIMIT 1",(kind,)).fetchone():return
        owners=db.execute("SELECT id FROM users WHERE role='owner'").fetchall()
        if not owners:raise RuntimeError('no owner for process watcher notification')
        for owner, in owners:
            db.execute('INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)',(str(uuid.uuid4()),owner,kind,text))


def main():
    if '--summary' in sys.argv:
        try:
            s=json.loads(STATE.read_text())
            if time.time()-s['checked_epoch']>180:raise ValueError('нет проверки более 3 минут')
            print('QA-процессы: '+('🚨 '+s['error'] if s.get('error') else f"сторож работает; процессов с владельцем {s['active']}, убрано сирот {s['reaped']} на последней проверке"))
        except (OSError,ValueError,KeyError) as e:print('QA-процессы: 🚨 не проверить — '+str(e))
        return 0
    state={'checked_epoch':time.time(),'checked_at':dt.datetime.now().astimezone().isoformat()}
    try:
        quota,period=Path('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/taskflow-server.service/cpu.max').read_text().split()
        state['cpu_budget_cores']=None if quota=='max' else int(quota)/int(period)
        budget_missing=quota=='max' or state['cpu_budget_cores']>4.01
        nas_searches=stop_nas_searches()
        state['nas_searches_stopped']=nas_searches
        if nas_searches:
            notify(f"Остановлены затянувшиеся поиски find от корня, обходившие сетевые папки: PID {nas_searches}. Они создавали нагрузку GVFS/портала и NAS. Повторите поиск в каталоге проекта или с -xdev; файлы не удалялись.",kind='nas_search_watch')
        result=role_guard('--sweep')
        active=role_guard('--inspect')
        state.update(reaped=result['matched'],reaped_pids=result['pids'],reasons=result['reasons'],active=active['matched'],by_kind=active['by_kind'],leases=active['leases'],contexts=active['contexts'],error=None)
        # Probe only after recording actual incident count, so it cannot invent incidents.
        probe()
        if budget_missing:
            raise RuntimeError('CPU budget missing: TaskFlow must be limited to at most 4 cores')
        if result['matched']:
            notify(f"Сторож QA убрал {result['matched']} процессов после завершения роли или потери API. Остатки браузеров/сборок могли нагружать сервер. Проверить журнал taskflow-role-process-watch.service и docs/watchers.md; файлы и результаты не удалялись.")
    except Exception as e:
        state['error']=str(e)[:500]
        try:notify('Контроль QA-процессов не работает: '+state['error']+'. Зависшие браузеры могут остаться после завершения роли. Проверьте taskflow-role-process-watch.service.')
        except Exception as delivery:state['notification_error']=str(delivery)[:300]
        # Shared external channel is reserved for API outage.
        try:
            import urllib.request
            op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with op.open('http://127.0.0.1:3001/api/health',timeout=5):pass
        except Exception:
            sys.path.insert(0,str(Path.home()/'infra-ops'))
            import alert_send
            # Reuse daily throttle by persistent state, independent of DB accessibility.
            try:old=json.loads(STATE.read_text())
            except (OSError,ValueError):old={}
            if time.time()-old.get('external_notified',0)>86400:
                if alert_send.send('role-process-watch','error','TaskFlow: контроль процессов недоступен',state['error'],reserve_full=True):state['external_notified']=time.time()
            else:state['external_notified']=old['external_notified']
    STATE.parent.mkdir(parents=True,exist_ok=True)
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n');tmp.replace(STATE)
    print(json.dumps(state,ensure_ascii=False))
    return int(bool(state.get('error')))

if __name__=='__main__':raise SystemExit(main())
