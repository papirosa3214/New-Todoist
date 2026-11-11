# CUT-MAP REVIEW — 10.11.2026

Ревью карты [`CUT-MAP-2026-11-10.md`](./CUT-MAP-2026-11-10.md).
Срезка этим файлом не утверждается и не начата.

## Вердикт

Утверждать срезку — после правок карты.

Опоры в целом верны: `dispatch`, `roles`, `acceptedMerge`, `integrationResponsibility`.

Ошибки карты:

- `chatExecutionMode.ts:39` — не ловушка. Это живая команда «оформи как карточку». Ловушка текста режима — `universalTaskflow.ts:160` и `secretaryVoiceBridge.ts:120`. Строку 39 пометить как живую.
- `roleProjectContext`: номера 31/32 (`memoryBlock` / авто-всплытие), не 27/38.
- OUT памяти: добавить `chats.ts:3625` рядом с `inProcessRun.ts:1877`.
- `oneShotReviewInstruction` (`integrationResponsibility.ts` около строки 73 → `inProcessRun.ts:2136`): функцию оставить. Фразу про «через существующую интеграцию» убрать или пометить как ловушку промпта. Файл не парковать.
- Порядок чтения docs расходится: §1 и §5. Согласовать с README: INDEX → CANON → код → узкий doc.

## После ревью

Карта поправлена по этим пунктам 11.11.2026. Срезка не начата. Коммита нет.
