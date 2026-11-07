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
  • `strip_control(message)` — убирает \\x00..\\x1f, КРОМЕ \\n (0x0A),
    \\r (0x0D) и \\t (0x09). Сообщение приходит от роли TaskFlow и
    может содержать переводы строк и кавычки, которые должны доходить
    до Codex-чата буквально (уточнение ведущего 2026-10-10
    в комментарии 97d9b075; требование V2 карточки 905db3e3-…: «Перевод
    строки, backslash проходят на receiver ровно как на стороне сервера»).
    POSIX `shlex.quote` корректно передаёт \\n/\\r внутри одинарных
    кавычек, поэтому truncation был лишним.

Переводы строк и кавычки передаются БУКВАЛЬНО: strip_control не режет
\\n/\\r/\\t, а только опасные control-символы (NUL, BEL и т.п.). Кавычки
(`'`, `"`, `\``) и backslash проходят как есть и безопасно экранируются
`shlex_quote_argv` дальше по стеку.
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
    """Убирает опасные control-символы U+0000..U+001F, КРОМЕ \\n (0x0A),
    \\r (0x0D) и \\t (0x09). Переводы строк и табы проходят буквально —
    POSIX `shlex.quote` корректно обрабатывает их внутри одинарных кавычек
    (уточнение ведущего 2026-10-10 в комментарии 97d9b075: «Переводы
    строк и кавычки должны передаваться буквально, не truncation»).
    """
    if message is None:
        return ""
    return "".join(ch for ch in message if ord(ch) >= 0x20 or ch in "\n\r\t")


def shlex_quote_argv(argv: Iterable[str]) -> List[str]:
    """POSIX-safe экранирование аргументов, готовых к подстановке в
    shell-команду через пробел."""
    return [shlex.quote(str(a)) for a in argv]