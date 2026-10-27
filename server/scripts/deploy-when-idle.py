#!/usr/bin/env python3
"""Отложенная выкладка сервера TaskFlow: «новый серверный код в main → дождаться,
пока все отработают → пересобрать, перезапустить, проверить» (владелец 13.10.2026).

Роли работают внутри процесса сервера, поэтому ни одна роль не может выкладывать
сама — перезапуск оборвал бы её ход и чужие. Этот сторож живёт снаружи
(таймер systemd `taskflow-deploy-idle.timer`, раз в 2 минуты):

1. Подтянуть `main` с GitHub (`git fetch` + fast-forward) — источник правды
   теперь GitHub (AGENTS.md: «всё идёт на GitHub», решение 05.10.2026).
   Только fast-forward: если локальный main ушёл вперёд, ничего не трогаем.
2. В рабочем дереве .110 (ветка main) есть коммиты после последней выкладки,
   и они трогают `server/` — иначе ничего не делаем.
3. Тихо: нет идущих попыток ролей (живой heartbeat за 10 минут) и
   недоставленных сообщений в очереди чата — дважды, с паузой 90 секунд,
   чтобы не влезть между шагами плана.
4. Резервная копия базы → `tsc --noEmit` (ошибка — выкладки нет, сервер
   работает на старом) → сборка `dist` → `systemctl --user restart` →
   `/api/health` = 200.
5. Итог — владельцу в «Состояние системы» (уведомление deploy_watch), НЕ
   карточкой. Сервер не поднялся — ещё и Telegram (приложение тогда молчит).
   Одна тревога на коммит; «висит больше суток» — раз в суток.

Состояние: ~/.local/state/taskflow-deploy/ (deployed — выложенный коммит).
Реестр: docs/watchers.md, раздел «Отложенная выкладка сервера».
"""
import os, sqlite3, subprocess, time, urllib.request, uuid
from datetime import datetime

REPO = os.path.expanduser("~/Проекты/New-Todoist")
SERVER = os.path.join(REPO, "server")
DB = os.path.join(SERVER, "taskflow.db")
STATE = os.path.expanduser("~/.local/state/taskflow-deploy")
DEPLOYED = os.path.join(STATE, "deployed")
SEND = os.path.expanduser("~/.claude/skills/notify-telegram/send.sh")
HEALTH = "http://127.0.0.1:3001/api/health"
# Источник правды — GitHub (AGENTS.md, решение владельца 05.10.2026).
# «origin» — локальный Gitea в Docker, он умирает вместе с машиной и бэкапом
# не является; GitHub переживает смерть .110.
GITHUB_REMOTE = "github"


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


def sync_from_github():
    """Подтянуть `main` с GitHub — источник правды (AGENTS.md, 05.10.2026).

    Только fast-forward. Если локальный main ушёл вперёд (непушенные
    коммиты) или рабочее дерево грязное — не трогаем ничего: выкладка
    продолжит работать с локальным HEAD, как раньше. Сторож не имеет права
    терять чужую работу, поэтому «не смог обновиться» — это не ошибка
    выкладки, а повод записать в журнал и ждать следующего прохода.
    """
    fetch = sh("git", "fetch", "--quiet", GITHUB_REMOTE, "main", timeout=120)
    if fetch.returncode != 0:
        log(f"не удалось получить {GITHUB_REMOTE}/main: {(fetch.stderr or '').strip()[:160]}")
        return
    local = sh("git", "rev-parse", "HEAD").stdout.strip()
    remote = sh("git", "rev-parse", f"{GITHUB_REMOTE}/main").stdout.strip()
    if not remote or local == remote:
        return
    # Локальный main впереди удалённого — наш код не залит, обновлять нечем.
    if sh("git", "merge-base", "--is-ancestor", remote, local).returncode == 0:
        log(f"{GITHUB_REMOTE}/main отстаёт от локального main — не обновляю")
        return
    if sh("git", "status", "--porcelain").stdout.strip():
        log("рабочее дерево грязное — не обновляю из GitHub")
        return
    merge = sh("git", "merge", "--ff-only", f"{GITHUB_REMOTE}/main", timeout=120)
    if merge.returncode != 0:
        log(f"fast-forward с GitHub не прошёл: {(merge.stderr or '').strip()[:160]}")
        return
    log(f"подтянут GitHub: {local[:8]} → {remote[:8]}")


def telegram(text):
    """Только когда сервер лёг: приложение тогда ничего не покажет."""
    try:
        sh("bash", SEND, text, timeout=60)
    except Exception as e:
        log(f"Telegram не ушёл: {e}")


def notify(text):
    """Владельцу в «Состояние системы» (notifications, тип deploy_watch) —
    не карточкой: тревоги сторожей не засоряют доску (владелец 13.10.2026)."""
    try:
        con = sqlite3.connect(DB, timeout=30)
        owner = con.execute("SELECT id FROM users WHERE role='owner' AND COALESCE(archived,0)=0 ORDER BY created_at LIMIT 1").fetchone()
        if owner:
            con.execute("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?,?,?,?,?,NULL)",
                        (str(uuid.uuid4()), owner[0], "deploy_watch", None, text))
            con.commit()
        con.close()
    except Exception as e:
        log(f"уведомление не записано: {e}")
        telegram(text)


TERMINAL_CHAT_QUEUE_STATUSES = ("done", "failed", "superseded")

# Срок жизни доставки в очереди чата (минуты). Та же величина, что и на
# сервере (TASKFLOW_CHAT_DELIVERY_TTL_MIN): доставка, которую никто не
# забрал, старше порога считается мёртвой и НЕ держит выкладку.
# 21.10.2026 (карточка 568a2b93): очередь чата держала выкладку 31,6 часа —
# три строки, которые никто не забирал.
CHAT_DELIVERY_TTL_MIN = int(os.environ.get("TASKFLOW_CHAT_DELIVERY_TTL_MIN", "60"))
# Аренда хода: живой ход подтверждает себя раз в минуту. `picked` старше
# аренды — оборванный ход, выкладку он держать не должен.
CHAT_DELIVERY_LEASE_MIN = int(os.environ.get("TASKFLOW_CHAT_DELIVERY_LEASE_MIN", "5"))


def pending_chat_deliveries(con, ttl_minutes=CHAT_DELIVERY_TTL_MIN,
                            lease_minutes=CHAT_DELIVERY_LEASE_MIN):
    """Недоставленные доставки, которые ещё могут быть выполнены.

    `pending` ждёт ответа, поэтому живёт до общего срока жизни.
    `picked` держит выкладку только пока жива аренда: живой ход обновляет
    её раз в минуту, а оборванный — нет. Иначе одна мёртвая запись
    останавливает выкладку на час (карточка 568a2b93).
    """
    query = (
        "SELECT count(*) FROM chat_message_queue WHERE "
        "(status='pending' AND julianday(updated_at) >= julianday('now', ?)) OR "
        "(status='picked' AND julianday(updated_at) >= julianday('now', ?))"
    )
    return con.execute(
        query,
        (f"-{ttl_minutes} minutes", f"-{lease_minutes} minutes"),
    ).fetchone()[0]


def busy():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        runs = con.execute("SELECT count(*) FROM attempts WHERE ended_at IS NULL AND heartbeat_at > datetime('now','-10 minutes')").fetchone()[0]
        queue = pending_chat_deliveries(con)
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
    # Источник правды — GitHub: подтянуть новый main ДО расчёта, что выкладывать.
    # Если обновиться нельзя (грязное дерево, локальный main впереди) — работаем
    # с локальным HEAD, как раньше: выкладка не должна вставать из-за сети.
    sync_from_github()
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
        return
    build = sh(tsc, "-p", "tsconfig.json", cwd=SERVER)
    if build.returncode != 0:
        state("failed", head)
        notify(f"TaskFlow: сборка dist {head[:8]} упала — проверь сервер.")
        return
    # VACUUM: уборка освободившихся страниц. Нужен потому, что удалённые
    # строки (task_events с манифестами инструкций — 48 МБ) оставляют
    # после себя пустые страницы, и файл БД не сжимается (190 МБ вместо
    # 145). Сжатие требует эксклюзивной блокировки, поэтому делаем его
    # ЗДЕСЬ: выкладка идёт в окно простоя, сервер ещё не перезапущен,
    # а резервная копия уже снята (строкой выше).
    #
    # Ошибка VACUUM не должна отменять выкладку — это обслуживание, а не
    # условие её корректности. Пишем в журнал и идём дальше.
    vacuum = sh("sqlite3", DB, "VACUUM;", cwd=SERVER, timeout=600)
    if vacuum.returncode != 0:
        log(f"VACUUM не прошёл: {(vacuum.stderr or vacuum.stdout).strip()[:200]}")
    else:
        size_mb = os.path.getsize(DB) / 1024 / 1024 if os.path.exists(DB) else 0
        log(f"VACUUM выполнен, размер БД: {size_mb:.0f} МБ")
    # Усечение WAL сразу после VACUUM. VACUUM переписывает всю базу в
    # WAL, и без TRUNCATE этот файл остаётся размером с базу (28.10.2026:
    # после выкладки WAL раздувался до 175 МБ при 174 МБ базы, из них
    # живых страниц — единицы). TRUNCATE переносит кадры в базу и обрезает
    # файл до нуля. Тот же приём, что и в db.ts (journal_size_limit), —
    # только здесь усечение происходит в момент появления раздутия.
    # Ошибка — только в журнал: обслуживание не отменяет выкладку.
    truncate = sh("sqlite3", DB, "pragma wal_checkpoint(TRUNCATE);", cwd=SERVER, timeout=300)
    if truncate.returncode != 0:
        log(f"WAL не усечён: {(truncate.stderr or truncate.stdout).strip()[:200]}")
    else:
        wal = os.path.join(SERVER, "taskflow.db-wal")
        wal_mb = os.path.getsize(wal) / 1024 / 1024 if os.path.exists(wal) else 0
        log(f"WAL усечён, размер: {wal_mb:.1f} МБ")
    sh("systemctl", "--user", "restart", "taskflow-server", timeout=120)
    if healthy():
        state("deployed", head)
        state("pending_since", "")
        log(f"выложено {head[:8]}")
        notify(f"TaskFlow: выложено {head[:8]} ({len(subject)} серверн. коммит(ов)), сервер отвечает.\n" + "\n".join("• " + s for s in subject[:6]))
    else:
        state("failed", head)
        log("после перезапуска /api/health не отвечает")
        msg = f"⚠️ TaskFlow: после выкладки {head[:8]} сервер НЕ отвечает. Резервная копия базы: {backup}"
        notify(msg)
        telegram(msg)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"сбой сторожа: {e}")
        notify(f"TaskFlow: сторож выкладки упал: {e}")
        raise
