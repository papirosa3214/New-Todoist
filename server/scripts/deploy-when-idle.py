#!/usr/bin/env python3
"""Отложенная выкладка сервера TaskFlow: «новый серверный код в main → дождаться,
пока все отработают → пересобрать, перезапустить, проверить» (владелец 13.10.2026).

Роли работают внутри процесса сервера, поэтому ни одна роль не может выкладывать
сама — перезапуск оборвал бы её ход и чужие. Этот сторож живёт снаружи
(таймер systemd `taskflow-deploy-idle.timer`, раз в 2 минуты):

1. В рабочем дереве .110 (ветка main) есть коммиты после последней выкладки,
   и они трогают `server/` — иначе ничего не делаем.
2. Тихо: нет идущих попыток ролей (живой heartbeat за 10 минут) и
   недоставленных сообщений в очереди чата — дважды, с паузой 90 секунд,
   чтобы не влезть между шагами плана.
3. Резервная копия базы → `tsc --noEmit` (ошибка — выкладки нет, сервер
   работает на старом) → сборка `dist` → `systemctl --user restart` →
   `/api/health` = 200.
4. Итог — владельцу в Telegram; поломка — ещё и задачей в «Серверные
   уведомления». Одна тревога на коммит; «висит больше суток» — раз в сутки.

Состояние: ~/.local/state/taskflow-deploy/ (deployed — выложенный коммит).
Реестр: docs/watchers.md, раздел «Отложенная выкладка сервера».
"""
import json, os, sqlite3, subprocess, sys, time, urllib.request
from datetime import datetime

REPO = os.path.expanduser("~/Проекты/New-Todoist")
SERVER = os.path.join(REPO, "server")
DB = os.path.join(SERVER, "taskflow.db")
STATE = os.path.expanduser("~/.local/state/taskflow-deploy")
DEPLOYED = os.path.join(STATE, "deployed")
SEND = os.path.expanduser("~/.claude/skills/notify-telegram/send.sh")
HEALTH = "http://127.0.0.1:3001/api/health"


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def sh(*cmd, cwd=REPO, timeout=600):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def state(name, value=None):
    path = os.path.join(STATE, name)
    if value is None:
        return open(path).read().strip() if os.path.exists(path) else ""
    with open(path, "w") as f:
        f.write(value)


def notify(text):
    try:
        sh("bash", SEND, text, timeout=60)
    except Exception as e:  # уведомление не должно ронять сторожа
        log(f"Telegram не ушёл: {e}")


def alarm_card(title, body):
    """Задача в «Серверные уведомления», если сервер жив; иначе — только Telegram."""
    try:
        key = os.environ.get("TASKFLOW_VAULT_KEY", "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN")
        tok = sh("python3", os.path.expanduser("~/.claude/vault-get.py"), "--raw", key, timeout=30).stdout.strip()
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        row = con.execute("SELECT id FROM projects WHERE name='Серверные уведомления' AND archived_at IS NULL").fetchone()
        con.close()
        if not tok or not row:
            return
        desc = (f"## Работа\n\n{body}\n\n## Результат\n\nСервер работает на актуальном main.\n\n"
                "## Критерии приёмки\n\nСторож выложил коммит: в ~/.local/state/taskflow-deploy/deployed стоит HEAD main.\n\n"
                "## Границы\n\nСторож: server/scripts/deploy-when-idle.py, лог ~/.local/state/taskflow-deploy/deploy.log.")
        req = urllib.request.Request("http://127.0.0.1:3001/api/tasks", method="POST",
                                     data=json.dumps({"title": title, "description": desc, "project_id": row[0]}).encode(),
                                     headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        log(f"карточка тревоги не создана: {e}")


def busy():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        runs = con.execute("SELECT count(*) FROM attempts WHERE ended_at IS NULL AND heartbeat_at > datetime('now','-10 minutes')").fetchone()[0]
        queue = con.execute("SELECT count(*) FROM chat_message_queue WHERE status NOT IN ('done','failed')").fetchone()[0]
    finally:
        con.close()
    return runs, queue


def healthy(wait=90):
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            if urllib.request.urlopen(HEALTH, timeout=5).status == 200:
                return True
        except Exception:
            pass
        time.sleep(3)
    return False


def main():
    os.makedirs(STATE, exist_ok=True)
    state("last_run", datetime.now().isoformat(timespec="seconds"))
    if sh("git", "branch", "--show-current").stdout.strip() != "main":
        log("рабочее дерево не на main — выкладку пропускаю")
        return
    head = sh("git", "rev-parse", "HEAD").stdout.strip()
    deployed = state("deployed")
    if not deployed:
        state("deployed", head)
        log(f"первая отметка выкладки: {head[:8]}")
        return
    if head == deployed:
        return
    if sh("git", "diff", "--quiet", deployed, head, "--", "server/").returncode == 0:
        state("deployed", head)  # серверный код не менялся — перезапуск не нужен
        return
    if sh("git", "status", "--porcelain", "--", "server/").stdout.strip():
        log("в server/ незакоммиченные правки — жду")
        return

    pending_since = state("pending_since")
    if not pending_since.startswith(head):
        state("pending_since", f"{head} {int(time.time())}")
    elif time.time() - int(pending_since.split()[1]) > 86400 and state("stale_alarm") != datetime.now().strftime("%Y-%m-%d"):
        state("stale_alarm", datetime.now().strftime("%Y-%m-%d"))
        notify(f"TaskFlow: серверный код {head[:8]} ждёт выкладки больше суток — роли не затихают.")

    runs, queue = busy()
    if runs or queue:
        log(f"занято: попыток {runs}, в очереди {queue} — жду")
        return
    time.sleep(90)
    runs, queue = busy()
    if runs or queue:
        log(f"после паузы занято: попыток {runs}, в очереди {queue} — жду")
        return

    if state("failed") == head:
        return  # по этому коммиту уже была тревога; ждём новый коммит
    subject = sh("git", "log", "--format=%s", f"{deployed}..{head}", "--", "server/").stdout.strip().splitlines()
    log(f"выкладываю {deployed[:8]} → {head[:8]}: {len(subject)} коммит(ов)")

    backup = os.path.join(SERVER, "backups", f"pre-deploy-{datetime.now():%Y%m%d-%H%M}.db")
    if sh("sqlite3", DB, f".backup {backup}", cwd=SERVER).returncode != 0:
        log("резервная копия не снялась — выкладку не начинаю")
        return
    tsc = os.path.join(REPO, "node_modules", ".bin", "tsc")
    check = sh(tsc, "-p", "tsconfig.json", "--noEmit", cwd=SERVER)
    if check.returncode != 0:
        state("failed", head)
        err = (check.stdout + check.stderr).strip().splitlines()[:5]
        log("ошибка типов, выкладка отменена:\n" + "\n".join(err))
        notify(f"TaskFlow: выкладка {head[:8]} отменена — ошибка сборки. Сервер работает на старом коде.\n" + "\n".join(err))
        alarm_card(f"Выкладка сервера {head[:8]} не собирается", "Сторож отложенной выкладки не смог собрать main:\n\n```\n" + "\n".join(err) + "\n```")
        return
    build = sh(tsc, "-p", "tsconfig.json", cwd=SERVER)
    if build.returncode != 0:
        state("failed", head)
        notify(f"TaskFlow: сборка dist {head[:8]} упала — проверь сервер.")
        return
    sh("systemctl", "--user", "restart", "taskflow-server", timeout=120)
    if healthy():
        state("deployed", head)
        state("pending_since", "")
        log(f"выложено {head[:8]}")
        notify(f"TaskFlow: выложено {head[:8]} ({len(subject)} серверн. коммит(ов)), сервер отвечает.\n" + "\n".join("• " + s for s in subject[:6]))
    else:
        state("failed", head)
        log("после перезапуска /api/health не отвечает")
        notify(f"⚠️ TaskFlow: после выкладки {head[:8]} сервер НЕ отвечает. Резервная копия базы: {backup}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"сбой сторожа: {e}")
        notify(f"TaskFlow: сторож выкладки упал: {e}")
        raise
