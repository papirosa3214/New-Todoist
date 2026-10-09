#!/usr/bin/env python3
"""Минимальный прототип пробуждения Codex-чата через `codex queue`.

Использование:
    python3 tf_webhook_proto.py <thread_uuid> "тестовое сообщение"
    python3 tf_webhook_proto.py --dry-run <thread_uuid> "тестовое сообщение"

Делает:
1. Подключается по SSH к Mac, указанному в TASKFLOW_CODEX_MAC (по умолчанию
   MacBook-Pro-Maksim.local), под пользователем из USER (или переданной).
2. Запускает `codex queue --thread <UUID> --message<TEXT>` (с PATH,
   включающим node 26.7.0).
3. Возвращает 0 при `Queued message ... for thread ...`, иначе 1.

Этот скрипт — **доказательство**, что путь wake работает на живой системе,
а не HTTP-эхо. Использовать в QA как один из проверочных сценариев:
- POST на webhook → перейти в чат Codex → убедиться, что сообщение появилось.

Не использовать для боевой доставки — это инструмент проверки.
"""
import os
import subprocess
import sys


def run(thread_uuid: str, message: str, dry_run: bool = False) -> int:
    mac = os.environ.get("TASKFLOW_CODEX_MAC", "max@MacBook-Pro-Maksim.local")
    node_bin = "/opt/homebrew/Cellar/node/26.7.0/bin"
    codex_bin = "/opt/homebrew/bin/codex"
    cmd = (
        f"export PATH={node_bin}:$PATH; "
        f"{codex_bin} queue --thread {thread_uuid} --message {message!r}"
    )
    if dry_run:
        print(f"DRY-RUN ssh {mac} {cmd}", flush=True)
        return 0
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
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 0
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    if len(args) < 2:
        print("usage: tf_webhook_proto.py [--dry-run] <thread_uuid> <message>",
              file=sys.stderr)
        return 2
    return run(args[0], args[1], dry_run=dry)


if __name__ == "__main__":
    sys.exit(main())