#!/usr/bin/env python3
"""Приёмник вебхука оркестратора (замена сторожа tf_watch.py).

Запускается фоном (run_in_background), ждёт события от сервера TaskFlow и
ЗАВЕРШАЕТСЯ по первому — завершение фоновой команды и будит сессию оркестратора.

Как это устроено (без постоянных секретов):
  1. Поднимает HTTP на 127.0.0.1 (порт выбирает система).
  2. Пишет в реестр-файл адрес и случайный токен (права 0600). Сервер
     (`server/src/lib/orchestratorWebhook.ts`) раз в 2 секунды читает этот файл
     и, если он есть, шлёт накопленные события POST'ом с этим токеном.
     Пока приёмника нет, события лежат в таблице `orchestrator_events`
     (не дольше часа) — запустил приёмник заново, и они придут.
  3. Получив пачку, ждёт ещё 3 секунды (вдруг придут соседние события),
     печатает всё построчно, стирает реестр-файл и выходит с кодом 0.

Запуск:   python3 scripts/orchestrator/tf_hook_wait.py [максимум_минут]
Выход:    EVENT <json>   по строке на событие   — пора реагировать
          TIMEOUT        — за отведённое время (по умолчанию 110 минут) тишина
"""
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REGISTRY = Path(os.environ.get(
    "TASKFLOW_ORCHESTRATOR_HOOK_FILE",
    Path.home() / ".local" / "state" / "taskflow" / "orchestrator-hook.json",
))
MAX_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 110.0
DEBOUNCE_S = 3.0

TOKEN = secrets.token_urlsafe(24)
EVENTS: list[dict] = []
LOCK = threading.Lock()
FIRST = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # тишина в stdout: он нужен только для событий
        pass

    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_response(401); self.end_headers(); return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            events = body.get("events") or []
        except Exception:
            self.send_response(400); self.end_headers(); return
        with LOCK:
            EVENTS.extend(events)
        FIRST.set()
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")


def main() -> int:
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "url": f"http://127.0.0.1:{port}/hook", "token": TOKEN,
        "pid": os.getpid(), "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }))
    os.chmod(tmp, 0o600)
    os.replace(tmp, REGISTRY)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        got = FIRST.wait(timeout=MAX_MIN * 60)
        if got:
            time.sleep(DEBOUNCE_S)  # соседние события одной пачки
            with LOCK:
                for e in EVENTS:
                    print("EVENT", json.dumps(e, ensure_ascii=False), flush=True)
        else:
            print("TIMEOUT", flush=True)
    finally:
        try:
            REGISTRY.unlink()
        except FileNotFoundError:
            pass
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
