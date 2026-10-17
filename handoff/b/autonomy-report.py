#!/usr/bin/env python3
"""Утренняя сводка: работают ли механизмы, отвязанные от сессий Claude.

Правило Максима от 25.08.2026: настроил что-то — на следующий день покажи, как оно
работает по факту, а не «настроено». Отчёт собирает МАШИНА и сама отправляет в
Telegram: если бы его слал агент, всё снова зависело бы от того, открыл ли Максим
Claude.

Что показывает:
  - живы ли службы, на которые перенесена работа из хуков;
  - что за сутки сделало сжатие памяти: сколько записей, сколько из них — моделью,
    сколько раз свалилось в запасной режим (это и есть тихий отказ).

Добавляя новый отвязанный механизм — допиши его в UNITS и, если у него есть журнал
результатов, отдельным блоком в собранный текст.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from alert_send import send, send_direct, UNDELIVERED
CONSOLIDATE_LOG = pathlib.Path("/home/maksim/infra-ops/logs/mnemosyne-consolidate.log")

UNITS = {
    "ollama-shim.service": "прокладка Ollama (:11500)",
    "mnemosyne-consolidate.timer": "сжатие памяти по расписанию",
    "runaway-watch.timer": "сторож зависших и брошенных процессов",
    "minimax-subscription-check.timer": "проверка доступа MiniMax для DeepSeek Harness",
}


def unit_state(unit: str) -> str:
    out = subprocess.run(["systemctl", "--user", "is-active", unit],
                         capture_output=True, text=True)
    return out.stdout.strip() or "неизвестно"


def memory_summary(hours: int = 24) -> str:
    if not CONSOLIDATE_LOG.exists():
        return "сжатие памяти: журнала ещё нет"
    cutoff = time.time() - hours * 3600
    items = summaries = llm = fallbacks = runs = 0
    for line in CONSOLIDATE_LOG.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
            # ts_epoch пишет посредник из контейнера: он живёт в своём часовом поясе,
            # и разбор его даты как местной сдвигал бы окно счёта на три часа.
            ts = (rec.get("ts_epoch")
                  or time.mktime(time.strptime(rec["ts"], "%Y-%m-%dT%H:%M:%S")))
        except Exception:
            continue
        if ts < cutoff:
            continue
        runs += 1
        for r in rec.get("runs", []):
            items += r.get("items_consolidated", 0)
            summaries += r.get("summaries_created", 0)
            llm += r.get("llm_used", 0)
            fallbacks += r.get("fallbacks", 0)
    if not runs:
        return "сжатие памяти: за сутки не запускалось — проверить таймер"
    if items and not llm:
        return (f"сжатие памяти: {runs} прогонов, свёрнуто {items} записей, "
                f"моделью НИ ОДНОЙ — работает запасной режим, текст в кашу")
    return (f"сжатие памяти: {runs} прогонов, свёрнуто {items} записей, "
            f"моделью {llm}, откатов в запасной режим {fallbacks}")


MCP_TOOLS = pathlib.Path(
    "/home/maksim/.venvs/mnemosyne/lib/python3.12/site-packages/mnemosyne/mcp_tools.py")


def compact_recall_patch() -> str:
    """Правка компактной выдачи живёт в файле пакета — обновление её сотрёт."""
    try:
        if "_compact_recall_results" in MCP_TOOLS.read_text(encoding="utf-8"):
            return "компактная выдача памяти: на месте"
    except Exception:
        return "компактная выдача памяти: файл пакета не читается"
    return ("компактная выдача памяти: ПРОПАЛА — пакет обновился, вернуть правку "
            "(урок 2026-08-25-mnemosyne-compact-recall)")


def compact_recall_live() -> str:
    """Правка в файле — ещё не правка в работе.

    25.08.2026: патч лежал в mcp_tools.py, сводка показывала «на месте», а
    сессия висела на MCP-сервере, поднятом 18.08 — со старым кодом в памяти
    процесса. Выдача осталась тяжёлой, и заметить это можно было только
    глазами. Питон читает модуль один раз при старте, поэтому единственный
    честный признак — процесс старше файла, который его код содержит.

    Возраст берём в секундах (`etimes`), а НЕ дату старта: `lstart` печатает
    день и месяц словами на языке системы, и разбор такой строки молча падал
    на русской локали — сводка бодро отвечала «все моложе правки», пропустив
    ровно тот процесс, ради которого проверка и написана.
    """
    import subprocess as sp, time as _t
    pkg = pathlib.Path.home() / ".venvs/mnemosyne/lib/python3.12/site-packages/mnemosyne/mcp_tools.py"
    if not pkg.is_file():
        return "память (скорость выдачи): обновление ещё не установлено — файл patch не найден"
    patched_ago = _t.time() - pkg.stat().st_mtime
    try:
        out = sp.run(["ps", "-eo", "pid=,etimes=,cmd="], capture_output=True,
                     text=True, timeout=15).stdout
    except Exception as exc:
        return f"память (скорость выдачи): не удалось проверить статус ({exc})"
    stale, seen = [], 0
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, etimes, cmd = parts
        if "mnemosyne" not in cmd or not cmd.rstrip().endswith("mcp"):
            continue
        seen += 1
        try:
            age = int(etimes)
        except ValueError:
            continue
        if age > patched_ago:
            stale.append(pid)
    if not seen:
        return "память (скорость выдачи): серверы памяти сейчас не запущены — проверка неприменима"
    if stale:
        return (f"память (скорость выдачи): МЕДЛЕННАЯ у {len(stale)} из {seen} серверов памяти — "
                f"они запущены до последнего ускорения кода и работают по старому. "
                f"Нужно перезапустить их сессию (процессы pid {', '.join(stale)}), тогда ускорение подключится")
    return f"память (скорость выдачи): быстрая — все {seen} серверов памяти работают по последнему коду"


def truncation_watch() -> str:
    """Не начало ли зеркало снова терять хвосты записей.

    До 25.08.2026 хук-зеркало клало в память только первые 2000 символов
    файла, а разовая заливка 14.08 — первые 4000; хвосты 163 заметок были
    потеряны молча. Теперь зеркало режет текст на части — и круглая длина
    сама по себе уже НЕ улика: 26.08.2026 сторож поднял тревогу на части,
    которая просто вышла ровно в 2000 символов, хотя хвост файла лежал в
    базе целиком. Признак настоящей потери один: конца исходного файла в
    памяти нет ни в одной из его частей. Считаем ТОЛЬКО свежие (сутки) —
    старые обрезки восстановлены разово и больше в счёт не идут.
    """
    import re
    import sqlite3
    from datetime import datetime, timedelta
    db_path = pathlib.Path.home() / ".claude/mnemosyne/data/mnemosyne.db"
    if not db_path.is_file():
        return "обрезка записей: базы памяти нет"
    since = (datetime.now() - timedelta(hours=24)).isoformat()
    norm = lambda s: re.sub(r"\s+", "", s)
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        # Путь к исходнику лежит либо в самом source (нынешнее зеркало), либо в
        # метаданных (заливка 14.08 с source='memory-file'). Без пути сверять
        # нечего — такие пропускаем, а не записываем в потери вслепую.
        suspects = conn.execute(
            "SELECT DISTINCT source, json_extract(metadata_json,'$.file') "
            "  FROM working_memory "
            " WHERE timestamp > ? AND (length(content) IN (2000, 4000) "
            "       OR content LIKE '%…[обрезано]%')", (since,)).fetchall()
        lost = []
        for source, meta_file in suspects:
            path = (source or "").split(":", 1)[1] if (source or "").startswith(
                "claude_memfile:") else (meta_file or "")
            if not path:
                continue
            f = pathlib.Path(path)
            if not f.is_file():
                continue  # файла уже нет — сверять не с чем, это не свежая поломка
            tail = norm(f.read_text(errors="replace"))[-80:]
            stored = norm("".join(r[0] for r in conn.execute(
                "SELECT content FROM working_memory WHERE source=?", (source,))))
            if tail and tail not in stored:
                lost.append(f.name)
        conn.close()
    except Exception as exc:
        return f"обрезка записей: не проверить ({exc})"
    if lost:
        return (f"обрезка записей: за сутки ПОТЕРЯН ХВОСТ у {len(lost)} "
                f"({', '.join(lost[:3])}) — чинить mnemosyne-mirror.py (нарезка на части)")
    return "обрезка записей: за сутки ни одной — зеркало режет на части, как задумано"


def obsidian_mirror_watch() -> str:
    """Работает ли сторож правок Максима — и правда ли он, а не старый rsync.

    26.08.2026: служба obsidian-memory-mirror.service была зелёной каждый день, но
    гоняла obsidian-memory-mirror-legacy.sh — rsync с --delete, затирающий волт из
    источника. Питоновский сторож, который бережёт правки Максима, не вызывался
    ниоткуда: последняя запись в его логе была от 14.08, двенадцатью днями раньше.
    Правки, внесённые в память прямо в Obsidian, всё это время молча стирались.

    Поэтому смотрим не «служба жива», а две вещи: пишет ли сторож в свой лог (значит
    запускается именно он) и не висят ли правки Максима неразобранными сутками.
    """
    import json
    from datetime import datetime, timedelta
    log = pathlib.Path.home() / ".claude/obsidian-memory-mirror.log"
    edits = pathlib.Path.home() / ".claude/obsidian-memory-edits.json"
    if not log.is_file():
        return "зеркало памяти в Obsidian: лога сторожа нет — проверить, какой скрипт в юните"
    age_h = (datetime.now().timestamp() - log.stat().st_mtime) / 3600
    if age_h > 30:
        return (f"зеркало памяти в Obsidian: сторож молчит {age_h:.0f} ч — в юните, похоже, "
                f"снова старый rsync, он затирает правки Максима")
    stuck = ""
    try:
        pending = json.loads(edits.read_text(encoding="utf-8")) if edits.is_file() else []
        if pending:
            old = (datetime.now() - timedelta(hours=24)).timestamp()
            if edits.stat().st_mtime < old:
                stuck = f", правки Максима ждут разбора больше суток: {len(pending)}"
            else:
                stuck = f", правок Максима на разбор: {len(pending)}"
    except Exception:
        stuck = ", очередь правок не читается"
    return f"зеркало памяти в Obsidian: сторож работал {age_h:.0f} ч назад{stuck}"


RELAY_JOURNAL = pathlib.Path.home() / ".claude/alerts/relay-undelivered.log"


def _recent(path, hours: int) -> list:
    """Записи журнала за последние часы. Журнала нет — значит, и терять было нечего."""
    if not pathlib.Path(path).is_file():
        return []
    cutoff = time.time() - hours * 3600
    out = []
    for line in pathlib.Path(path).read_text(encoding="utf-8",
                                             errors="replace").splitlines():
        try:
            rec = json.loads(line)
            # ts_epoch пишет посредник из контейнера: он живёт в своём часовом поясе,
            # и разбор его даты как местной сдвигал бы окно счёта на три часа.
            ts = (rec.get("ts_epoch")
                  or time.mktime(time.strptime(rec["ts"], "%Y-%m-%dT%H:%M:%S")))
        except Exception:
            continue
        if ts >= cutoff:
            out.append(rec)
    return out


def delivery_watch(hours: int = 36) -> str:
    """Сколько тревог потеряно — ПО ВСЕМ отправителям и на обоих слоях.

    28.08.2026. Раньше считался один журнал, куда пишет только общий отправитель, а
    мимо него слали шестеро — ночной бэкап, архив переписок, порядок в проектах,
    присмотр за сервисами, база агента CRM и ночной сбор уроков. Из-за этого 10
    потерянных за две недели тревог выглядели как одна, и канал считался здоровым.

    Слоёв два, и складывать их нельзя: одна и та же тревога, сорвавшаяся у посредника,
    честно попадает в оба журнала. Поэтому показываем раздельно — у кого не ушло и на
    чём именно сорвалось.

    16.10–17.10.2026. Журнал отправителей — не журнал потерь, а журнал КАЖДОЙ отправки:
    alert_send пишет в него строку и на успешном пути (error="",
    reserve="дошёл (через n8n)"), до return True. Считали потери как len(журнала) — и
    каждое утро сводка писала «у отправителей НЕ УШЛО N» при N успешных доставках, а
    rendezvous по этому маркеру заводил карточку на диагностику. Потеря — это запись, где
    отправка всё-таки сорвалась: непустая причина И тревога не ушла второй попыткой
    (alert_send пишет error первой попытки даже при успешной второй), либо запасная
    дорога не дошла вовсе.
    """
    attempts = _recent(UNDELIVERED, hours)
    senders = [r for r in attempts
               if r.get("reserve") == "не дошёл"
               or ((r.get("error") or "").strip()
                   and r.get("reserve") != "дошёл (через n8n)")]
    relay = _recent(RELAY_JOURNAL, hours)
    lost_relay = [r for r in relay if r.get("status") == "lost"]
    shaky = [r for r in relay if r.get("status") == "recovered"]

    if not senders and not lost_relay:
        tail = f" — тревог отправлено: {len(attempts)}" if attempts else ""
        if shaky:
            tail += f", посредник вытянул повтором: {len(shaky)}"
        return f"доставка тревог: потерь за {hours} ч нет{tail}"

    parts = []
    if senders:
        by_src = {}
        for r in senders:
            by_src[r.get("source") or "без имени"] = by_src.get(r.get("source") or "без имени", 0) + 1
        кто = ", ".join(f"{k}: {v}" for k, v in sorted(by_src.items(), key=lambda x: -x[1]))
        # Дошло ли хотя бы предупреждение по запасной дороге — это отдельная беда.
        немых = sum(1 for r in senders if r.get("reserve") == "не дошёл")
        придушено = sum(1 for r in senders if r.get("reserve") == "промолчал")
        parts.append(f"у отправителей НЕ УШЛО {len(senders)} ({кто})")
        if немых:
            parts.append(f"из них без предупреждения даже запасной дорогой: {немых}")
        if придушено:
            parts.append(f"предупреждение придушено частотой: {придушено}")
    if lost_relay:
        parts.append(f"сорвалось у посредника: {len(lost_relay)}")
        причина = (lost_relay[-1].get("error") or "").strip()
        if причина:
            parts.append(f"последняя причина — {причина[:120]}")
    if shaky:
        parts.append(f"вытянуто повтором: {len(shaky)}")
    return "доставка тревог: " + "; ".join(parts)


def kb_reachable_watch() -> str:
    """Видит ли база знаний ВСЕ свои документы — и достаётся ли содержимое.

    26.08.2026: выборка документов брала по 400 на датасет без страниц, и скрипт видел
    867 из 1134. Поиск при этом работал (он идёт другим путём), поэтому заметить было
    нечем: урок находился, а достать его по имени было нельзя. Проверяем два числа —
    сколько документов в RAGFlow и сколько видит наш слой, — и то, что текст реально
    приходит: пустой ответ при живом поиске это тоже отказ, просто тихий.
    """
    import subprocess as sp
    probe = (
        "import sys; sys.path.insert(0, '/home/maksim/kb'); import kb_query as k, urllib.parse\n"
        "cfg = k._cfg(); total = 0\n"
        "for ds in cfg['dataset_ids']:\n"
        "    d = k._ragflow_json(cfg, '/api/v1/datasets/%s/documents?page_size=1' % urllib.parse.quote(ds))\n"
        "    total += (d.get('data') or {}).get('total') or 0\n"
        "docs = k.list_documents()\n"
        "t = k.get_document_text(docs[0]['dataset_id'], docs[0]['id']) if docs else ''\n"
        "print(total, len(docs), len(t or ''))\n"
    )
    try:
        out = sp.run(["python3", "-c", probe], capture_output=True, text=True,
                     timeout=180).stdout.split()
        total, seen, chars = int(out[0]), int(out[1]), int(out[2])
    except Exception as exc:
        return f"база знаний: не проверить ({exc})"
    if seen < total:
        return (f"база знаний: ВИДНО НЕ ВСЁ — {seen} документов из {total}; вернулась "
                f"обрезка выборки, часть уроков не достать по имени")
    if chars < 50:
        return "база знаний: ВИДНО НЕ ВСЁ — документ достаётся пустым, проверить kb_get.py"
    return f"база знаний: все {total} документов видны, содержимое достаётся"


def agent_model_watch(hours: int = 24, log_path: str = "") -> str:
    """Слушается ли метка модели на карточках — или заходы тихо идут на умолчании.

    27.08.2026: у DeepSeek Harness модель подменяется сборкой отдельного дома
    (DSH_HOME). Сбой этой сборки НЕ виден со стороны: заход проходит нормально,
    просто на прежней модели, и метка на карточке оказывается декорацией.
    Будильник в таком случае пишет в журнал строку «иду на умолчании» —
    вылавливаем именно её, а заодно считаем, сколько заходов с меткой вообще
    состоялось: ноль за сутки при живых предупреждениях тоже отказ.
    """
    # Путь параметром — чтобы проверку самого сторожа можно было прогнать на
    # подставном журнале, не трогая настоящий.
    log = pathlib.Path(log_path or pathlib.Path.home()
                       / ".local/state/taskflow-trigger/trigger.log")
    if not log.is_file():
        return "метки моделей: журнал будильника не найден — не проверить"
    cutoff = time.time() - hours * 3600
    fell_back, with_model = 0, 0
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("["):
            continue
        try:
            ts = time.mktime(time.strptime(line[1:20], "%Y-%m-%d %H:%M:%S"))
        except Exception:
            continue
        if ts < cutoff:
            continue
        if "иду на умолчании" in line:
            fell_back += 1
        elif ", модель " in line and "зову" in line:
            with_model += 1
    if fell_back:
        return (f"метки моделей: СБОЙ ПОДМЕНЫ {fell_back} раз за сутки — заходы шли не на "
                f"той модели, смотреть trigger.log по слову «умолчании»")
    return f"метки моделей: сбоев нет, заходов по метке за сутки — {with_model}"


def phone_installer_watch() -> str:
    """Отвечает ли служба установки приложений на Маке.

    27.08.2026: кнопки «накатить на телефон» в инфра-панели работают только пока на
    Маке жива служба InfraPanelInstaller (launchd, сессия пользователя). Отказ у неё
    тихий: панель просто скажет «Мак не отвечает», а владелец узнает об этом в тот
    момент, когда приложение уже протухло и нужно срочно.

    Спящий или выключенный Мак — НЕ тревога: он не обязан быть в сети. Тревога — Мак
    отвечает по сети, а служба на нём молчит.
    """
    import socket
    import urllib.error
    import urllib.request

    host = "MacBook-Pro-Maksim.local"
    try:
        addr = socket.getaddrinfo(host, 22, socket.AF_INET)[0][4][0]
    except OSError:
        return "установка на телефон: Мак не в сети — проверка отложена"

    # Мак в сети: сначала убеждаемся, что жив он сам, потом спрашиваем службу.
    try:
        with socket.create_connection((addr, 22), timeout=5):
            pass
    except OSError:
        return "установка на телефон: Мак не в сети — проверка отложена"

    # МИМО ПРОКСИ. В окружении .110 стоит HTTP_PROXY (Happ), а Мака нет в no_proxy —
    # urllib честно уходил на прокси и получал 503, то есть проверка кричала бы
    # «служба молчит» при живой службе. Сосед по локальной сети через прокси не
    # ходит по определению.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://{host}:8791/health", timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return (f"установка на телефон: СЛУЖБА МОЛЧИТ — Мак в сети, а приёмник на нём "
                f"не отвечает ({exc}); кнопки в панели работать не будут")

    last = data.get("last") or {}
    итог = ""
    if last:
        итог = (", последняя установка удалась" if last.get("ok")
                else ", последняя установка НЕ УДАЛАСЬ")
    видно = "телефон на связи" if data.get("device") else "телефон не виден"
    return f"установка на телефон: служба жива, {видно}{итог}"


def vpn_watch() -> str:
    """Связь TaskFlow↔Linear: xray-claude, drop-in с HTTPS_PROXY, выходной IP.

    Запускает infra-vpn-watch.py и парсит его вывод: «sent: N проблем» — есть
    проблемы, «exit: 0» — всё ок. Возвращает готовую строку для сводки.

    ВАЖНО: НЕ дублирует логику infra-vpn-watch.py — он сам шлёт разовые алерты
    в общий канал, и утренняя сводка должна показать то же состояние глазами
    владельца. Поэтому импортируем его, а не копируем проверки.
    """
    import subprocess
    script = pathlib.Path.home() / "infra-ops" / "infra-vpn-watch.py"
    if not script.is_file():
        return "VPN/прокси TaskFlow↔Linear: скрипт-страж не найден"
    try:
        out = subprocess.run(
            ["python3", str(script)],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return "VPN/прокси TaskFlow↔Linear: страж завис (>60с) — проверить вручную"
    # Скрипт печатает "sent: N проблем" если есть тревоги, иначе просто exit 0
    if "sent:" in out.stdout:
        return f"VPN/прокси TaskFlow↔Linear: {out.stdout.strip()} — смотреть inbox/{datetime.now():%Y-%m-%d}/"
    if out.returncode == 0:
        return "VPN/прокси TaskFlow↔Linear: xray-claude жив, drop-in на месте, Linear через прокси отвечает"
    return f"VPN/прокси TaskFlow↔Linear: страж упал с кодом {out.returncode} — {out.stderr[:120]}"




def ai_stack_update_watch() -> str:
    """Сторож еженедельного обновления Ollama/Mnemosyne (ai-stack-update.py, 13.10.2026):
    проверки не было больше 8 суток — таймер молчит; последняя закончилась откатом — сказать."""
    from datetime import datetime as _dt
    path = os.path.expanduser("~/.local/state/ai-stack-update/last.json")
    try:
        d = json.load(open(path))
    except Exception:
        return "обновление ИИ-стека: ещё не запускалось (первый прогон в воскресенье 04:30)"
    age = (_dt.now() - _dt.fromisoformat(d["at"])).days
    if age > 8:
        return f"обновление ИИ-стека: ТАЙМЕР МОЛЧИТ — последняя проверка {age} дн. назад"
    return "обновление ИИ-стека: " + ("в порядке" if d.get("ok") else "ПРОБЛЕМА на последней проверке — " + "; ".join(d.get("report", []))[:200])


def main() -> int:
    # Каждая проверка возвращает готовую строку для Максима. Тревожной считается та,
    # что содержит СВОЙ признак беды: сверять по одному общему слову нельзя — тексты
    # правятся, и 26.08.2026 условие уже разошлось с текстом («ОБРЕЗАНО» против
    # «ПОТЕРЯН ХВОСТ»), из-за чего настоящая находка не попала бы в тревогу.
    #
    # Признаков у проверки может быть НЕСКОЛЬКО — она умеет находить разные беды.
    # У зеркала их две: сторож не запускается вовсе И правки лежат неразобранными;
    # пока признак был один, вторая половина проверки никогда не поднимала тревогу —
    # тихий отказ внутри самого детектора тихих отказов.
    # Владелец 27.09.2026: этот список — ВНУТРЕННИЙ (агентский) набор проверок,
    # не выводится ему построчно, только счётчиком в человеческой сводке ниже.
    # Маркер compact_recall_live поправлен под новый текст функции ("МЕДЛЕННАЯ"
    # вместо старого "НЕТ —" — иначе строка тише перестала бы ловиться).
    internal_checks = [
        (memory_summary(), ["НИ ОДНОЙ"]),
        (compact_recall_patch(), ["ПРОПАЛА"]),
        (compact_recall_live(), ["МЕДЛЕННАЯ"]),
        (agent_model_watch(), ["СБОЙ ПОДМЕНЫ", "не проверить"]),
        (ai_stack_update_watch(), ["ТАЙМЕР МОЛЧИТ", "ПРОБЛЕМА"]),
    ]

    # (проверка, маркеры_беды, человеческая_строка_ок, человеческая_строка_беда)
    # Владелец 27.09.2026: это реально касается ЕГО — доставка тревог, сохранность
    # заметок и правок, база знаний, установка на телефон. Маркер delivery_watch
    # поправлен: функция пишет "НЕ УШЛО", старый маркер "НЕ ДОШЛО" никогда не
    # совпадал — доставка тревог могла молча не поднимать общий "уровень".
    owner_checks = [
        (delivery_watch(), ["НЕ УШЛО"],
         "Доставка уведомлений: всё доходит без потерь.",
         "Доставка уведомлений: часть тревог за сутки не дошла до вас — есть проблема с каналом, детали смотрит агент."),
        (truncation_watch(), ["ПОТЕРЯН ХВОСТ"],
         "Сохранность заметок: всё цело, потерь текста не найдено.",
         "Сохранность заметок: часть текста при сохранении могла обрезаться — стоит проверить последние правки."),
        (kb_reachable_watch(), ["ВИДНО НЕ ВСЁ", "не проверить"],
         "База знаний: все документы доступны и находятся по имени.",
         "База знаний: часть документов сейчас не находится по имени — поиск может не показывать то, что реально есть."),
        (phone_installer_watch(), ["СЛУЖБА МОЛЧИТ", "НЕ УДАЛАСЬ"],
         "Установка на телефон: кнопка в панели работает.",
         "Установка на телефон: кнопка в панели сейчас не сработает — служба на Маке не отвечает."),
        (vpn_watch(), ["смотреть inbox", "завис", "упал", "не найден"],
         "VPN/прокси TaskFlow↔Linear: цепочка работает штатно.",
         "VPN/прокси TaskFlow↔Linear: цепочка под угрозой — детали в уведомлении стража."),
    ]
    unit_lines = []
    unit_broken = []
    for unit, human in UNITS.items():
        state = unit_state(unit)
        unit_lines.append(f"{human}: {state}")
        if state != "active":
            unit_broken.append(f"{human}: {state}")

    internal_lines = [t for t, _ in internal_checks]
    owner_lines = [t for t, _, _, _ in owner_checks]
    broken = (
        [t for t, bad in internal_checks if any(b in t for b in bad)]
        + [t for t, bad, _, _ in owner_checks if any(b in t for b in bad)]
        + unit_broken
    )
    level = "error" if broken else "ok"

    # Человеческая сводка для карточки в приложении (владелец 27.09.2026) — идёт
    # ОТДЕЛЬНО от `text` ниже, не влияет на детекцию тревоги, только на то, что
    # видно в "## Сводка (для отображения в приложении)".
    owner_summary_lines = [
        (bad_text if any(b in t for b in bad) else ok_text)
        for t, bad, ok_text, bad_text in owner_checks
    ]
    internal_broken_count = len(
        [t for t, bad in internal_checks if any(b in t for b in bad)]
    ) + len(unit_broken)
    internal_total = len(internal_checks) + len(UNITS)
    if internal_broken_count:
        owner_summary_lines.append(
            f"Системные технические проверки (память агентов, модели, сервисы): "
            f"{internal_broken_count} из {internal_total} требуют внимания — агент разберётся сам."
        )
    else:
        owner_summary_lines.append(
            f"Системные технические проверки (память агентов, модели, сервисы): "
            f"всё в порядке ({internal_total}/{internal_total})."
        )
    summary = "\n".join(owner_summary_lines)

    title = "Автономность .110 — сводка за сутки"
    text = "\n".join(internal_lines + owner_lines + unit_lines)
    # Сводка — тот самый сторож, который обязан доложить о потерях. Раньше он шёл
    # ровно тем же каналом, о поломке которого докладывает: n8n лёг → сводка о том,
    # что тревоги теряются, тоже пропала (ночь на 27.08.2026). Теперь при мёртвом
    # основном канале отчёт уходит ЦЕЛИКОМ запасной дорогой, мимо n8n и посредника.
    if not send("autonomy-110", level, title, text, summary=summary):
        if send_direct(f"{title}\n{summary}"):
            print("основной канал молчит — сводка ушла запасной дорогой")
        else:
            print("НИ ОДИН путь не сработал — сводка не доставлена", file=sys.stderr)
    print(text)
    print("--- человеку ---")
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
