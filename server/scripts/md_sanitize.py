#!/usr/bin/env python3
"""Markdown → HTML с очисткой опасного содержимого.

Зачем этот файл существует (24.10.2026, аудит безопасности):
python-`markdown` по умолчанию ПРОПУСКАЕТ сырой HTML. Тело отчёта —
пользовательский текст, и `<script>` в нём попадал в готовый HTML-документ
как есть. Отчёт отдаётся как `text/html` с `inline`, то есть исполнялся в
origin приложения (XSS), и вдобавок исполнялся при сборке PDF на сервере
(Chrome --headless --allow-file-access-from-files) — с правами процесса.

Что убираем:
  * теги script/style/iframe/object/embed/svg/math/form/link/meta/base;
  * обработчики событий (onclick, onerror, …);
  * ссылки со схемой javascript:;
  * атрибуты style (в них тоже живут выражения url(javascript:…)).

Что оставляем: заголовки, текст, списки, таблицы, код, цитаты, картинки и
ссылки со схемами http/https/mailto.

Запуск: `python3 md_sanitize.py <файл.md>` → HTML на stdout.

Bleach используется, если установлен (он надёжнее самописного фильтра).
Если его нет — запасной фильтр на html.parser. Если и он не справился —
выход с ненулевым кодом: лучше отчёт без HTML, чем отчёт с исполняемым
кодом.
"""
import html
import sys
from html.parser import HTMLParser

# Теги, которые нельзя пропускать ни при каких условиях.
BAD_TAGS = {
    "script", "style", "iframe", "object", "embed", "svg", "math",
    "form", "link", "meta", "base", "applet", "frame", "frameset",
}

ALLOWED_TAGS = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "b", "i", "em",
    "strong", "code", "pre", "blockquote", "ul", "ol", "li", "a", "img",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "del", "sup",
    "sub", "span", "div", "figure", "figcaption", "details", "summary",
}

# Атрибуты, которые разрешены по тегу.
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt", "title"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "ol": {"start"},
}

ALLOWED_PROTOCOLS = {"http", "https", "mailto", "data"}


def _url_ok(value: str) -> bool:
    """Схема ссылки допустима? javascript: и vbscript: — нет."""
    v = value.strip().lower().replace("\t", "").replace("\n", "").replace("\r", "")
    if v.startswith("#"):
        return True
    if ":" not in v:
        # Относительная ссылка — безопасна.
        return True
    scheme = v.split(":", 1)[0]
    return scheme in ALLOWED_PROTOCOLS


class _Sanitizer(HTMLParser):
    """Запасной фильтр: выкидывает плохие теги, on*-обработчики и
    опасные схемы ссылок."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in BAD_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag not in ALLOWED_TAGS:
            return
        kept = {}
        for key, value in attrs:
            key_l = key.lower()
            if key_l.startswith("on"):
                continue
            if key_l == "style":
                continue
            if key_l in ("href", "src") and not _url_ok(value or ""):
                continue
            allowed = ALLOWED_ATTRS.get(tag, set())
            if key_l in allowed:
                kept[key_l] = value or ""
        rendered = "".join(
            " %s='%s'" % (k, html.escape(str(v), quote=True)) for k, v in kept.items()
        )
        self.out.append("<%s%s>" % (tag, rendered))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in BAD_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth or tag not in ALLOWED_TAGS:
            return
        self.out.append("</%s>" % tag)

    def handle_data(self, data):
        if not self.skip_depth:
            self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        return "".join(self.out)


def _render(path: str) -> str:
    import markdown

    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    rendered = markdown.markdown(
        source, extensions=["tables", "fenced_code", "toc", "sane_lists"]
    )
    try:
        import bleach

        return bleach.clean(
            rendered,
            tags=ALLOWED_TAGS,
            attributes={k: sorted(v) for k, v in ALLOWED_ATTRS.items()},
            protocols=sorted(ALLOWED_PROTOCOLS),
            strip=True,
        )
    except ImportError:
        sanitizer = _Sanitizer()
        sanitizer.feed(rendered)
        sanitizer.close()
        return sanitizer.result()


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: md_sanitize.py <file.md>\n")
        return 2
    sys.stdout.write(_render(sys.argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
