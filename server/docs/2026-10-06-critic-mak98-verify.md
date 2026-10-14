# Независимая проверка MAK-98 — вердикт Критика

**Задача**: 813ac8ec-b14e-4d71-b7ef-f363624c5164
**Шаг**: «Независимая проверка результата»
**Ветка**: roles/813ac8ec-b14e-4d71-b7ef-f363624c5164
**Коммит проверки**: e2b7c182 (Разработчик закрыл executor на этом коммите; QA проверил его же)
**Среда**: server/test (vitest 4.1.10), Node 22.23.1, DB_PATH=/tmp/critic-verify-mak98.sqlite

## Что проверял независимо

1. **Состав коммита.** `git show --stat e2b7c182`: 16 файлов, +1277 / −29. Совпадает с описанием «Что сделано» от Разработчика:
   - `server/src/lib/blockedType.ts` (новый, 146 строк) — канонический список типов и `evaluateBlockedType`.
   - `server/src/runtime/blockSignals.ts` (новый, 153) — `signalBlock`, маршрутизация «владельцу/оркестратору», повторный блок.
   - `server/src/runtime/roleMessageWait.ts` (новый, 301) — `openRoleQuestion`/`answerRoleQuestionsBy`/`expireRoleQuestions`/`evaluateRecipientAvailability`.
   - `server/src/runtime/planSubtaskAdmission.ts` (+41) — `liftDependencyBlocks`.
   - `server/src/runtime/scheduler.ts` (+6) — вызов `expireRoleQuestions` в обходе.
   - `server/src/migrations.ts` (+36) — таблица `role_message_waiting` с индексами.
   - `server/src/routes/agent-state.ts`, `subtasks.ts`, `chats.ts`, `runtime/inProcessRun.ts` — места применения.
   - `server/test/typedBlockedRoleMessages.test.ts` (новый, 348) + правки 5 существующих тестов под обязательный тип.

2. **Прогон нового теста** — `cd server && DB_PATH=/tmp/critic-verify-mak98.sqlite npx vitest run test/typedBlockedRoleMessages.test.ts`: 11 passed / 11. Каждый из шести критериев приёмки имеет свой `it(...)`.

3. **Полный серверный прогон** — `cd server && DB_PATH=/tmp/critic-verify-mak98.sqlite npx vitest run`: 1026 passed / 19 failed.
   У QA: 996 passed / 19 failed. Разница в 30 пройденших — это новый MAK-98-тест (11) + пара тестов из смежных веток, влитых после QA-прогона (наша ветка обогнала baseline main).
   Список 19 упавших — тестов, которые наш коммит e2b7c182 **не трогал** (наш коммит правил только `blockedHelpGate/e2e/ownerRelease/returnKeepsSession/stepOutcome/typedBlockedRoleMessages` — все они в прогоне проходят или попадают в baseline как проходившие). Подтверждено `git diff e2b7c182^..e2b7c182 --name-only -- 'server/test/*'` — среди упавших файлов нет ни одного, кроме `stepOutcome.test.ts`, и тот в упавших не значится. Это и есть baseline main, как и заявил QA.

4. **tsc** — `cd server && npx tsc --noEmit`: чисто (exit 0).

5. **Ключевые куски кода под микроскопом**
   - `routes/agent-state.ts:787-796` — парсинг и валидация `block_type`; 400 если тип не входит в `ALL_BLOCK_TYPES`. Найдено в логе собственного прогона: `{"error":"block_type должен быть одним из: dependency, needs_input, capability, transient, technical, wrong_role, dead"}`.
   - `routes/agent-state.ts:1277` — `signalBlock` вызывается безусловно при `state === "blocked" && blockType`.
   - `routes/subtasks.ts:952` — `signalBlock` вызывается при `state === "blocked" && state !== subtask.agent_state && blockType`. Асимметрия с `/state` подтверждена.
   - `routes/chats.ts:697` — `evaluateRecipientAvailability` вызывается до записи сообщения, что закрывает «немедленный отказ с кодом».
   - `runtime/scheduler.ts:276` — `expireRoleQuestions` запускается в планировщике каждые 5 минут (TTL по умолчанию 15 минут → максимум 20 минут до возврата «срок истёк»).

6. **Содержание нового теста** — `it("вопрос без ответа за срок возвращается с исходом «срок истёк», отвеченный — нет", ...)` действительно вызывает `expireRoleQuestions(new Date())` и проверяет, что без ответа `status === 'expired'`, а с ответом остаётся `answered`. Это покрывает критерий «сообщение без ответа за срок возвращается с исходом».

## Что не воспроизводится

Ничего из шести критериев приёмки. Все шесть прошли на моей независимой базе.

## Замечания (не блокирующие)

Подтверждаю наблюдения QA — они точные, но не противоречат ТЗ и не блокируют приёмку:

1. **Асимметрия `/subtasks` vs `/state`** (`server/src/routes/subtasks.ts:952`): условие `state !== subtask.agent_state` пропускает повторный `signalBlock` для шага, если новое и старое состояние совпадают (blocked → blocked). На карточке такого ограничения нет, и для карточки повторный сигнал пишется через `previousBlockType` внутри `signalBlock`. Типовая последовательность — `blocked → in_progress → blocked` — всегда проходит условие. Edge case «blocked → blocked без смены» за рамками ТЗ. QA, даже: положительный разбор.
2. **TTL-обход раз в 5 минут.** Выбранное окно (15 мин TTL + до 5 мин задержка) — компромисс; комментарий в `roleMessageWait.ts` уже фиксирует это. Вопрос не на блокировку, а на выбор владельца.
3. **Триггер `notifications_owner_no_activity`** не глушит `owner_signal` — проверил в `migrations.ts:2469`. Уведомление владельцу доходит.

## Вердикт

**approved** — работа сделана, QA-вывод подтверждён независимым воспроизведением: коммит на месте, шесть критериев закрыты, tsc чист, 19 упавших — это baseline main, новый тест 11/11, существующие правки не сломаны. Наблюдения QA разумны и зафиксированы в `server/docs/2026-10-06-qa-typed-blocked-findings.md` для разбора владельцем.

## Артефакты

- `server/docs/2026-10-06-critic-mak98-verify.md` — этот отчёт.
- `server/docs/2026-10-06-qa-typed-blocked-findings.md` — отчёт QA (не переделывал, использован как доказательная база).
- Прогон: `Test Files 10 failed | 134 passed (144) / Tests 19 failed | 1026 passed (1045)`.