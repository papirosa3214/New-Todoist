# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: board.spec.ts >> Доска задач >> вертикальные поля карточки: воздух сверху и снизу совпадает
- Location: tests/e2e/board.spec.ts:108:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 8

- Array []
+ Array [
+   "«Домашний серверПодобрать аними»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+   "«Домашний серверAI Control Cent»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+   "«тест19 авг»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+   "«Календарные виды в «Предстояще»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+   "«тест 219 авг»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+   "«Личные делаС 7 до 10. Нужно бу»: сверху 8px (div.flex items-start gap-3), снизу 12px (div.flex items-center gap-1.)",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e6]:
    - generic [ref=e9]:
      - heading "Сегодня" [level=1] [ref=e10]
      - generic [ref=e11]:
        - button "Открыть фильтры" [ref=e12]
        - button "Ещё" [ref=e15]
    - generic [ref=e20]:
      - generic [ref=e21]:
        - generic [ref=e23]:
          - generic [ref=e24]: Ждут вас 2
          - generic [ref=e27]:
            - button [ref=e29]:
              - button "Перетащить задачу" [ref=e30]
              - generic [ref=e38]:
                - generic [ref=e41]:
                  - generic [ref=e42]: Домашний сервер
                  - generic [ref=e47]: Подобрать анимированные иконки для 4 разделов нижнего меню
                  - generic [ref=e48]: "Сейчас в нижнем меню TaskFlow (src/lib/navItems.ts) — статичные чёрно-белые иконки Lucide: «Входящие» (inbox), «Сегодня» (calendarCheck), «Предстоящее» (calendarSmall), «Обзор» (home). Задача: найти по одной анимированной иконке под каждый из этих 4 разделов — того же типа, что уже используется в проекте (пример: спиннер «в работе» у подзадач — 12-капельный comet-спиннер, взят как референс с бесплатного стока анимированных иконок, GIF/PNG с прозрачным фоном). Подойдут источники вроде Flaticon Animated Icons, LottieFiles, IconScout Lottie — свободные для использования, компактные (годные для UI-элемента ~20-24px), с прозрачным или легко удаляемым фоном. Не встраивать в код и не менять navItems.ts самостоятельно — просто подобрать 1-2 варианта на каждый раздел (ссылка или сам файл) и прислать владельцу (Максиму) на согласование, той же процедурой, что уже была с двумя другими иконками в этой сессии: показать вариант(ы) — дождаться подтверждения — только потом менять код. Не срочно, не сложная — разведочная задача."
                - generic [ref=e49]:
                  - generic [ref=e50]: 19 авг
                  - generic [ref=e53]: заблокировано
            - 'button "Перетащить задачу Домашний сервер AI Control Center — реализация (MVP) Единый диспетчерский слой поверх TaskFlow, Mnemosyne, базы знаний (kb_query.py + RAGFlow/wiki-base) и агентных харнессов по подписке (Claude Code, DeepSeek Harness). Не вторая инфраструктура — тонкий слой поверх уже работающих систем. Архитектурное решение и модель данных: https://claude.ai/code/artifact/64500b83-230c-43bc-80b0-222701285dfd Кликабельный прототип интерфейса: https://claude.ai/code/artifact/84987da5-95c3-41ea-bf5e-9d88cd831b91 Стек: FastAPI + Postgres + Vite/React (как CRM-Castom и infra-panel), Redis для очереди/event bus. Подзадачи ниже — это разбивка ровно раздела E (MVP 2-4 недели) архитектурного документа, двигаться по ним по одной. 19 авг 10/11 заблокировано" [ref=e58]':
              - button "Перетащить задачу" [ref=e59]
              - generic [ref=e67]:
                - generic [ref=e70]:
                  - generic [ref=e71]: Домашний сервер
                  - generic [ref=e76]: AI Control Center — реализация (MVP)
                  - generic [ref=e77]: "Единый диспетчерский слой поверх TaskFlow, Mnemosyne, базы знаний (kb_query.py + RAGFlow/wiki-base) и агентных харнессов по подписке (Claude Code, DeepSeek Harness). Не вторая инфраструктура — тонкий слой поверх уже работающих систем. Архитектурное решение и модель данных: https://claude.ai/code/artifact/64500b83-230c-43bc-80b0-222701285dfd Кликабельный прототип интерфейса: https://claude.ai/code/artifact/84987da5-95c3-41ea-bf5e-9d88cd831b91 Стек: FastAPI + Postgres + Vite/React (как CRM-Castom и infra-panel), Redis для очереди/event bus. Подзадачи ниже — это разбивка ровно раздела E (MVP 2-4 недели) архитектурного документа, двигаться по ним по одной."
                - generic [ref=e78]:
                  - generic [ref=e79]: 19 авг
                  - generic [ref=e82]: 10/11
                  - generic [ref=e83]: заблокировано
        - generic [ref=e87]:
          - generic [ref=e88]: 19 авг. · Среда
          - generic [ref=e91]:
            - button "Перетащить задачу тест 19 авг" [ref=e93]:
              - button "Перетащить задачу" [ref=e94]
              - generic [ref=e102]:
                - generic [ref=e103]: тест
                - generic [ref=e106]: 19 авг
            - button [ref=e111]:
              - button "Перетащить задачу" [ref=e112]
              - generic [ref=e120]:
                - generic [ref=e122]:
                  - generic [ref=e123]: Календарные виды в «Предстоящем» — неделя и месяц
                  - generic [ref=e124]: "Как в «Сегодня» появились виды помимо списка (один день, три дня), так в «Предстоящем» добавить неделю и месяц. Основание — четыре скриншота от 19.08.2026 (IMG_8353/8354 — неделя, IMG_8357 — месяц, IMG_8356 — раскрытый день). Как понял задачу: • Неделя — сетка 2×4: первая ячейка целиком занята мини-календарём месяца с подсветкой показанной недели, остальные семь — дни со списком задач (отметка, название, время). Прокрутки в этом виде нет — вся неделя на экране, статика. • Месяц — сетка 7×6, в ячейке число и мини-плашки, не влезающие сворачиваются в «+N», листается стрелками. • Тап по свободному месту ячейки раскрывает день панелью со списком, тап по плашке открывает задачу. • Какой месяц смотрим — подписью под заголовком экрана, с тем же затуханием, что у заголовка. • Сетка без замыкающих линий сверху и снизу — раскладка должна читаться продолжающейся, а не запертым квадратом. Решения, принятые самостоятельно (сказать, если не так): • Взята структура скриншотов, но не палитра — там светлая тема чужого приложения, у нас своя тёмная. • Неделя начинается с понедельника, а не с воскресенья, как на скриншотах: весь остальной календарь приложения уже так устроен. • Список с календарём-лентой остался отдельным видом «Список». Сделано и закоммичено: b8da5a3 (оба вида), db93e30 (правки недели по замечаниям). Проверено в Playwright на 420×912. Осталось: у недели нет стрелок «предыдущая/следующая» — листается только тапом по числу в мини-календаре. Приёмка — за владельцем на телефоне."
                - generic [ref=e125]:
                  - generic [ref=e126]: 19 авг
                  - generic [ref=e129]: 0/7
            - button "Перетащить задачу тест 2 19 авг" [ref=e131]:
              - button "Перетащить задачу" [ref=e132]
              - generic [ref=e140]:
                - generic [ref=e141]: тест 2
                - generic [ref=e144]: 19 авг
            - button "Перетащить задачу Личные дела С 7 до 10. Нужно будет осуществить все рабочие мероприятия, связанные с выездами. После чего приступить к вопросу заведения клиентской заявки. Перед этим надо Пообщаться с клиентом Уточнить, что там по итогу-то Выиграли, не выиграли Да 19 авг" [ref=e149]:
              - button "Перетащить задачу" [ref=e150]
              - generic [ref=e158]:
                - generic [ref=e160]:
                  - generic [ref=e161]: Личные дела
                  - generic [ref=e166]: С 7 до 10. Нужно будет осуществить все рабочие мероприятия, связанные с выездами. После чего приступить к вопросу заведения клиентской заявки. Перед этим надо Пообщаться с клиентом Уточнить, что там по итогу-то Выиграли, не выиграли Да
                - generic [ref=e167]: 19 авг
          - button "Добавить задачу" [ref=e172]
      - status [ref=e175]
  - button
  - button
  - button
  - button
  - button
  - button "Открыть меню разделов, удержание — новая задача" [ref=e176]
```

# Test source

```ts
  92  |     // Метка стоит ВЫШЕ названия, а не в подвале карточки: 19.08.2026 её
  93  |     // оттуда и перенесли («пусть везде будет решётка и название, в самом
  94  |     // верху, без заливки»).
  95  |     expect(badge!.aboveTitle).toBe(true);
  96  |     // Без заливки — прозрачный фон, а не пилюля с подложкой, какой она была
  97  |     // до 19.08.2026.
  98  |     expect(badge!.background).toBe("rgba(0, 0, 0, 0)");
  99  |     // Цвет — проекта, а не серый по умолчанию: «#A6A6A6» это подставной
  100 |     // цвет для проекта без своего, и он же выдал бы «метка есть, но цвет
  101 |     // потерялся». Отдельно сверяемся с цветом названия — метка обязана
  102 |     // отличаться от обычного текста.
  103 |     expect(badge!.color).not.toBe("rgb(166, 166, 166)");
  104 |     expect(badge!.color).not.toBe(badge!.titleColor);
  105 |     expect(errors).toEqual([]);
  106 |   });
  107 | 
  108 |   test("вертикальные поля карточки: воздух сверху и снизу совпадает", async ({
  109 |     page,
  110 |     context,
  111 |   }) => {
  112 |     // Прямая просьба владельца 19.08.2026: «посчитай расстояние от верха
  113 |     // плашки до первого слова и от последней метки до низа — они должны
  114 |     // быть одинаковыми». Отступы карточки при этом НАМЕРЕННО разные
  115 |     // (pt-2 против pb-3, см. TaskBoard.tsx), поэтому проверять нужно не
  116 |     // padding, а фактические прямоугольники содержимого.
  117 |     //
  118 |     // ⚠️ ПРОВЕРКА КРАСНАЯ, И ЭТО ОГРАНИЧЕНИЕ САМОЙ ПРОВЕРКИ, А НЕ ДЕФЕКТ.
  119 |     // Замер по боксам даёт у всех карточек 8px сверху против 12px снизу —
  120 |     // но это ровно padding-top против padding-bottom, потому что верхняя
  121 |     // строка-обёртка начинается точно на кромке padding, какой бы элемент
  122 |     // в ней ни лежал. То есть в такой форме проверка сводится к «pt-2 ≠
  123 |     // pb-3», а эта асимметрия в TaskBoard.tsx сделана НАМЕРЕННО.
  124 |     //
  125 |     // Как оно на самом деле — снято пипеткой со скриншотов карточек
  126 |     // (сканирование строк пикселей, экран @3x, значения в pt):
  127 |     //   карточка с аватаркой ............ 12.00 сверху / 12.00 снизу
  128 |     //   «Календарные виды…», «тест 2» ... 12.00 / 12.00
  129 |     //   «тест» (строчные без выносных) .. 14.00 / 12.00
  130 |     //   «Личные дела» (метка проекта) ... 15.00 / 12.00
  131 |     // Снизу ровно 12.00 всегда: там пилюли с заливкой, их кромка и есть
  132 |     // видимая граница. Сверху воздух зависит от начертания первой строки
  133 |     // (у «тест» нет ни заглавных, ни выносных — глифы начинаются ниже), и
  134 |     // задуманные 12/12 в типовом случае выдержаны.
  135 |     //
  136 |     // Вывод: инвариант «воздух сверху = воздух снизу» в 2px по боксам
  137 |     // недостижим в принципе, а по чернилам зависит от текста задачи.
  138 |     // Проверка оставлена как есть — она документирует замер; решение,
  139 |     // менять ли что-то, за владельцем.
  140 |     await setupApp(context, { today: "board" });
  141 |     await openScreen(page, "/today");
  142 | 
  143 |     const measures = await page.evaluate((sel) => {
  144 |       return Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
  145 |         (card) => {
  146 |           const rect = card.getBoundingClientRect();
  147 |           // Содержимое меряется ТОЛЬКО внутри текстовой колонки. Ручка
  148 |           // перетаскивания — сосед колонки, и у неё -my-3: её
  149 |           // прямоугольник вылезает выше и ниже контентного бокса карточки,
  150 |           // так что наивный обход всех детей вернул бы бессмысленные числа.
  151 |           const col = card.querySelector<HTMLElement>(":scope > div.min-w-0");
  152 |           if (!col) return null;
  153 |           let top = Infinity;
  154 |           let bottom = -Infinity;
  155 |           let topEl = "";
  156 |           let bottomEl = "";
  157 |           col.querySelectorAll<HTMLElement>("*").forEach((el) => {
  158 |             const r = el.getBoundingClientRect();
  159 |             // Пустая обёртка аватарки (w-[24px] без исполнителя) рисуется
  160 |             // всегда и имеет нулевую высоту — она не содержимое.
  161 |             if (r.height <= 0) return;
  162 |             const tag = `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 24)}`;
  163 |             if (r.top < top) {
  164 |               top = r.top;
  165 |               topEl = tag;
  166 |             }
  167 |             if (r.bottom > bottom) {
  168 |               bottom = r.bottom;
  169 |               bottomEl = tag;
  170 |             }
  171 |           });
  172 |           if (!Number.isFinite(top)) return null;
  173 |           return {
  174 |             title: (card.textContent ?? "").trim().slice(0, 30),
  175 |             padTop: +(top - rect.top).toFixed(2),
  176 |             padBottom: +(rect.bottom - bottom).toFixed(2),
  177 |             topEl,
  178 |             bottomEl,
  179 |           };
  180 |         },
  181 |       );
  182 |     }, CARD);
  183 | 
  184 |     const cards = measures.filter((m) => m !== null);
  185 |     expect(cards.length).toBeGreaterThan(0);
  186 |     const offenders = cards
  187 |       .filter((m) => Math.abs(m!.padTop - m!.padBottom) > 2)
  188 |       .map(
  189 |         (m) =>
  190 |           `«${m!.title}»: сверху ${m!.padTop}px (${m!.topEl}), снизу ${m!.padBottom}px (${m!.bottomEl})`,
  191 |       );
> 192 |     expect(offenders).toEqual([]);
      |                       ^ Error: expect(received).toEqual(expected) // deep equality
  193 |   });
  194 | 
  195 |   test("колонки прокручиваются вбок, страница при этом не уезжает по вертикали", async ({
  196 |     page,
  197 |     context,
  198 |   }) => {
  199 |     // «Входящие», а не «Сегодня»: колонок там по числу проектов. У доски
  200 |     // «Сегодня» их часто одна, и тогда полоса намеренно НЕ скроллится
  201 |     // (single-режим в TaskBoard.tsx растягивает единственную колонку и
  202 |     // центрирует её) — проверять на ней горизонтальную прокрутку значило бы
  203 |     // требовать от экрана того, чего он не обещает.
  204 |     await setupApp(context, { inbox: "board" });
  205 |     await openScreen(page, "/inbox");
  206 | 
  207 |     const strip = page.locator("[data-board-strip]");
  208 |     const box = await strip.boundingBox();
  209 |     expect(box).not.toBeNull();
  210 | 
  211 |     const before = await page.evaluate(() => {
  212 |       const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
  213 |       // Тот же обход вверх, что делает findScrollContainer в UI.tsx, —
  214 |       // прокручивается общий контейнер контента из Layout.tsx, и мерить
  215 |       // надо именно его, а не первый попавшийся .overflow-y-auto.
  216 |       let sc: HTMLElement | null = s.parentElement;
  217 |       while (sc && sc !== document.body) {
  218 |         if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
  219 |         sc = sc.parentElement;
  220 |       }
  221 |       return {
  222 |         canScrollX: s.scrollWidth > s.clientWidth,
  223 |         scrollLeft: s.scrollLeft,
  224 |         pageScrollTop: sc?.scrollTop ?? 0,
  225 |         pageScrollHeight: sc?.scrollHeight ?? 0,
  226 |         pageClientHeight: sc?.clientHeight ?? 0,
  227 |       };
  228 |     });
  229 |     expect(before.canScrollX).toBe(true);
  230 | 
  231 |     // Настоящая прокрутка колёсиком по полосе, а не присвоение scrollLeft:
  232 |     // у полосы snap-x snap-mandatory, и важно, что жест доводит её до
  233 |     // соседней колонки, а не что число можно записать в свойство.
  234 |     await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  235 |     await page.mouse.wheel(400, 0);
  236 |     await page.waitForTimeout(700);
  237 | 
  238 |     const after = await page.evaluate(() => {
  239 |       const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
  240 |       let sc: HTMLElement | null = s.parentElement;
  241 |       while (sc && sc !== document.body) {
  242 |         if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
  243 |         sc = sc.parentElement;
  244 |       }
  245 |       return { scrollLeft: s.scrollLeft, pageScrollTop: sc?.scrollTop ?? 0 };
  246 |     });
  247 | 
  248 |     expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);
  249 |     // Горизонтальный жест по доске не должен утаскивать за собой страницу:
  250 |     // полоса — единственный скроллер, который здесь двигается.
  251 |     expect(after.pageScrollTop).toBe(before.pageScrollTop);
  252 |   });
  253 | });
  254 | 
```