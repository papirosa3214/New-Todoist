#!/usr/bin/env python3
"""Посредник между n8n и Telegram: принимает текст на :8099/send и отдаёт его боту.

28.08.2026. Раньше здесь была ОДНА попытка отправки, и если она срывалась — сообщение
исчезало без следа: наверх уходил только код 502, а причина не сохранялась нигде. За две
недели так пропало 10 тревог (9 сорванных прогонов в истории n8n плюс один зависший), и
понять по ним, что именно случилось, было нельзя.

Теперь: до трёх попыток с короткими паузами и ЖУРНАЛ — и на потерю, и на «сорвалось, но
со второго раза дошло». Второе важно не меньше: канал, который шатается, обязан быть
виден до того, как начнёт терять.

Маршруты. 24.10.2026 добавлен второй маршрут — напрямую, без прокси: он не зависит от
xray и потому работает даже тогда, когда весь прокси-стек лежит (именно это было
ночью 23→24.10 — 47 отправок потеряно из-за отказа прокси).

Бюджет времени. Цепочка синхронная: отправитель ждёт n8n, n8n ждёт нас. Если растянуть
повторы, отправитель отвалится по своему тайм-ауту на сообщении, которое мы всё-таки
доставим, — и в журнал попадёт потеря, которой не было. Поэтому худший случай здесь
ограничен ~20 секундами: 8 + пауза + 5 + пауза + 5.

Разбор ответа Telegram: «can't parse entities» повтором не лечится (текст тот же), тут
работает прежнее понижение до простого текста. Прочие отказы 4xx — это отказ по существу,
повторять их тоже бессмысленно. Повторяем только то, что похоже на сбой связи.
"""
import json
import os
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = os.environ["BOT_TOKEN"]
CHAT = os.environ["CHAT_ID"]
PROXY = os.environ.get("SOCKS", "192.168.1.110:10810")
RELAY_NAME = os.environ.get("RELAY_NAME", "tg-relay")

# Журнал лежит на хозяйской машине (том в docker-compose.yml): утренняя сводка читает
# его оттуда. Внутри контейнера файл никому не нужен — он умрёт вместе с ним.
JOURNAL = os.environ.get("RELAY_JOURNAL", "/log/relay-undelivered.log")

# Порт параметром — чтобы проверку «оборванная отправка» можно было прогнать вторым
# экземпляром, не останавливая рабочий посредник. В контейнере остаётся 8099.
PORT = int(os.environ.get("RELAY_PORT", "8099"))

# Попытки: (маршрут, сколько ждать ответа, сколько ждать перед следующей). Первая
# попытка щедрая — чтобы не потерять просто медленный ответ; повторы короткие.
#
# 24.10.2026. Добавлен ВТОРОЙ маршрут — напрямую, без SOCKS-прокси xray.
# Ночью 23→24.10 весь прокси-стек лежал (xray-target-guard: «ни один сервер не
# пускает к цели»), и посредник ходил в Telegram только через xray-bots — 47 отправок
# сорвались с «нет ответа, curl вернул код 28». Из сети контейнера api.telegram.org
# виден и без прокси (проверено: 401 на фиктивном токене за 0.15 с), поэтому прямой
# маршрут не имеет общих точек отказа с xray и спасает тревогу, когда прокси лежит.
# Порядок и бюджет времени прежние: прокси → прямой → снова прокси.
ATTEMPTS = (("proxy", 8, 1.5), ("direct", 6, 1.5), ("proxy", 5, 0))

# В тексте ошибки curl попадается сам адрес запроса, а в нём — токен бота. В журнал
# такое писать нельзя: журнал потом цитируется в сводке и в переписке.
TOKEN_RE = re.compile(r"bot\d{5,}:[A-Za-z0-9_-]+")


def _clean(msg: str) -> str:
    """Убрать токен бота из текста, в любом виде. Длину НЕ трогаем: этим же ответом
    отвечаем n8n, а он ждёт целый JSON — обрезанный он считает битым и роняет прогон
    на успешной отправке (наступил на это при контрольной 28.08.2026)."""
    out = TOKEN_RE.sub("bot***", msg or "")
    if TOKEN:
        out = out.replace(TOKEN, "***")
    return out.strip()


def _short(msg: str) -> str:
    """То же, но коротко — для журнала, где нужна причина, а не полный ответ."""
    return _clean(msg)[:300]


def _journal(status: str, text: str, reason: str, attempts: int, route: str = "") -> None:
    """Строка в журнал. Журнал — вспомогательный: его отказ не должен ронять отправку."""
    try:
        os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            # Секунды рядом с датой намеренно: контейнер и машина живут в разных
            # часовых поясах, и счёт «за последние сутки» по одной только дате врал бы
            # на три часа — потеря у границы окна выпадала бы из сводки.
            "ts_epoch": int(time.time()),
            "relay": RELAY_NAME,
            "status": status,               # lost — потеряно; recovered — дошло с повтора
            "attempts": attempts,
            "route": route,                 # каким маршрутом ушло (proxy/direct)
            "title": re.sub(r"<[^>]+>", "", (text or "").strip().split("\n")[0])[:120],
            "error": _short(reason),
        }
        with open(JOURNAL, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001 — журнал не важнее самой доставки
        print(f"журнал недоступен: {exc}", flush=True)


def _post(text, chat, use_html, timeout, route="proxy"):
    """Отправить сообщение по маршруту: 'proxy' — через SOCKS, 'direct' — напрямую."""
    args = ["curl", "-s", "-m", str(timeout)]
    if route == "proxy":
        args += ["--socks5-hostname", PROXY]
    args += ["https://api.telegram.org/bot%s/sendMessage" % TOKEN,
            "--data-urlencode", "chat_id=%s" % chat,
            "--data-urlencode", "text=%s" % text,
            "--data-urlencode", "disable_web_page_preview=true"]
    if use_html:
        args += ["--data-urlencode", "parse_mode=HTML"]
    r = subprocess.run(args, capture_output=True, text=True)
    # Пустой ответ = curl не дошёл (тайм-аут, отказ прокси). Своей строки об этом он не
    # даёт, поэтому подписываем код возврата сами — иначе в журнале будет пустая причина.
    out = r.stdout or r.stderr
    if not (out or "").strip():
        out = "нет ответа, curl вернул код %s" % r.returncode
    return out


def _ok(out: str) -> bool:
    return '"ok":true' in out


def _retryable(out: str) -> bool:
    """Стоит ли пробовать снова. Отказ по существу (Telegram ответил и объяснил, что не
    так) повтором не чинится — повторяем только похожее на обрыв связи."""
    if '"ok":false' in out and '"error_code"' in out:
        return '"error_code":5' in out          # 5xx на стороне Telegram — можно ещё раз
    return True                                  # ответа нет вовсе: тайм-аут, прокси, сеть


def send(text, chat):
    last = ""
    for n, (route, timeout, pause) in enumerate(ATTEMPTS, start=1):
        out = _post(text, chat, True, timeout, route)

        # Битый HTML Telegram не примет никогда — повторять нечего, снимаем теги и шлём
        # простым текстом. Это прежнее поведение, оно себя оправдало на дайджестах.
        if not _ok(out) and "can't parse entities" in out:
            out = _post(re.sub(r"<[^>]+>", "", text), chat, False, timeout, route)

        if _ok(out):
            if n > 1:
                _journal("recovered", text, last, n, route)
            return out, n

        last = out
        if not _retryable(out) or pause == 0:
            break
        time.sleep(pause)

    _journal("lost", text, last, n, route)
    return last, n


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"ok\":true}")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            d = json.loads(raw or b"{}")
        except Exception:
            d = {}
        text = str(d.get("text", "")).strip() or "(empty)"
        chat = d.get("chat_id") or CHAT
        out, attempts = send(text, chat)
        ok = _ok(out)
        # Отказ по-прежнему уходит наверх кодом 502: n8n должен видеть сорванный прогон,
        # а отправитель — записать потерю у себя. Журнал здесь их не заменяет.
        self.send_response(200 if ok else 502)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(_clean(out).encode())
        if not ok:
            print("не отправлено за %d попыт(ки): %s" % (attempts, _short(out)), flush=True)

    def log_message(self, *a):
        return


print("tg-relay (%s) on :%d, журнал %s" % (RELAY_NAME, PORT, JOURNAL), flush=True)
HTTPServer(("0.0.0.0", PORT), H).serve_forever()
