#!/usr/bin/env python3
"""Минимальный прототип приёмника webhook для шага hook_contract.

Поднимает HTTP на 127.0.0.1 (порт по выбору системы), принимает события от
серверного цикла доставки. Это **не** боевой сервер, а изолированный
тестовый приёмник: поднимается на время проверки, не пишет в основную
инфраструктуру (TaskFlow-сервер на .110 остаётся нетронутым).

Использование:
    python3 tf_webhook_recv.py [максимум_секунд]

Выходит по таймауту или SIGINT. Печатает каждое принятое событие в stdout
в виде `EVENT <json>`; итоговая статистика уходит в stderr.

Секрет: если переменная WEBHOOK_SECRET задана, проверяет заголовок
«X-Webhook-Signature: sha256=<hmac>», иначе принимает без проверки.
"""
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ.get("WEBHOOK_SECRET", "")
MAX_S = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0

EVENTS: list[dict] = []
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        if SECRET:
            got = self.headers.get("X-Webhook-Signature", "")
            expect = "sha256:" + hmac.new(
                SECRET.encode(), body, hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(got, expect):
                self.send_response(401)
                self.end_headers()
                return
        try:
            data = json.loads(body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        with LOCK:
            EVENTS.append({
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "path": self.path,
                "headers": {
                    "user-agent": self.headers.get("User-Agent", ""),
                    "x-event-id": self.headers.get("X-Event-Id", ""),
                    "x-webhook-id": self.headers.get("X-Webhook-Id", ""),
                },
                "body": data,
            })
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def main() -> int:
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    print(f"READY http://127.0.0.1:{port}/hook", flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        time.sleep(MAX_S)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    with LOCK:
        for e in EVENTS:
            print("EVENT", json.dumps(e, ensure_ascii=False), flush=True)
        print(f"---\ntotal: {len(EVENTS)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())