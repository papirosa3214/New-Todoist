# Конверт ответа роли: источники с цветными ярлычками

**Контракт:** `role.v1` → `role.v1.1` (аддитивно)
**Дата:** 10.11.2026
**Статус:** предложение. Кода нет, схема не применяется. Документ описывает, что сервер упаковывает и что клиент рисует.

---

## 1. Что уже есть (по коду, не по памяти)

| Что | Где | Факт |
|---|---|---|
| Плоский конверт | `server/src/lib/roleContractV1.ts:35` | `ok`, `output` (строка), `artifacts`, `error`, `next_hint`, `needs_human` |
| Структурный конверт | там же `:46` | `schema_version: 1`, `output` — массив блоков, `artifacts[]`, `plan_artifact`, `error{code,message,retryable}` |
| Закрытый набор блоков | `:63` `STRUCTURED_BLOCK_FIELDS` | 15 типов: `text heading list table status progress chart diagram report handoff command link widget html` |
| Материал | `:109` `isMaterial` | `{kind, title, ref}`; `kind ∈ url│document│file│change│artifact│log`; `title ≤ 1000`, `ref ≤ 1024` |
| Ссылка | `:71`, `:106`, `:140` | `{type:"link", title, url}`; `url` = `http(s)://` без пробелов **или** `note://<uuid>` |
| Лимиты | `:163`, `:161` | материалов ≤ 8, блоков `output` 1..200 |
| Инструкция ролям | `:77` `ROLE_BLOCK_GUIDE` | один источник со схемой, шаблон `scripts/role-system-prompt.md` подставляет `{{BLOCKS}}` |
| Нормализация ответа | `:734` `normalizeRoleReplyV1` | любой ответ приводится к структурному конверту, текст не теряется |
| Рендер в iOS | `ChatStructuredOutputView.swift:302`, `:339` | три исхода: `note://` → заметка, `task://` → карточка, `http(s)` → браузер. Иконки `doc.text` / `checklist` / `arrow.up.right.square` |

**Вывод из таблицы:** адрес уже один и он правильный (`ref` / `url`). Не хватает одного — *чем* этот адрес является. Сейчас любая внешняя ссылка выглядит одинаково: синяя строка со стрелкой ↗.

---

## 2. Чего не хватает

1. `github.com/maksim/taskflow-server/blob/main/server/src/lib/roleContractV1.ts` и `https://example.com/статья` рисуются **одинаково**. Владелец не видит, репозиторий это, документация или статья.
2. Расширение файла не передаётся. `.py` от `.md` не отличить, хотя слово «python» в ответе есть — и именно его хочется видеть ярлычком.
3. Хост не передаётся отдельно: клиент вынужден сам парсить URL и всё равно не знает, `docs.` это документация или просто поддомен.
4. Произвольный цвет от модели — плохая идея: у владельца правило «красный только для активного/тревоги», и произвольный hex ломает и тему, и это правило.

---

## 3. Решение

**Одно аддитивное поле `badge`** на трёх существующих носителях ссылок. Новых полей верхнего уровня и новых списков нет — «одна функция, один вход».

**Кто вычисляет ярлычок:** сервер. Модель может *уточнить* `lang` и `label`, но не цвет и не вид-носитель. Если модель ничего не сказала — сервер выводит ярлычок по таблице из §5. Если модель сказала чушь — ярлычок отбрасывается, строка остаётся (тот же принцип спасения, что в `salvageStructured`, `:499`).

**Одно правило на два места.** Та же таблица §5 применяется клиентом к ссылкам внутри Markdown-текста (`[server.py](https://github.com/…)` в `text`-блоке). Поэтому таблица — часть контракта с версией, а не деталь сервера.

---

## 4. Схема

### 4.1 Ярлычок

```jsonc
{
  "kind": "github-file",   // закрытый словарь, 14 значений (§4.2)
  "lang": "python",        // необязателен; закрытый словарь (§4.3), только моноширинный вид
  "label": "server.py"     // ≤ 24 символа, что написано на ярлычке
}
```

Правила:

- `badge` необязателен. Его отсутствие = «выведи по таблице §5».
- `badge` **не содержит адреса**. Адрес живёт только в `ref` / `url`. Одна точка правды.
- `badge` **не влияет на кликабельность** и не может сделать нерабочий адрес рабочим.
- Цвета в `badge` нет вообще. Цвет выбирает клиент из палитры §7 по `kind` + `lang`.

### 4.2 `kind` — закрытый словарь

| `kind` | Что это | Пример `ref` |
|---|---|---|
| `github-repo` | репозиторий | `https://github.com/maksim/taskflow-server` |
| `github-file` | файл в репозитории | `…/blob/main/server/src/lib/roleContractV1.ts` |
| `github-docs` | документация GitHub | `https://docs.github.com/en/rest` |
| `github-issue` | issue | `…/issues/412` |
| `github-pr` | pull request | `…/pull/87` |
| `gist` | gist | `https://gist.github.com/…` |
| `docs` | документация продукта | `https://hermes-agent.nousresearch.com/docs` |
| `note` | заметка «Базы знаний» | `note://<uuid>` |
| `task` | карточка задачи | `task://<uuid>` |
| `file` | файл на диске | `/home/maksim/server/dev-server.log` |
| `pdf` | PDF | `…/report.pdf` |
| `image` | картинка | `…/screen.png` |
| `video` | видео | `…/demo.mp4` |
| `package` | пакет | `https://pypi.org/project/fastapi` |
| `web` | всё остальное http(s) | `https://example.com/статья` |

Неизвестное значение `kind` → **ошибка блока** (как сейчас `неизвестный тип блока`, `:117`), при показе — спасение строки с `kind: "web"`.

### 4.3 `lang` — закрытый словарь

`python swift typescript javascript json markdown sql bash yaml html css toml go rust other`

Расширение файла определяет `lang` (`deriveLang`, §5.2). Если `lang` задан, клиент рисует ярлычок моноширинным шрифтом — это и есть «цветной ярлычок типа питона».

---

## 5. Таблица вывода ярлычка

Единственная реализация — `deriveBadge(ref, kind?)`, используется сервером (при упаковке) и клиентом (для Markdown-ссылок). Версия таблицы входит в контракт: `badge_rules: 1`.

### 5.1 По адресу

| Признак `ref` / `url` | `kind` | `label` |
|---|---|---|
| `note://<uuid>` | `note` | `заметка` |
| `task://<uuid>` | `task` | `задача` |
| `github.com/<owner>/<repo>` (2 сегмента) | `github-repo` | `<owner>/<repo>` |
| `github.com/*/*/blob/…` или `/raw/…` | `github-file` | имя файла |
| `github.com/*/*/issues/<n>` | `github-issue` | `#<n>` |
| `github.com/*/*/pull/<n>` | `github-pr` | `#<n>` |
| `docs.github.com` | `github-docs` | `docs` |
| `gist.github.com` | `gist` | `gist` |
| `pypi.org`, `npmjs.com`, `pkg.go.dev` | `package` | имя пакета |
| хост начинается с `docs.` или путь содержит `/docs/` | `docs` | хост или `docs` |
| путь без схемы, начинается с `/` или `~/` | `file` | `basename` |
| расширение `.pdf` | `pdf` | `basename` |
| расширение `.png .jpg .jpeg .webp .svg .gif` | `image` | `basename` |
| расширение `.mp4 .mov .webm` | `video` | `basename` |
| иначе `http(s)` | `web` | хост без `www.` |

### 5.2 По расширению

`.py` python · `.swift` swift · `.ts .tsx` typescript · `.js .mjs` javascript · `.json` json · `.md` markdown · `.sql` sql · `.sh .zsh` bash · `.yml .yaml` yaml · `.html` html · `.css .scss` css · `.toml` toml · `.go` go · `.rs` rust · иначе `other`.

`file`-ярлычок всегда получает `lang`: имя файла моноширинно, «питон» виден из цвета.

---

## 6. Куда именно кладётся

```jsonc
// 1. Материал отчёта (report → sections.materials) и materials-блок
"materials": [
  {"kind": "file", "title": "Контракт ролей", "ref": "https://github.com/maksim/taskflow-server/blob/main/server/src/lib/roleContractV1.ts",
   "badge": {"kind": "github-file", "lang": "typescript", "label": "roleContractV1.ts"}}
]

// 2. Верхнеуровневые материалы конверта
"artifacts": [
  {"kind": "url", "title": "Документация GitHub REST", "ref": "https://docs.github.com/en/rest",
   "badge": {"kind": "github-docs", "label": "docs"}}
]

// 3. Блок ссылки в output
{"type": "link", "title": "Лог сборки", "url": "/home/maksim/build.log",
 "badge": {"kind": "file", "lang": "other", "label": "build.log"}}
```

Изменений в `STRUCTURED_BLOCK_FIELDS` ровно три (набор полей, не типы блоков):

```
link:  [..., "badge"]
```

и в `isMaterial` (`:109`) — `badge` необязателен, при наличии проверяется.

**Важно про порядок правок.** Блок `link` сейчас отвергает любое лишнее поле (`:118`, «поле не разрешено»). Добавление `badge` в `STRUCTURED_BLOCK_FIELDS` и в `ROLE_BLOCK_GUIDE` — правка одного файла, тест сверки ключей (`:76` comment) проходит сам. Модель узнаёт о ярлычке только через `ROLE_BLOCK_GUIDE` — второго места для инструкции нет.

---

## 7. Что рисует клиент

Строка источника = **ярлычок + название**, ярлычок слева:

```
[ PY ] server.py                                    github.com › lib
[ GH ] taskflow-server                              github.com
[ MD ] docs                                         docs.github.com
[ PDF] отчёт-42.pdf                                 /tmp
```

| Параметр | Значение |
|---|---|
| Высота ярлычка | 20 pt, радиус 6 pt, padding по горизонтали 6 pt |
| Шрифт ярлычка | 11 pt semibold; при `lang` — 11 pt monospaced, `uppercase` |
| Отступ ярлычок → название | 6 pt |
| Фон ярлычка | цвет вида, alpha `0.14` (light) / `0.22` (dark) |
| Текст ярлычка | тот же цвет, alpha `1.0` |
| Название | `tfText(.body)`, 1 строка, `tail` |
| Подпись справа | `tfText(.caption)`, `tfSub`, хост (для `file` — каталог) |
| Тап | ровно прежние три исхода `ChatMaterialDestination.resolve` |

**Палитра (красного нет — красный только для активного и тревоги):**

| `kind` | light | dark |
|---|---|---|
| `github-*`, `gist` | `#24292F` | `#E6EDF3` |
| `docs`, `github-docs` | `#2F6FEB` | `#6EA8FF` |
| `note`, `task` | `#0A84C8` | `#5BC0F0` |
| `file`, `package` | `#6E7681` | `#A8B0BA` |
| `pdf` | `#8A4B1E` | `#D08A55` |
| `image` | `#7A5AF8` | `#A992FF` |
| `video` | `#B07A1E` | `#E0AC4A` |
| `web` | `#4E7A2A` | `#8FC160` |

| `lang` | светлый | тёмный |
|---|---|---|
| `python` | `#3776AB` | `#7FB6E0` |
| `swift` | `#C4571F` | `#F0915C` |
| `typescript` | `#3178C6` | `#79B0F0` |
| `javascript` | `#8A6D1A` | `#E0C05A` |
| `json`, `yaml`, `toml` | `#6E7681` | `#A8B0BA` |
| `markdown` | `#4A6C8C` | `#93B4D4` |
| `sql` | `#B07A1E` | `#E0AC4A` |
| `bash` | `#4E7A2A` | `#8FC160` |
| `html` | `#B4551F` | `#E89050` |
| `css` | `#6C4AA8` | `#A98BE0` |
| `go` | `#2A7E8C` | `#63BAC8` |
| `rust` | `#7A5A34` | `#C09868` |
| `other` | `#6E7681` | `#A8B0BA` |

Если `lang` задан, палитра `lang` важнее палитры `kind`: фон и текст ярлычка берутся из языка, вид остаётся в семантике (issue/PR не бывает с `lang`).

---

## 8. Образец целиком

Ответ роли-разработчика после сдачи шага.

```json
{
  "schema_version": 1,
  "ok": true,
  "output": [
    {"type": "heading", "text": "Вынес разбор конверта в один модуль", "level": 2},
    {"type": "text", "text": "Разбор ответа теперь живёт в `roleContractV1.ts`. Старый YAML-путь оставлен без изменений — [правила разбора](https://github.com/maksim/taskflow-server/blob/main/server/src/lib/roleContractV1.ts) проверены на 87 тестах."},
    {"type": "table", "title": "Что изменилось", "columns": ["Файл", "Строк"], "rows": [["roleContractV1.ts", "780"], ["chatLiveTurn.ts", "41"]]},
    {"type": "link", "title": "Контракт ролей v1", "url": "https://github.com/maksim/taskflow-server/blob/main/server/src/lib/roleContractV1.ts",
     "badge": {"kind": "github-file", "lang": "typescript", "label": "roleContractV1.ts"}},
    {"type": "link", "title": "Документация GitHub REST", "url": "https://docs.github.com/en/rest",
     "badge": {"kind": "github-docs", "label": "docs"}},
    {"type": "link", "title": "Материалы чата внутри TaskFlow", "url": "note://aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad",
     "badge": {"kind": "note", "label": "заметка"}},
    {"type": "link", "title": "Лог сборки", "url": "/home/maksim/Проекты/110-Gitea/taskflow-server/build.log",
     "badge": {"kind": "file", "lang": "other", "label": "build.log"}},
    {"type": "status", "code": "passed", "title": "Сборка и проверки", "text": "tsc --noEmit, 87/87 тестов"}
  ],
  "artifacts": [
    {"kind": "file", "title": "Контракт ролей v1", "ref": "https://github.com/maksim/taskflow-server/blob/main/server/src/lib/roleContractV1.ts",
     "badge": {"kind": "github-file", "lang": "typescript", "label": "roleContractV1.ts"}},
    {"kind": "url", "title": "Документация продукта", "ref": "https://hermes-agent.nousresearch.com/docs",
     "badge": {"kind": "docs", "label": "docs"}},
    {"kind": "log", "title": "Лог сборки", "ref": "/home/maksim/build.log",
     "badge": {"kind": "file", "lang": "other", "label": "build.log"}}
  ],
  "plan_artifact": null,
  "error": null,
  "next_hint": "Проверить конверт на живой сессии исследователя",
  "needs_human": false
}
```

**Что видит владелец** (после `structuredOutputText` + рендера ярлычков):

> ### Вынес разбор конверта в один модуль
>
> Разбор ответа теперь живёт в `roleContractV1.ts`. Старый YAML-путь оставлен без изменений — [правила разбора] проверены на 87 тестах.
>
> **Что изменилось**
> | Файл | Строк |
> | --- | --- |
> | roleContractV1.ts | 780 |
> | chatLiveTurn.ts | 41 |
>
> `TS` roleContractV1.ts · `GH` docs · `NOTE` заметка · `FILE` build.log
> ✅ Сборка и проверки: tsc --noEmit, 87/87 тестов

**Тот же конверт без `badge`** — работает как сегодня: сервер выводит ярлычки сам по таблице §5 (`github-file` + `typescript`, `github-docs`, `note`, `file`). Разница только в `label`: угаданный ярлычок короче (`roleContractV1.ts`), авторский может быть человечнее (`контракт`).

---

## 9. Совместимость и отказ

1. **Старый клиент** не знает `badge` — поле переживает декодирование как неизвестное (механика та же, что у `role_envelope`: клиент просто игнорирует). Строки материалов и ссылок продолжают рисоваться как сейчас.
2. **Невалидный `badge`** (чужой `kind`, `label` > 24) — ошибка блока при сдаче шага (`400`), потому что контракт закрытый. При *показе* в чате — ярлычок отбрасывается, строка остаётся: пустой ответ хуже, чем строка без ярлычка (принцип `:508` `BROKEN_CONTRACT_NOTE`).
3. **Порядок проверки:** `badge` проверяется после `title`/`ref`, чтобы старая ошибка в адресе не маскировалась ошибкой ярлычка.
4. **Лимиты:** `artifacts` ≤ 8 (как сейчас), `sections.materials` ≤ 8, блоков `link` в одном ответе ≤ 12. Ярлычок лимитов не увеличивает — он не новая сущность.
5. **`ok`, `error`, `needs_human`** от ярлычков не зависят никак.

---

## 10. Что нужно проверить после реализации

| Уровень | Проверка |
|---|---|
| Таблица | `deriveBadge` — 20 кейсов: репозиторий, файл, issue, PR, gist, docs-хост, pypi, путь на диске, `.pdf`, `.png`, `.mp4`, `note://`, `task://`, голый хост, `www.`, порт, query, якорь, кириллический путь, мусор |
| Схема | `badge` с чужим `kind` → ошибка `path.badge.kind`; без `badge` → валидно |
| Регресс | существующие 87 тестов трёх suite проходят без правок |
| Инструкция | тест сверки `STRUCTURED_BLOCK_FIELDS` ↔ `ROLE_BLOCK_GUIDE` проходит, `{{BLOCKS}}` содержит упоминание `badge` |
| Клиент | снапшот двух строк (внешняя с ярлычком, заметка с ярлычком); старая запись без `badge` рисуется как раньше |
| Живое | один реальный ход роли: `role_envelope` в `chat:new` содержит `badge`, `text` сообщения — прежний |

---

## 11. Три решения за владельцем

1. **Ярлычки для внутренних ссылок.** `note://` и `task://` тоже получают ярлычок (`заметка`, `задача`) — или оставить их как сейчас, синей строкой без ярлычка?
2. **Глубина словаря хостов.** Сейчас в таблице GitHub + pypi/npm/go.dev + `docs.`-правило. Добавлять ли 20–30 известных хостов (GitLab, MDN, Stack Overflow, arxiv, YouTube) — или держать минимум и всё прочее рисовать как `web`?
3. **Два ярлычка или один.** Файл на GitHub — это `github-file` + `python` (один ярлык, цвет языка) или два рядом: `GH` и `PY`?
