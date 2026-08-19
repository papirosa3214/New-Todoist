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
  69  |         const badgeRect = el.getBoundingClientRect();
  70  |         const titleRect = title?.getBoundingClientRect();
  71  |         return {
  72  |           text: (el.textContent ?? "").trim(),
  73  |           // Решётка рисуется иконкой (svg), а не символом в тексте.
  74  |           hasHashIcon: !!el.querySelector("svg"),
  75  |           background: cs.backgroundColor,
  76  |           color: cs.color,
  77  |           titleColor: title ? getComputedStyle(title).color : null,
  78  |           aboveTitle: titleRect
  79  |             ? badgeRect.bottom <= titleRect.top + 0.5
  80  |             : null,
  81  |         };
  82  |       }
  83  |       return null;
  84  |     }, CARD);
  85  | 
  86  |     expect(
  87  |       badge,
  88  |       "на доске «Сегодня» не нашлось карточки с меткой проекта",
  89  |     ).not.toBeNull();
  90  |     expect(badge!.text.length).toBeGreaterThan(0);
  91  |     expect(badge!.hasHashIcon).toBe(true);
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
  117 |     await setupApp(context, { today: "board" });
  118 |     await openScreen(page, "/today");
  119 | 
  120 |     const measures = await page.evaluate((sel) => {
  121 |       return Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
  122 |         (card) => {
  123 |           const rect = card.getBoundingClientRect();
  124 |           // Содержимое меряется ТОЛЬКО внутри текстовой колонки. Ручка
  125 |           // перетаскивания — сосед колонки, и у неё -my-3: её
  126 |           // прямоугольник вылезает выше и ниже контентного бокса карточки,
  127 |           // так что наивный обход всех детей вернул бы бессмысленные числа.
  128 |           const col = card.querySelector<HTMLElement>(":scope > div.min-w-0");
  129 |           if (!col) return null;
  130 |           let top = Infinity;
  131 |           let bottom = -Infinity;
  132 |           let topEl = "";
  133 |           let bottomEl = "";
  134 |           col.querySelectorAll<HTMLElement>("*").forEach((el) => {
  135 |             const r = el.getBoundingClientRect();
  136 |             // Пустая обёртка аватарки (w-[24px] без исполнителя) рисуется
  137 |             // всегда и имеет нулевую высоту — она не содержимое.
  138 |             if (r.height <= 0) return;
  139 |             const tag = `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 24)}`;
  140 |             if (r.top < top) {
  141 |               top = r.top;
  142 |               topEl = tag;
  143 |             }
  144 |             if (r.bottom > bottom) {
  145 |               bottom = r.bottom;
  146 |               bottomEl = tag;
  147 |             }
  148 |           });
  149 |           if (!Number.isFinite(top)) return null;
  150 |           return {
  151 |             title: (card.textContent ?? "").trim().slice(0, 30),
  152 |             padTop: +(top - rect.top).toFixed(2),
  153 |             padBottom: +(rect.bottom - bottom).toFixed(2),
  154 |             topEl,
  155 |             bottomEl,
  156 |           };
  157 |         },
  158 |       );
  159 |     }, CARD);
  160 | 
  161 |     const cards = measures.filter((m) => m !== null);
  162 |     expect(cards.length).toBeGreaterThan(0);
  163 |     const offenders = cards
  164 |       .filter((m) => Math.abs(m!.padTop - m!.padBottom) > 2)
  165 |       .map(
  166 |         (m) =>
  167 |           `«${m!.title}»: сверху ${m!.padTop}px (${m!.topEl}), снизу ${m!.padBottom}px (${m!.bottomEl})`,
  168 |       );
> 169 |     expect(offenders).toEqual([]);
      |                       ^ Error: expect(received).toEqual(expected) // deep equality
  170 |   });
  171 | 
  172 |   test("колонки прокручиваются вбок, страница при этом не уезжает по вертикали", async ({
  173 |     page,
  174 |     context,
  175 |   }) => {
  176 |     // «Входящие», а не «Сегодня»: колонок там по числу проектов. У доски
  177 |     // «Сегодня» их часто одна, и тогда полоса намеренно НЕ скроллится
  178 |     // (single-режим в TaskBoard.tsx растягивает единственную колонку и
  179 |     // центрирует её) — проверять на ней горизонтальную прокрутку значило бы
  180 |     // требовать от экрана того, чего он не обещает.
  181 |     await setupApp(context, { inbox: "board" });
  182 |     await openScreen(page, "/inbox");
  183 | 
  184 |     const strip = page.locator("[data-board-strip]");
  185 |     const box = await strip.boundingBox();
  186 |     expect(box).not.toBeNull();
  187 | 
  188 |     const before = await page.evaluate(() => {
  189 |       const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
  190 |       // Тот же обход вверх, что делает findScrollContainer в UI.tsx, —
  191 |       // прокручивается общий контейнер контента из Layout.tsx, и мерить
  192 |       // надо именно его, а не первый попавшийся .overflow-y-auto.
  193 |       let sc: HTMLElement | null = s.parentElement;
  194 |       while (sc && sc !== document.body) {
  195 |         if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
  196 |         sc = sc.parentElement;
  197 |       }
  198 |       return {
  199 |         canScrollX: s.scrollWidth > s.clientWidth,
  200 |         scrollLeft: s.scrollLeft,
  201 |         pageScrollTop: sc?.scrollTop ?? 0,
  202 |         pageScrollHeight: sc?.scrollHeight ?? 0,
  203 |         pageClientHeight: sc?.clientHeight ?? 0,
  204 |       };
  205 |     });
  206 |     expect(before.canScrollX).toBe(true);
  207 | 
  208 |     // Настоящая прокрутка колёсиком по полосе, а не присвоение scrollLeft:
  209 |     // у полосы snap-x snap-mandatory, и важно, что жест доводит её до
  210 |     // соседней колонки, а не что число можно записать в свойство.
  211 |     await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  212 |     await page.mouse.wheel(400, 0);
  213 |     await page.waitForTimeout(700);
  214 | 
  215 |     const after = await page.evaluate(() => {
  216 |       const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
  217 |       let sc: HTMLElement | null = s.parentElement;
  218 |       while (sc && sc !== document.body) {
  219 |         if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
  220 |         sc = sc.parentElement;
  221 |       }
  222 |       return { scrollLeft: s.scrollLeft, pageScrollTop: sc?.scrollTop ?? 0 };
  223 |     });
  224 | 
  225 |     expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);
  226 |     // Горизонтальный жест по доске не должен утаскивать за собой страницу:
  227 |     // полоса — единственный скроллер, который здесь двигается.
  228 |     expect(after.pageScrollTop).toBe(before.pageScrollTop);
  229 |   });
  230 | });
  231 | 
```