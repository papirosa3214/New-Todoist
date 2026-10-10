#!/usr/bin/env python3
"""Серверный wake-канал: постановка follow-up в очередь Codex-чата.

Использование:
    python3 tf_wake_dispatch.py <thread_uuid> <message_text>
    python3 tf_wake_dispatch.py --verify-ack <thread_uuid> <followup_uuid>
    TASKFLOW_CODEX_MAC=max@MacBook-Pro-Maksim.local python3 tf_wake_dispatch.py <UUID> text

Поведение:
  • exit 0, если `codex queue --thread <UUID> --message <TEXT>`
    вернул «Queued message ... for thread ...»;
  • иначе exit 1, и тело stderr — в ленте webhook_wake_queue.last_error;
  • stdout содержит `FOLLOWUP=<UUID>` после успешной постановки
    (используется для различения queued/acked — D-5, карточка 905db3e3-…);
  • `--verify-ack` — режим проверки подтверждения turn started. В текущей
    реализации проверка сводится к поиску UUID в очереди Codex
    (это лишь маркер queued, НЕ реального turn started — уточнение
    ведущего 2026-10-10). Ack возможен только через явный callback
    чата в /api/integrations/webhooks/_wake_ack.

D-4: POSIX-safe quoting через `tf_codex_quote.shlex_quote_argv` —
одиночные backslash, `$`, переводы строк больше не искажаются при
подстановке в shell. UUID валидируется regex.

Сценарий автозапуска: сервер TaskFlow при доставке события подписке,
у которой задан codex_thread_id, вызывает этот скрипт через execFile,
чтобы положить follow-up в очередь desktop-bound ChatGPT.app.
Пробуждение самого ChatGPT.app требует его открытия (отдельная забота
владельца); на стороне сервера мы лишь гарантируем, что сообщение
поступило в очередь.
"""
import os
import re
import subprocess
import sys

# Тот же каталог, что и этот скрипт: ../scripts/orchestrator.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tf_codex_quote import (  # noqa: E402
    shlex_quote_argv,
    strip_control,
    validate_codex_thread,
)


def _queue_cmd(thread_uuid: str, message: str, codex_bin: str) -> list:
    """Собирает argv для `codex queue --thread <UUID> --message <TEXT>`.

    Использует shlex.quote для каждого аргумента — это POSIX-safe и
    работает одинаково для одиночных кавычек, доллара, backslash и
    управляющих символов (последние уже срезаны strip_control).
    """
    return [codex_bin, "queue", "--thread", thread_uuid, "--message", message]


def run_queue(thread_uuid: str, message: str) -> int:
    validate_codex_thread(thread_uuid)
    clean_message = strip_control(message)
    mac = os.environ.get("TASKFLOW_CODEX_MAC", "max@MacBook-Pro-Maksim.local")
    node_bin = "/opt/homebrew/Cellar/node/26.7.0/bin"
    codex_bin = "/opt/homebrew/bin/codex"

    quoted = " ".join(shlex_quote_argv(_queue_cmd(thread_uuid, clean_message, codex_bin)))
    remote_cmd = f"export PATH={shlex.quote(node_bin)}:$PATH; {quoted}"
    ssh_argv = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", mac, remote_cmd]
    try:
        out = subprocess.run(
            ssh_argv,
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        print("TIMEOUT ssh codex queue", file=sys.stderr)
        return 2
    sys.stdout.write(out.stdout)
    sys.stderr.write(out.stderr)
    if out.returncode != 0:
        return out.returncode
    # Парсим UUID follow-up из stdout: «Queued message 01a… for thread …».
    m = re.search(
        r"Queued message\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
        out.stdout or "",
    )
    if m:
        print(f"FOLLOWUP={m.group(1)}", file=sys.stdout)
    return 0


def run_verify_ack(thread_uuid: str, followup_uuid: str) -> int:
    """Ack-проверка. Текущая реализация — поиск UUID в .codex-global-state.json
    на удалённой машине; это показывает ТОЛЬКО queued, не реальный turn started
    (см. комментарий в шапке). Возвращает exit 0, если файл доступен
    (queued-маркер найден), и exit 2 — если нет (ещё не consumed Codex'ом).
    Ack реального turn started идёт через /api/integrations/webhooks/_wake_ack.
    """
    validate_codex_thread(thread_uuid)
    try:
        validate_codex_thread(followup_uuid)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 64
    mac = os.environ.get("TASKFLOW_CODEX_MAC", "max@MacBook-Pro-Maksim.local")
    quoted = shlex.quote(f"~/.codex/.codex-global-state.json")
    remote = (
        f"if [ -f {quoted} ] && grep -q {shlex.quote(followup_uuid)} {quoted}; "
        f"then echo FOUND; else echo MISSING; fi"
    )
    ssh_argv = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", mac, remote]
    try:
        out = subprocess.run(
            ssh_argv,
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        print("TIMEOUT ssh verify-ack", file=sys.stderr)
        return 2
    sys.stdout.write(out.stdout)
    sys.stderr.write(out.stderr)
    if out.returncode != 0:
        return out.returncode
    # exit 0: queued-маркер найден; exit 3: MISSING (queued, но не consumed).
    if "FOUND" in out.stdout:
        return 0
    return 3


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: tf_wake_dispatch.py <thread_uuid> <message>", file=sys.stderr)
        print("       tf_wake_dispatch.py --verify-ack <thread_uuid> <followup_uuid>", file=sys.stderr)
        return 64
    if sys.argv[1] == "--verify-ack":
        if len(sys.argv) != 4:
            print("usage: tf_wake_dispatch.py --verify-ack <thread_uuid> <followup_uuid>", file=sys.stderr)
            return 64
        try:
            return run_verify_ack(sys.argv[2], sys.argv[3])
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 64
    if len(sys.argv) < 3:
        print("usage: tf_wake_dispatch.py <thread_uuid> <message>", file=sys.stderr)
        return 64
    try:
        return run_queue(sys.argv[1], " ".join(sys.argv[2:]))
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 64


if __name__ == "__main__":
    sys.exit(main())