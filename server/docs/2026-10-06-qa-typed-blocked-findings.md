# QA-проверка MAK-98 — типизированный blocked, срок жизни сообщения роли, быстрый отказ

**Задача**: 813ac8ec-b14e-4d71-b7ef-f363624c5164 (MAK-98)
**Шаг QA**: «Проверенные сценарии и дефекты»
**Ветка**: roles/813ac8ec-b14e-4d71-b7ef-f363624c5164
**Коммит проверяемого шага**: e2b7c182
**Среда проверки**: server/test (vitest 4.1.10), Node 22.23.1

## Прогон

- Новый тест: `server/test/typedBlockedRoleMessages.test.ts` — 11/11 зелёные.
- Полный серверный набор (`cd server && npx vitest run`): 1015 тестов — 996 passed / 19 failed.
- `npx tsc --noEmit`: чисто.
- Все 19 упавших относятся к смежным задачам (MAK-66/67/68/70/72/77 и др.) и существуют между `origin/main` (35cb1ae7) и HEAD. Коммит e2b7c182 не трогал ни один из упавших файлов, кроме stepOutcome.test.ts (1 правка), и тот в упавших не значится — это и есть baseline main.
- Существующие blocked-тесты (blockedHelpGate, e2e, ownerRelease, returnKeepsSession, stepOutcome) обновлены под обязательный тип — все проходят.

## Матрица критериев приёмки

| Критерий | Где проверено | Статус |
| --- | --- | --- |
| blocked без типа отклоняется | unit `evaluateBlockedType` + e2e «blocked без типа → 400», «неизвестный тип отклоняется» | passed |
| `dependency` снимается сам при готовности зависимости | `liftDependencyBlocks` в planSubtaskAdmission.ts + e2e «dependency-блок шага снимается сам» | passed |
| повторный блок того же вида даёт событие оркестратору | `signalBlock` (blockSignals.ts) + e2e «повторный блок того же вида даёт событие оркестратору» | passed |
| сообщение без ответа за срок возвращается с исходом | `expireRoleQuestions` (roleMessageWait.ts) + e2e «вопрос без ответа за срок» | passed |
| недоступный адресат — немедленный отказ с кодом | `evaluateRecipientAvailability` + 409 в `routes/chats.ts` + e2e «быстрый отказ» | passed |
| needs_input + changes_result=true → владельцу, без — оркестратору | `blockSignalTarget` + два e2e теста | passed |
| Полный серверный набор не краснее, чем на main | 996/19 — те же 19, что и в baseline | passed |

## Наблюдения (не дефекты, требуют решения владельца)

1. **`block_type_repeated` для шага при попытке «blocked → blocked» без смены состояния не пишется.** В `routes/subtasks.ts:952` условие `state === "blocked" && state !== subtask.agent_state` пропускает `signalBlock`, если новое и старое состояния совпадают. Тест «повторный блок» работает через явный цикл `blocked → in_progress → blocked`. Для карточки (`/state`) такого ограничения нет. Это не покрыто ни тестом, ни ТЗ буквально, но ТЗ говорит «по одному шагу», что можно читать двояко. Риск низкий — нормальный поток подразумевает смену состояния.
2. **Планировщик обходит раз в 5 минут, TTL по умолчанию 15 минут.** То есть вопрос может истечь через 15–20 минут после создания. Если упадёт один обход — задержка удвоится. Это компромисс, явно выбранный комментарием в `roleMessageWait.ts`. Решение — на владельце.
3. **`expireRoleQuestions` обходит все `status='open'` без серверного лимита.** Если таблица распухнет до десятков тысяч строк, обход может стать медленным. Сейчас это не блокер — тест работает, поведение предсказуемо, индексация по `status, deadline_at` уже есть.
4. **Триггер `notifications_owner_no_activity`** глушит владельцу типы `assigned/commented/reviewed/agent_state/completed`. Тип `owner_signal` в этом списке нет — сигнал доходит. Проверено в `migrations.ts:2469`. Не баг, просто тонкость, на которую автор уже обратил внимание комментарием в `blockSignals.ts:130`.

## Дефектов, блокирующих приёмку, не найдено.

## Артефакты

- Тест: `server/test/typedBlockedRoleMessages.test.ts` (11 сценариев, все зелёные).
- Источники: `server/src/lib/blockedType.ts`, `server/src/runtime/blockSignals.ts`, `server/src/runtime/roleMessageWait.ts`, `server/src/runtime/planSubtaskAdmission.ts`, `server/src/runtime/scheduler.ts`, `server/src/runtime/inProcessRun.ts`, `server/src/routes/agent-state.ts`, `server/src/routes/subtasks.ts`, `server/src/routes/chats.ts`, `server/src/migrations.ts` (миграция 109).
- Коммит проверяемого шага: `e2b7c182` (`MAK-98: типизированный blocked, срок жизни сообщения роли, быстрый отказ`).