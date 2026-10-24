#!/usr/bin/env python3
"""
Dedupe typography — устраняет конкуренцию font-{weight} / text-{size} с tf-*
ступенями в className-блоках .ts/.tsx файлов веб-приложения New-Todoist.

Критерии приёмки MAK-47 (задача 445e106b):
- В `src/` нет кеглей и весов вне шкалы, кроме обоснованных исключений.
- Шкала в DESIGN.md и src/index.css задаёт размер+вес+трекинг разом,
  «класс подменяться не должен».

Правила:
1. Если в className встретились одновременно `tf-<ступень>` и
   `font-{thin|extralight|light|normal|medium|semibold|bold|extrabold|black|heavy}`,
   утилита убирается (ступень уже задаёт вес).
2. Если в className встретился `text-{xs|sm|base|lg|xl}` БЕЗ `tf-*`,
   он заменяется на ближайшую ступень:
     text-xs  -> tf-caption  (если рядом uppercase tracking-wider)  иначе tf-caption
                (а в полях ввода — tf-input)
     text-sm  -> tf-action    (в полях ввода — tf-input)
     text-base-> tf-body      (в полях ввода — tf-input)
     text-lg  -> tf-title
     text-xl  -> tf-task-title
3. Если в className встретился `font-{weight}` БЕЗ `tf-*` и БЕЗ `text-{size}`,
   утилита убирается; если получившийся className окажется без типа,
   добавляется `tf-body` как ступень по умолчанию для текста.
4. Исключение: `text-[9px]` в src/components/UpcomingCalendar.tsx —
   задокументировано, не трогаем.

Сомнительные кейсы (например, `text-sm` рядом с `font-semibold` в плашке
или `text-lg font-light` в title) собираются в отчёт
`docs/2026-10-05-typography-mak-47/dedupe-report.md` рядом со скриншотами.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src (Временно приостановлена разработка)"
REPORT_PATH = REPO_ROOT / "docs" / "2026-10-05-typography-mak-47" / "dedupe-report.md"

# Классы шкалы, ровно как в src/index.css @layer components.
TF_CLASSES = (
    "tf-title-large",
    "tf-task-title",
    "tf-title",
    "tf-input",
    "tf-body",
    "tf-row",
    "tf-action",
    "tf-meta",
    "tf-caption",
    "tf-micro",
)

FONT_WEIGHT_RE = re.compile(
    r"\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|heavy)\b"
)
TEXT_SIZE_RE = re.compile(r"\btext-(?:xs|sm|base|lg|xl)\b")

# Маппинг text-{size} -> ступень. Учитывает контекст «поле ввода».
TEXT_SIZE_MAP_DEFAULT = {
    "xs": "tf-caption",
    "sm": "tf-action",
    "base": "tf-body",
    "lg": "tf-title",
    "xl": "tf-task-title",
}
TEXT_SIZE_MAP_INPUT = {
    "xs": "tf-input",   # нежелательно, но лучшее из шкалы
    "sm": "tf-input",
    "base": "tf-input",
    "lg": "tf-input",
    "xl": "tf-input",
}

# Разрешённые «вне шкалы» кейсы (размеры, которые нельзя трогать).
ALLOWED_OUTSIDE_SIZES = (
    "text-[9px]",  # UpcomingCalendar, компакт-режим, задокументировано
)

# Файлы, в которых допускаются конкретные размеры вне шкалы.
ALLOWED_FILE_OVERRIDES = {
    "src (Временно приостановлена разработка)/components/UpcomingCalendar.tsx": {"text-[9px]"},
}

CLASSNAME_RE = re.compile(r'className=("([^"]*)"|\'([^\']*)\')')


CLASSNAME_TPL_RE = re.compile(r'className=\{`([^`]*)`\}', re.DOTALL)
# В template-literal разбиваем на статические сегменты между ${…}.
TPL_INTERP_RE = re.compile(r'\$\{[^}]*\}')
# Допустимые алиасы backtick-частей: если сегмент содержит ${…} — это динамика,
# парсим только статические префикс/суффикс каждого куска.


def normalize_tpl(tpl_body: str, file_path: str, line_no: int) -> tuple[str, list[str]]:
    """Для className={`X ${dyn} Y`} — нормализуем статические сегменты,
    учитывая tf-* и font-* во ВСЁМ template-literal.
    """
    notes: list[str] = []
    # Соберём все статические сегменты и интерполяции.
    static_segments: list[tuple[int, int]] = []  # (start, end) в tpl_body
    interp_segments: list[tuple[int, int, str]] = []  # (start, end, group0)
    last_end = 0
    for m in TPL_INTERP_RE.finditer(tpl_body):
        if m.start() > last_end:
            static_segments.append((last_end, m.start()))
        interp_segments.append((m.start(), m.end(), m.group(0)))
        last_end = m.end()
    if last_end < len(tpl_body):
        static_segments.append((last_end, len(tpl_body)))

    # Соберём все токены из всех статических сегментов, чтобы решить,
    # применять ли правило A (tf-* + font-*) ко всему tpl_body.
    all_tokens: list[str] = []
    for s, e in static_segments:
        all_tokens.extend(split_classname_block(tpl_body[s:e]))
    has_tf_in_static = any(t in TF_CLASSES for t in all_tokens)
    has_text_in_static = any(TEXT_SIZE_RE.fullmatch(t) for t in all_tokens)

    # Применяем normalize_block к каждому статическому сегменту с учётом
    # контекста всего tpl.
    pieces: list[str] = []
    for s, e in static_segments:
        seg = tpl_body[s:e]
        new_seg, seg_notes = normalize_block(
            seg,
            file_path,
            line_no,
            ctx_has_tf=has_tf_in_static,
            ctx_has_text=has_text_in_static,
        )
        if seg_notes:
            notes.extend(seg_notes)
        pieces.append(new_seg)

    # Склеиваем обратно в порядке:
    # static[0] + interp[0] + static[1] + interp[1] + ... + static[N]
    result: list[str] = []
    for idx, (s, e) in enumerate(static_segments):
        result.append(pieces[idx])
        if idx < len(interp_segments):
            _, _, grp = interp_segments[idx]
            result.append(grp)
    return "".join(result), notes



def is_in_input_context(line: str, span_start: int) -> bool:
    """Грубая эвристика: className рядом с <input / <textarea / <select /
    contenteditable — поле ввода, значит tf-input.
    """
    window = line[max(0, span_start - 200): span_start + 400].lower()
    return any(
        tag in window
        for tag in (
            "<input",
            "<textarea",
            'type="text"',
            'type="email"',
            'type="password"',
            'type="search"',
            'type="number"',
            "contenteditable",
        )
    )


def split_classname_block(block: str) -> list[str]:
    """Разбивает className-блок на токены, сохраняя порядок."""
    return [c for c in block.split() if c]


def apply_token_diff(block: str, to_remove: set[str], to_replace: dict[str, str]) -> str:
    """Применяет к className-строке:
      - удаление токенов из to_remove (полное совпадение слова),
      - замену to_replace (полное совпадение слова) на новый токен.
    Пробелы и переводы строк между токенами сохраняются как есть.
    """
    # Паттерн: токен из word-символов и дефиса, НЕ внутри строки/интерполяции.
    # В нашем block нет ${…} и кавычек (только whitespace), так что
    # просто \b\w[-\w]*\b достаточно.
    token_re = re.compile(r'(?<![A-Za-z0-9_\-\[])([A-Za-z][A-Za-z0-9_\-]*)(?![A-Za-z0-9_\-\]])')

    def repl(m: re.Match) -> str:
        t = m.group(1)
        if t in to_remove:
            return ""
        if t in to_replace:
            return to_replace[t]
        return t

    out = token_re.sub(repl, block)
    # Схлопываем лишние пробелы (2+ → 1) только между токенами, не трогая
    # ведущий/концевой пробел блока.
    out = re.sub(r'(?<= ) +', '', out)
    return out





def normalize_block(
    block: str,
    file_path: str,
    line_no: int,
    ctx_has_tf: bool | None = None,
    ctx_has_text: bool | None = None,
) -> tuple[str, list[str]]:
    """Возвращает (new_block, notes) — изменения и пояснения для отчёта.

    Безопасные правила (ничего не ломают визуально):
      A) tf-* + font-{weight}  →  убрать font-{weight} (ступень уже задаёт вес).
      B) text-{xs|sm|base|lg|xl}  без tf-*  →  заменить на ближайшую ступень.
         Заодно убрать font-{weight}, если он остался (ступень уже задаёт вес).
      C) font-{weight}  БЕЗ tf-* и БЕЗ text-{size}  →  оставить как есть и
         собрать в отчёт.

    ctx_has_tf / ctx_has_text — контекст всего template-literal (или всего
    className=...). Если передан, учитываем ПРИНЯТИЕ РЕШЕНИЯ по tf-*/text-*
    на уровне всего выражения, а не одного сегмента. Это важно для
    template literals, где tf-* и font-* могут быть в разных ${…}-частях.
    """
    notes: list[str] = []
    to_remove: set[str] = set()
    to_replace: dict[str, str] = {}

    tokens = split_classname_block(block)
    local_has_tf = any(t in TF_CLASSES for t in tokens)
    font_weight_tokens = [t for t in tokens if FONT_WEIGHT_RE.fullmatch(t)]
    text_size_tokens = [t for t in tokens if TEXT_SIZE_RE.fullmatch(t)]

    # Контекст: если передали ctx_has_tf — используем его; иначе local.
    has_tf = local_has_tf if ctx_has_tf is None else bool(ctx_has_tf)
    has_text_anywhere = (
        bool(text_size_tokens)
        if ctx_has_text is None
        else bool(ctx_has_text)
    )

    # A) tf-* + font-{weight}: убрать font-{weight}.
    if has_tf and font_weight_tokens:
        for t in font_weight_tokens:
            to_remove.add(t)
        notes.append(f"  A) убраны font-* поверх tf-*: {sorted(font_weight_tokens)}")

    # B) text-{size} без tf-*: заменить на ступень. После замены проверим,
    # не появился ли конфликт с font-{weight} (ступень уже задаёт вес).
    if text_size_tokens and not has_tf:
        in_input = is_in_input_context(block, 0)
        for t in text_size_tokens:
            size = t.split("-", 1)[1]
            step = (
                TEXT_SIZE_MAP_INPUT[size]
                if in_input
                else TEXT_SIZE_MAP_DEFAULT[size]
            )
            to_replace[t] = step
        notes.append(
            f"  B) text-* без tf-* → tf-*: {[(t, to_replace[t]) for t in text_size_tokens]}"
        )
        # Теперь у нас есть tf-*, и font-{weight}, если он был, надо снять.
        if font_weight_tokens:
            for t in font_weight_tokens:
                to_remove.add(t)
            notes.append(
                f"  B+) убраны font-* после text-*→tf-*: {sorted(font_weight_tokens)}"
            )

    # C) font-* без tf-* и без text-*: оставить, отметить в отчёте.
    if (
        font_weight_tokens
        and not has_tf
        and not has_text_anywhere
    ):
        notes.append(
            f"  C) font-* без tf-*/text-* (нужен ручной выбор ступени): {font_weight_tokens}"
        )

    if to_remove or to_replace:
        new_block = apply_token_diff(block, to_remove, to_replace)
        return new_block, notes
    return block, notes


def process_file(path: Path) -> tuple[int, list[str]]:
    rel = path.relative_to(REPO_ROOT).as_posix()
    overrides = ALLOWED_FILE_OVERRIDES.get(rel, set())

    text = path.read_text(encoding="utf-8")
    out_text = text
    file_notes: list[str] = []
    changes = 0

    # 1) Простые строковые className="..." / className='...' — ищем по всему файлу.
    for m in list(CLASSNAME_RE.finditer(text)):
        line_no = text.count("\n", 0, m.start()) + 1
        quote = m.group(1)[0]
        block = m.group(2) if m.group(2) is not None else m.group(3)
        if overrides and any(sz in block for sz in overrides):
            continue
        new_block, notes = normalize_block(block, rel, line_no)
        if new_block != block:
            old_attr = f"className={quote}{block}{quote}"
            new_attr = f"className={quote}{new_block}{quote}"
            out_text = out_text.replace(old_attr, new_attr, 1)
            changes += 1
            if notes:
                file_notes.append(f"{rel}:{line_no}")
                file_notes.extend(notes)
    text = out_text
    out_text = text

    # 2) Template literals className={`…`} — могут пересекать строки.
    #    Несколько проходов, пока что-то меняется.
    for _ in range(5):
        replaced_any = False
        for m in list(CLASSNAME_TPL_RE.finditer(text)):
            line_no = text.count("\n", 0, m.start()) + 1
            tpl_body = m.group(1)
            if overrides and any(sz in tpl_body for sz in overrides):
                continue
            new_tpl, notes = normalize_tpl(tpl_body, rel, line_no)
            if new_tpl != tpl_body:
                old_attr = f"className={{`{tpl_body}`}}"
                new_attr = f"className={{`{new_tpl}`}}"
                out_text = out_text.replace(old_attr, new_attr, 1)
                text = out_text
                changes += 1
                replaced_any = True
                if notes:
                    file_notes.append(f"{rel}:{line_no}")
                    file_notes.extend(notes)
        if not replaced_any:
            break

    if changes:
        path.write_text(out_text, encoding="utf-8")
    return changes, file_notes

    if changes:
        path.write_text(out_text, encoding="utf-8")
    return changes, file_notes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry", action="store_true", help="Не записывать файлы")
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    args = parser.parse_args()

    files = sorted(
        p for p in SRC.rglob("*.ts*") if p.is_file() and not p.name.endswith(".test.ts")
    )
    total_changes = 0
    all_notes: list[str] = []
    for f in files:
        if args.dry:
            text = f.read_text(encoding="utf-8")
            virtual_changes = 0
            for line in text.splitlines():
                for m in CLASSNAME_RE.finditer(line):
                    block = m.group(2) or m.group(3)
                    new_block, _ = normalize_block(
                        block, f.relative_to(REPO_ROOT).as_posix(), 0
                    )
                    if new_block != block:
                        virtual_changes += 1
                for m in CLASSNAME_TPL_RE.finditer(line):
                    tpl_body = m.group(1)
                    new_tpl, _ = normalize_tpl(
                        tpl_body, f.relative_to(REPO_ROOT).as_posix(), 0
                    )
                    if new_tpl != tpl_body:
                        virtual_changes += 1
            if virtual_changes:
                print(f"{f.relative_to(REPO_ROOT).as_posix()}: {virtual_changes} className-блоков")
                total_changes += virtual_changes
        else:
            changes, notes = process_file(f)
            if changes:
                print(f"{f.relative_to(REPO_ROOT).as_posix()}: {changes} правок")
                total_changes += changes
                all_notes.extend(notes)
    print(f"Всего className-блоков с правками: {total_changes}")
    if not args.dry and all_notes:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(
            "# Dedupe-typography — отчёт по правкам\n\n"
            + "\n".join(all_notes)
            + "\n",
            encoding="utf-8",
        )
        print(f"Отчёт: {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
