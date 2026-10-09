#!/usr/bin/env python3
"""Серверный wake-канал: постановка follow-up в очередь Codex-чата.

Использование:
    python3 tf_wake_dispatch.py <thread_uuid> <message_text>
    TASKFLOW_CODEX_MAC=max@MacBook-Pro-Maksim.local python3 tf_wake_dispatch.py <UUID> text

Поведение:
  • exit 0, если `codex queue --thread <UUID> --message <TEXT>`
    вернул «Queued message ... for thread ...»;
  • иначе exit 1, и тело stderr — в ленте webhook_wake_queue.last_error.

Сценарий автозапуска: сервер TaskFlow при доставке события подписке,
у которой задан codex_thread_id, вызывает этот скрипт через
execFile, чтобы положить follow-up в очередь desktop-bound ChatGPT.app.
Пробуждение самого ChatGPT.app требует его открытия (отдельная забота
владельца); на стороне сервера мы лишь гарантируем, что сообщение
поступило в очередь.

Этот скрипт — серверная замена `tf_webhook_proto.py`: тот был изолированным
QA-инструментом и не должен вызываться из боевой доставки.
"""
import os
import subprocess
import sys


def run(thread_uuid: str, message: str) -> int:
    mac = os.environ.get("TASKFLOW_CODEX_MAC", "max@MacBook-Pro-Maksim.local")
    node_bin = "/opt/homebrew/Cellar/node/26.7.0/bin"
    codex_bin = "/opt/homebrew/bin/codex"
    cmd = (
        f"export PATH={node_bin}:$PATH; "
        f"{codex_bin} queue --thread {thread_uuid} --message {message!r}"
    )
    try:
        out = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", mac, cmd],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        print("TIMEOUT ssh codex queue", file=sys.stderr)
        return 2
    sys.stdout.write(out.stdout)
    sys.stderr.write(out.stderr)
    return out.returncode


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tf_wake_dispatch.py <thread_uuid> <message>", file=sys.stderr)
        return 64
    return run(sys.argv[1], " ".join(sys.argv[2:]))


if __name__ == "__main__":
    sys.exit(main())
