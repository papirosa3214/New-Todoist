#!/usr/bin/env python3
"""POSIX-safe shell quoting и валидация аргументов для скриптов wake/webhook.

Используется в `tf_wake_dispatch.py` и `tf_webhook_proto.py` — общая
утилита, чтобы не разъезжались правила. Карточка 905db3e3-… (D-4):
раньше Python `repr()` для `--message` не был POSIX-safe: `\\`,
управляющие символы и переводы строк проходили искажённо, а UUID
треда подставлялся без `shlex.quote`.

Правила:
  • `shlex_quote_argv(argv)` — POSIX-safe экранирование списка (для
    `subprocess.run(["ssh", mac, " ".join(quoted)])`).
  • `validate_codex_thread(thread_uuid)` — UUID regex; иначе exit 64.
  • `strip_control(message)` — убирает \\x00..\\x1f (включая \\n/\\r);
    сообщение приходит от роли TaskFlow и может содержать что угодно,
    в т.ч. переводы строк из заголовков задач.

Переводы строк и кавычки должны передаваться БУКВАЛЬНО: поэтому
strip_control режет их, а не пытается «экранировать» в shell. Получатель
видит усечённый текст без управляющих символов — это безопаснее, чем
ломать shell-quoting в попытке сохранить байт-в-байт.
"""
import re
import shlex
from typing import Iterable, List

CODEX_THREAD_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def validate_codex_thread(thread_uuid: str) -> str:
    """Бросает ValueError на нераспознаваемой форме, иначе возвращает строку."""
    if not isinstance(thread_uuid, str) or not CODEX_THREAD_UUID_RE.match(thread_uuid):
        raise ValueError(
            f"codex_thread_uuid должен быть UUID вида 8-4-4-4-12 hex; получено: {thread_uuid!r}"
        )
    return thread_uuid


def strip_control(message: str) -> str:
    """Убирает управляющие символы U+0000..U+001F (включая \\n, \\r, \\t)."""
    if message is None:
        return ""
    return "".join(ch for ch in message if ord(ch) >= 0x20 or ch == "\t")


def shlex_quote_argv(argv: Iterable[str]) -> List[str]:
    """POSIX-safe экранирование аргументов, готовых к подстановке в
    shell-команду через пробел."""
    return [shlex.quote(str(a)) for a in argv]