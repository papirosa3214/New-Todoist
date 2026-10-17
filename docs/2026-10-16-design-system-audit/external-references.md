# Внешние ориентиры для оценки расхождений: Apple HIG и аналоги

Служебный документ аудита. Карточка: **Аудит дизайн-системы нативного клиента TaskFlow** (`65fb1128-e2ec-465d-a0c6-9a2e4d5fefe3`). Дата сбора: 16.10.2026.

Текст совпадает с заметкой документации `5814cfde-fcec-43e8-a3e4-450233319806`. Первый коммит сделан на macbook в чужой рабочей копии — `c59c7d2`; этот файл перенесён на сервер .110 без изменения содержания, свой SHA указан в отчёте этапа.

## Как пользоваться документом

Это общий словарь оценки для двух параллельных веток аудита (Разработчик — состав и компоненты, Дизайнер — визуальная проверка), чтобы оба смотрели на экран одними и теми же мерками. Документ **не диктует решений**: он отвечает на вопрос «по какому правилу считать это расхождением» и даёт ссылку.

Правило в списке — проверяемое утверждение с числом или однозначным признаком. Если числа нет (группа E), правило работает как критерий согласованности внутри проекта, а не как внешний норматив.

Каждый пункт, попадающий в аудит, помечается одним из четырёх тегов:

| Тег | Что означает |
|---|---|
| `СОВПАДАЕТ` | совпадает и с дизайн-системой проекта, и с ориентиром |
| `РАСХОЖДЕНИЕ` | есть правило, приложение ему не следует — нужна рекомендация |
| `НЕТ ПРАВИЛА` | поведение не описано ни в HIG, ни в дизайн-системе — решение за merge |
| `СПОРНО` | два ориентира дают разные пороги — зафиксировать оба и выбрать явно |

---

## A. Сенсорные цели и расстояния

Основной ориентир — Apple HIG. Числа проверяемые, измеряемые в пунктах.

| № | Правило | Порог |
|---|---|---|
| A1 | Зона нажатия любой кнопки — не меньше 44×44 pt | 44×44 pt |
| A2 | Минимальный размер элемента управления на iOS/iPadOS, если 44 недостижимо | 28×28 pt |
| A3 | Отступ вокруг элемента **с обводкой** | ≈12 pt |
| A4 | Отступ вокруг видимых границ элемента **без обводки** | ≈24 pt |
| A5 | Расстояние между центрами соседних кнопок | ≥60 pt |
| A6 | Иконка может быть меньше зоны нажатия: зона включает поля вокруг иконки | зона 44, иконка произвольна |
| A7 | Рядом не должно быть «мелких» целей, которые легко спутать: расстояние важнее самого размера | — |

Ссылки: [HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) (раздел Mobility: таблица размеров, отступы), [HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) («hit region of at least 44x44 pt», «centers are always at least 60 pts apart»).

**Аналоги для спорных случаев** (не заменяют Apple, дают нижнюю границу):

| Источник | Порог | Ссылка |
|---|---|---|
| WCAG 2.2 SC 2.5.8 (AA) | 24×24 CSS px **или** достаточные отступы вокруг меньшей цели | [W3C Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) |
| WCAG 2.2 SC 2.5.5 (AAA) | 44×44 | [W3C Understanding 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) |
| Android / Material | 48×48 dp, между элементами минимум 8 dp, физический размер 7–10 мм | [Google Accessibility Help](https://support.google.com/accessibility/android/answer/7101858) |

Практическое замечание: 48 dp и 44 pt близки по ощущению в пальце; если элемент меньше 44 pt — проверять не только размер, но и расстояние до соседей (A7).

## B. Типографика

| № | Правило | Порог / признак |
|---|---|---|
| B1 | Системный шрифт SF Pro; свой шрифт не заводить, системный не встраивать в приложение | — |
| B2 | Минимальный размер текста на iOS/iPadOS | 11 pt |
| B3 | Размер по умолчанию для основного текста | 17 pt |
| B4 | Светлые начертания (Ultralight, Thin, Light) не использовать; берут Regular, Medium, Semibold, Bold | — |
| B5 | Число шрифтовых семейств минимальное: два-три шрифта стирают иерархию | — |
| B6 | Размер задаётся **стилем текста**, а не произвольным числом в каждом экране | — |
| B7 | Текст переживает увеличение: возможность увеличить текст хотя бы на 200% (Dynamic Type) | 200% |
| B8 | При увеличенном размере текст не обрезается; соседние по горизонтали элементы складываются в столбец | — |
| B9 | Иерархия сохраняется при любом размере: главное остаётся сверху | — |

Шкала iOS/iPadOS по умолчанию (размер/межстрочный, в пунктах): Large Title 34/41, Title 1 28/34, Title 2 22/28, Title 3 20/25, Headline 17 Semibold/22, Body 17/22, Callout 16/21, Subhead 15/20, Footnote 13/18, Caption 1 12/16, Caption 2 11/13.

Ссылки: [HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography) (таблица default/minimum, таблица text styles, раздел Supporting Dynamic Type), [HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) (та же таблица и требование 200%).

Замечание для аудита: у TaskFlow базовый текст 15 px (ступень `body`) при минимуме 11 pt — это **не** нарушение HIG: 15 pt попадает между Subhead и Callout. Нарушением будет текст ниже 11 pt либо появление промежуточных кеглей вне шкалы проекта.

## C. Состояния

Главное правило группы: **состояние — часть компонента, а не частный случай экрана.** Экран без состояний (пусто / ошибка / загрузка) — расхождение по определению.

### C1. Нажатие

| № | Правило | Признак |
|---|---|---|
| C1.1 | У любой кастомной кнопки обязателен отклик на нажатие | без него кнопка «не слушается» |
| C1.2 | Отклик один и тот же для одного типа элемента | одна кнопка везде ведёт себя одинаково |
| C1.3 | Действие с задержкой больше секунды показывает индикатор выполнения в самой кнопке; подпись можно менять на «Проверяем…» | — |

Ссылки: [HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) («Always include a press state for a custom button», activity indicator в кнопке).

### C2. Загрузка

| № | Правило | Признак |
|---|---|---|
| C2.1 | Показывать хоть что-то сразу: заглушку, текст, анимацию — пустой экран читают как поломку | — |
| C2.2 | Длительность известна — детерминированный индикатор; неизвестна — спиннер | — |
| C2.3 | Индикатор всегда в одном и том же месте на экране | — |
| C2.4 | Спиннер не подписывают словами «Загрузка» / «Обработка» | — |
| C2.5 | Если процесс можно прервать без последствий — дать «Отмену» | — |

Ссылки: [HIG Loading](https://developer.apple.com/design/human-interface-guidelines/loading), [HIG Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators).

### C3. Пусто

**Отдельного правила в HIG про пустые экраны нет** — помечаем `НЕТ ПРАВИЛА`. Ближайшие опоры:

- экран не должен быть пустым молча — сначала показываем что-то, потом заполняем (C2.1);
- сообщение об отсутствии данных должно объяснять почему и что делать дальше ([HIG Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback));
- недоступный раздел не прятать и не отключать молча, а объяснять почему ([HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): «Don't disable or hide tab bar buttons… explain why»).

### C4. Ошибка

| № | Правило | Признак |
|---|---|---|
| C4.1 | Alert — только для важной и actionable информации, не для информирования | — |
| C4.2 | Заголовок описывает ситуацию, а не «Ошибка» / «Error 329347»; не длиннее двух строк | — |
| C4.3 | Кнопка называется результатом или глаголом («Удалить», «Повторить»), не «OK» | — |
| C4.4 | При разрушающем действии обязательна «Отмена», причём она не должна быть кнопкой по умолчанию | — |
| C4.5 | Стиль «разрушающая» — только если действие не было намеренным | — |
| C4.6 | Для обычного обратимого действия alert не нужен | — |
| C4.7 | Ошибка поля ввода — текстом рядом с полем, а не только цветом рамки | — |

Ссылки: [HIG Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), [HIG Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields) (валидация в контексте).

### C5. Выключено (disabled)

HIG конкретного числа не задаёт, проверяем по поведению:

| № | Правило | Аналог |
|---|---|---|
| C5.1 | Выключенный элемент не получает состояний наведения, нажатия и фокуса | [Material 3 States](https://m3.material.io/foundations/interaction/states/applying-states): disabled нельзя нажать, потянуть, навести |
| C5.2 | Выключено визуально заметно и одинаково во всём приложении | одна и та же мера затемнения |
| C5.3 | Причина недоступности объясняется рядом, а не остаётся загадкой | — |

### C6. Выбрано

| № | Правило | Признак |
|---|---|---|
| C6.1 | В списке-иерархии выбранная строка подсвечивается постоянно | видно, где находишься |
| C6.2 | В списке-опций подсветка краткая, плюс галочка/иконка | — |
| C6.3 | Во вкладках и фильтрах «выбрано» отличается от «наведён», оба отличимы от обычного | — |

Ссылка: [HIG Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables).

## D. Цвет и контраст

| № | Правило | Порог |
|---|---|---|
| D1 | Контраст обычного текста (до 17 pt, любое начертание) | ≥4.5:1 |
| D2 | Контраст крупного текста (18 pt и больше) и полужирного | ≥3:1 |
| D3 | Контраст значимых **нетекстовых** элементов (границы полей, иконки-кнопки, состояния) | ≥3:1 |
| D4 | Проверять отдельно в светлой и тёмной теме | — |
| D5 | Смысл не передаётся одним цветом: добавлять иконку, форму или текст | — |
| D6 | Системные цвета с доступными вариантами либо свои токены с проверенным контрастом | — |

Ссылки: [HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) (таблица «Text size / Text weight / Minimum contrast ratio», «Convey information with more than color alone», «Prefer system-defined colors»), [WCAG 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

Для аудита: у каждого именованного цвета в дизайн-системе должно быть значение, проходящее D1–D3 на фоне, где этот цвет используется. «Просто красиво» — не аргумент.

## E. Радиусы, отступы, материалы, иерархия

Здесь HIG **задаёт принципы, а не числа** — публичной шкалы отступов и радиусов Apple не публикует. Проверять нужно согласованность внутри проекта.

| № | Правило | Источник принципа |
|---|---|---|
| E1 | Важное — сверху и у ведущего края; отступ читается как подчинённость | [HIG Layout](https://developer.apple.com/design/human-interface-guidelines/layout) |
| E2 | Связанное группируется: отступом, формой контейнера или разделителем | там же |
| E3 | Всё, что не помещается на первый экран, прятать постепенно (раскрытие, меню, вложенные экраны) | там же |
| E4 | Элементы управления визуально отделены от содержимого: материалом/размытием, а не однотонной заливкой | там же |
| E5 | В ряд — не больше трёх кнопок с глифами или двух с текстом | там же |
| E6 | Собственные компоненты внутри панели наследуют её радиусы (концентрические углы) | [HIG Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) |
| E7 | Один размер одного элемента по всей системе; значения только из шкалы проекта | внутреннее правило проекта |

## F. Навигация, списки, поля

| № | Правило | Ссылка |
|---|---|---|
| F1 | Нижняя навигация — для переходов между разделами, а не для действий над содержимым | [HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) |
| F2 | Раздел навигации нельзя молча прятать или отключать — объясняй почему | там же |
| F3 | Подписи вкладок обязательны, одно слово | там же |
| F4 | «Ещё»/overflow-вкладку лучше не доводить до скрытия нужных разделов | там же |
| F5 | Текст пункта списка короткий; длинное выносить в детальный экран | [HIG Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) |
| F6 | Поле ввода: подпись или подсказка, очистка в конце, клавиатура по типу данных, проверка в контексте | [HIG Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields) |
| F7 | Главное действие на экране одно; выделенных кнопок одна-две | [HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) |

## G. Что HIG не покрывает (важно для сведения)

- **Пустые состояния** — отдельного правила нет (C3).
- **Шкала отступов и радиусов** — публичных чисел нет, только принципы (группа E).
- **Палитра TaskFlow** — HIG задаёт требования к контрасту (D1–D3), а не палитру.
- **Анимации** — HIG требует уважения настройки «Уменьшение движения» и запрет мигающих эффектов, но не задаёт длительности.

## Источники

Все страницы проверены 16.10.2026:

1. [Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
2. [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
3. [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
4. [Apple HIG — Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
5. [Apple HIG — Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
6. [Apple HIG — Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
7. [Apple HIG — Loading](https://developer.apple.com/design/human-interface-guidelines/loading)
8. [Apple HIG — Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
9. [Apple HIG — Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)
10. [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
11. [Apple HIG — Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
12. [Apple HIG — Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)
13. [Apple HIG — Color](https://developer.apple.com/design/human-interface-guidelines/color)
14. [W3C — Understanding SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
15. [W3C — Understanding SC 2.5.5 Target Size (Enhanced)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)
16. [W3C — Understanding SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
17. [Google — Размер интерактивных элементов (Android, 48 dp)](https://support.google.com/accessibility/android/answer/7101858)
18. [Material Design 3 — States](https://m3.material.io/foundations/interaction/states/applying-states)

## Приложение: как брать текст HIG программно

Сайт HIG отдаётся JavaScript-приложением, и обычная загрузка страницы возвращает пустоту — это не значит, что источника нет. Текст лежит в JSON, который отдаёт DocC-хранилище Apple:

```
https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<тема>.json
```

Например, `.../accessibility.json`, `.../typography.json`, `.../buttons.json`. Внутри `primaryContentSections[].content[]`: `paragraph`, `heading`, `unorderedList`, `table` (строки — массивы ячеек, в каждой ячейке снова блоки). Таблицы с числами лежат именно там, поэтому их нужно выгружать, а не читать страницу глазами.