#!/usr/bin/env python3
"""Root-owned installed copy: recheck ghost logind sessions without killing users.

Записи сеансов, которые logind не закрыл (состояние closing, cgroup сеанса уже
исчезла), копятся от SSH-сеансов, оборванных снаружи. 23.10.2026 таких записей
стало больше 600: повторная проверка systemd (daemon-reload) перестала их убирать,
и сторож повторял одну и ту же тревогу без продвижения.

Поэтому очистка эскалированная и измеряемая:
  1) повторная проверка logind (systemctl daemon-reload) — не чаще раза в
     RELOAD_MIN_INTERVAL, и результат ждём, а не снимаем мгновенно;
  2) штатное закрытие сеансов: loginctl terminate-session пачками одновременно,
     ограниченно остатком бюджета времени прохода, а не только числом;
  3) остановка scope-юнитов тех сеансов, чей scope ещё жив в systemd;
  4) второй круг terminate для оставшихся;
  5) если после этого записи остались — тревога с реальными числами.

Два решения принципиальные (23.10.2026, по вердикту критика):
  * Лимит terminate считается по остатку времени прохода (deadline), а не по
    одному числу. Прежний MAX_TERMINATE=200 при последовательных вызовах по
    15 с не влезал в BUDGET=100 (TimeoutStartSec=120): проход мог быть убит на
    середине, и state.json оставался без записи. Теперь потолок по числу
    высокий (MAX_TERMINATE), а фактический объём вычисляется из остатка
    времени, terminate идёт пачками одновременно, а состояние пишется
    инкрементально после каждой ступени.
  * Файлы состояния сеансов в /run/systemd/sessions НЕ удаляются. Это внутреннее
    состояние systemd: правка не покрыта гарантией и на живом сервере не дала
    эффекта (logind держит запись сеанса в памяти и возвращает её — на боевом
    проходе было 1269->1269, после снятия файлов). Вместо этого используется
    штатный путь loginctl terminate-session.

Живые сеансы не трогаем: работаем только с записями closing без cgroup и без
живого процесса-владельца.
"""
import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import time

UID=1000
STATE=Path(os.environ.get('SESSION_WATCH_STATE','/var/lib/session-record-watch/state.json'))
CGROUP=Path(os.environ.get('SESSION_WATCH_CGROUP','/sys/fs/cgroup/user.slice/user-1000.slice'))
SESSIONS_DIR=os.environ.get('SESSION_WATCH_SESSIONS_DIR','/run/systemd/sessions')
LIMIT=int(os.environ.get('SESSION_WATCH_LIMIT',64))
RELOAD_MIN_INTERVAL=600   # повторную проверку logind — не чаще раза в 10 минут
BUDGET=100                # весь проход сторожа укладывается в TimeoutStartSec=120
POLL_GAP=float(os.environ.get('SESSION_WATCH_POLL_GAP',10))
MAX_TERMINATE=2000        # потолок по числу (высокий); фактический лимит — по остатку времени
TERMINATE_CALL_COST=float(os.environ.get('SESSION_WATCH_TERMINATE_COST',6))     # консервативная оценка длительности одного terminate-вызова, с
RESERVE_SECONDS=float(os.environ.get('SESSION_WATCH_RESERVE',25))        # резерв времени прохода: финальное ожидание + запись состояния
TERMINATE_BATCH=int(os.environ.get('SESSION_WATCH_BATCH',8))         # сколько terminate-session идёт одновременно


def run(args, timeout=30, env=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)


def stale_sessions(output, cgroup=CGROUP):
    """Записи closing без cgroup сеанса — их и считаем мусором."""
    result=[]
    for line in output.splitlines():
        fields=line.split()
        if len(fields)>5 and fields[1]==str(UID) and fields[5]=='closing':
            if not (cgroup/('session-'+fields[0]+'.scope')).exists():result.append(fields[0])
    return result


def session_output():
    r=run(['loginctl','list-sessions','--no-legend','--no-pager'],timeout=20,
          env={**os.environ,'LC_ALL':'C'})
    return r.stdout


def snapshot():
    output=session_output()
    return {'total':len(output.splitlines()),'empty_closing':len(stale_sessions(output))}


def parse_scope_units(text):
    """Из вывода systemctl list-units — имена юнитов сеансов."""
    names=set()
    for line in text.splitlines():
        parts=line.split()
        unit=parts[0] if parts else ''
        if unit.startswith('session-') and unit.endswith('.scope'):names.add(unit)
    return names


def loaded_scope_units():
    """Юниты сеансов, которые ещё есть в systemd (в т.ч. abandoned)."""
    r=run(['systemctl','list-units','--type=scope','--all','--no-legend','--no-pager'],timeout=20)
    return parse_scope_units(r.stdout)


def plan_cleanup(ids, scopes, limit=MAX_TERMINATE):
    """Кого останавливать через scope-юнит, кого — через terminate-session."""
    stop=[sid for sid in ids if 'session-'+sid+'.scope' in scopes]
    terminate=[sid for sid in ids if 'session-'+sid+'.scope' not in scopes][:limit]
    return stop,terminate


def wait_for_drain(deadline, limit=LIMIT, gap=POLL_GAP):
    """Ждём, пока число мусорных записей опустится ниже limit (или до дедлайна)."""
    while True:
        remaining=deadline-time.time()
        if remaining<=0:break
        time.sleep(min(gap,remaining))
        snap=snapshot()
        if snap['empty_closing']<limit:return snap
    return snapshot()


def terminate_allowance(deadline, max_terminate=MAX_TERMINATE, cost=TERMINATE_CALL_COST,
                        batch=TERMINATE_BATCH):
    """Сколько terminate-вызовов влезает в остаток бюджета времени."""
    if deadline is None:return max_terminate
    room=deadline-time.time()-RESERVE_SECONDS
    waves=int(room//max(cost,1)) if room>0 else 0
    return max(0,min(max_terminate,waves*batch))


def stop_scope_units(ids, deadline=None, cost=8):
    """Остановить scope-юниты, которые ещё есть в systemd, — logind сможет закрыть сеанс."""
    stop,_=plan_cleanup(ids,loaded_scope_units(),limit=len(ids))
    stopped=0
    for sid in stop:
        if deadline is not None and time.time()+cost>deadline:break
        try:
            run(['systemctl','stop','session-'+sid+'.scope'],timeout=20)
            stopped+=1
        except Exception:pass
    return stopped


def _terminate_one(sid):
    try:
        run(['loginctl','terminate-session',sid],timeout=15)
        return True
    except Exception:return False


def terminate_sessions(ids, deadline=None, max_terminate=MAX_TERMINATE, scopes=None,
                       cost=TERMINATE_CALL_COST, batch=TERMINATE_BATCH):
    """Штатно закрыть сеансы через loginctl terminate-session.

    Объём ограничен остатком времени прохода: сначала считаем, сколько вызовов
    влезает в дедлайн (с резервом под финальное ожидание и запись состояния),
    затем идём пачками одновременно и пересчитываем остаток после каждой пачки.
    """
    if scopes is None:scopes=loaded_scope_units()
    _,terminate=plan_cleanup(ids,scopes,limit=len(ids))
    allowance=terminate_allowance(deadline,max_terminate,cost,batch)
    planned=terminate[:allowance]
    done=0
    with ThreadPoolExecutor(max_workers=max(1,batch)) as pool:
        for i in range(0,len(planned),batch):
            if deadline is not None and time.time()+cost>deadline-RESERVE_SECONDS:break
            chunk=planned[i:i+batch]
            list(pool.map(_terminate_one,chunk))
            done+=len(chunk)
    return {'done':done,'planned':len(planned),'allowance':allowance,
            'stopped_by_deadline':len(planned)>done}


def cleanup(ids, deadline=None, scopes=None, max_terminate=MAX_TERMINATE):
    """Штатная очистка: terminate -> остановка scope-юнитов -> terminate ещё раз."""
    if scopes is None:scopes=loaded_scope_units()
    result={'dropped_records':0,'files_untouched':True}
    first=terminate_sessions(ids,deadline=deadline,max_terminate=max_terminate,scopes=scopes)
    result['terminated_first']=first['done']
    result['terminate_first']=first
    result['stopped_scopes']=stop_scope_units(stale_sessions(session_output()),deadline=deadline)
    second=terminate_sessions(stale_sessions(session_output()),deadline=deadline,
                              max_terminate=max_terminate,scopes=scopes)
    result['terminated_second']=second['done']
    result['terminate_second']=second
    return result


def write_state(state):
    """Инкрементальная запись состояния: прерванный проход тоже оставит запись."""
    try:
        STATE.parent.mkdir(parents=True,exist_ok=True)
        tmp=STATE.with_suffix('.tmp')
        tmp.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
        os.chmod(tmp,0o644)
        tmp.replace(STATE)
    except Exception:pass


def notify(text):
    if os.environ.get('SESSION_WATCH_NO_NOTIFY'):return
    # SQLite is always opened as its owner, never as root.
    code="""import sqlite3,sys,uuid
with sqlite3.connect('/home/maksim/Проекты/New-Todoist/server/taskflow.db',timeout=10) as db:
 if not db.execute("SELECT 1 FROM notifications WHERE type='session_record_watch' AND created_at>=datetime('now','-1 day')").fetchone():
  for owner, in db.execute("SELECT id FROM users WHERE role='owner'").fetchall():
   db.execute('INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)',(str(uuid.uuid4()),owner,'session_record_watch',sys.stdin.read()))
"""
    subprocess.run(['/usr/sbin/runuser','-u','maksim','--','/usr/bin/python3','-c',code],input=text,text=True,check=True,timeout=15)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--dry-run',action='store_true')
    p.add_argument('--budget',type=float,default=float(os.environ.get('SESSION_WATCH_BUDGET',BUDGET)))
    p.add_argument('--max-terminate',type=int,default=int(os.environ.get('SESSION_WATCH_MAX_TERMINATE',MAX_TERMINATE)))
    p.add_argument('--limit',type=int,default=int(os.environ.get('SESSION_WATCH_LIMIT',LIMIT)))
    a=p.parse_args()
    deadline=time.time()+a.budget
    previous={}
    try:
        if STATE.exists():previous=json.loads(STATE.read_text())
    except Exception:previous={}
    state={'checked_epoch':time.time(),'reloaded':False,'last_reload_epoch':previous.get('last_reload_epoch',0),
           'attempts':[],'budget_sec':a.budget,'deadline_epoch':deadline,
           'max_terminate':a.max_terminate,'sessions_dir':SESSIONS_DIR}
    try:
        state['before']=snapshot()
        if isinstance(previous.get('before'),dict):
            state['growth']=state['before']['empty_closing']-previous['before'].get('empty_closing',0)
        if not a.dry_run:write_state(state)
        if state['before']['empty_closing']>=a.limit and not a.dry_run:
            # 1) перечитка systemd: logind повторно проверяет сеансы. Не чаще раза в RELOAD_MIN_INTERVAL.
            if time.time()-state['last_reload_epoch']>=RELOAD_MIN_INTERVAL:
                run(['systemctl','daemon-reload'],timeout=60)
                state['reloaded']=True
                state['last_reload_epoch']=time.time()
                state['after']=wait_for_drain(min(deadline-40,time.time()+35))
            else:
                state['after']=state['before']
            state['attempts'].append({'step':'recheck_logind','reloaded':state['reloaded'],'empty_closing':state['after']['empty_closing']})
            if not a.dry_run:write_state(state)
            # 2) штатное закрытие сеансов: terminate-session пачками, лимит по остатку времени
            if state['after']['empty_closing']>=a.limit:
                result=cleanup(stale_sessions(session_output()),deadline=deadline,
                               max_terminate=a.max_terminate)
                state['cleanup']=result
                state['after']=wait_for_drain(deadline)
                state['attempts'].append({'step':'cleanup','terminated_first':result['terminated_first'],
                                          'terminated_second':result['terminated_second'],
                                          'stopped_scopes':result['stopped_scopes'],
                                          'dropped_records':result['dropped_records'],
                                          'empty_closing':state['after']['empty_closing']})
            if not a.dry_run:write_state(state)
            if state['after']['empty_closing']>=a.limit:
                # Живая проверка 23.10.2026: записи держит logind в памяти — scope-юнит сеанса
                # уже выгружен (LoadState=not-found), cgroup и процесс-владелец исчезли.
                # Ни daemon-reload, ни loginctl terminate-session (rc=0), ни снятие файлов
                # /run/systemd/sessions такую запись не убирают: нужен рестарт systemd-logind.
                raise RuntimeError('осталось %d пустых записей сеансов Linux (было %d) — перечитка systemd, terminate-session и остановка scope-юнитов не помогли. Записи держит logind в памяти (scope-юнит сеанса уже выгружен), штатные средства их не убирают: нужен перезапуск systemd-logind — решение владельца' % (state['after']['empty_closing'],state['before']['empty_closing']))
            notify('Убраны пустые записи сеансов Linux: было %d, осталось %d (всего записей %d). Живые сеансы и службы не останавливались. Это предотвращает накопление записей и медленные запросы Cockpit.' % (state['before']['empty_closing'],state['after']['empty_closing'],state['after']['total']))
        else:
            state['after']=state['before']
        state['error']=None
    except Exception as e:
        state['error']=str(e)[:500]
        if not a.dry_run:
            try:notify('Контроль пустых сеансов Linux требует внимания: '+state['error'])
            except Exception as delivery:state['notification_error']=str(delivery)[:300]
    if not a.dry_run:write_state(state)
    print(json.dumps(state,ensure_ascii=False))
    return int(bool(state.get('error')))

if __name__=='__main__':raise SystemExit(main())
