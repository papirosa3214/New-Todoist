# Карточка 412f89f4 — серверная fallback-цепочка консультации

## Что сделано

- `consultant_model: "auto"` (новое поведение по умолчанию для
  `POST /api/tasks/:id/consultation`) запускает серверную цепочку
  Opus → GPT-6.1 SOL (openai-codex) → OpenCode Go (deepseek-v4.1-flash).
  Каждая ступень — со своим тайм-аутом 60 с. Один POST = одна попытка,
  повторы внутри цепочки не делаются (ни одна ступень не дёргается
  дважды).
- Явные алиасы `opus`/`sonnet`/`haiku` из `CONSULTANT_MODEL_MAP`
  продолжают ходить через старый `callUnifiedAi` — обратная совместимость
  для ролей и существующих тестов.
- Фактический провайдер/модель и список попыток пишутся в
  `consultation_log` (новые колонки `actual_provider`, `actual_model`,
  `chain_attempts`) и отдаются агенту в JSON-ответе
  (`actual_provider`, `actual_model`, `chain_attempts[]`).
- Лимит R6 (одна консультация на попытку) тратится только при
  успешном ответе любой ступени. Если все три ступени ответили
  ошибкой транспорта — ответ 502, `consultation_count` остаётся 0,
  повторный POST сможет попробовать снова (когда провайдер вернётся).
  Бизнес-ошибка (контент-фильтр, плохой промпт) тоже не съедает лимит
  и НЕ идёт на следующую ступень — провайдер живой, повтор не поможет.

## Окружение

- ENV-ручки для конфигурации без правки кода:
  - `TASKFLOW_CONSULT_OPUS_MODEL` (по умолчанию `claude-opus-4-5`)
  - `TASKFLOW_CONSULT_SOL_MODEL`  (по умолчанию `gpt-6.1-sol`)
  - `TASKFLOW_CONSULT_GO_MODEL`   (по умолчанию `deepseek-v4.1-flash`)
- Ступени ищутся через тот же `ModelRuntime` из
  `@earendil-works/pi-coding-agent`, что и роли. Если модель ступени
  недоступна (`getModel()` вернул `undefined`) — ступень пропускается,
  не блокирует цепочку.
- Шесть минут максимум на всю цепочку (3 × 60 с). Если нужно
  принудительно открыть ответ быстрее — у каждой ступени свой
  `AbortController`.

## Классификация ошибок

| Категория            | Что в неё попадает                                       | Действие                                                |
|----------------------|----------------------------------------------------------|---------------------------------------------------------|
| `transport`          | 429 / rate-limit / 5xx / timeout / overloaded / aborted  | идём к следующей ступени                                |
| `missing_model`      | провайдер не отдаёт нужную модель                        | идём к следующей ступени                                |
| `business`           | контент-фильтр, прочие ответы провайдера «живой, отказ» | выходим сразу, лимит не тратится                        |
| `ok`                 | текст получен                                            | возвращаем ответ, лимит +1                              |

## Изменённые/новые файлы

- `server/src/lib/consultationChain.ts` — общий runner цепочки
  (по ступени: получить модель из `ModelRuntime`, вызвать
  `completeSimple`, классифицировать ответ).
- `server/src/routes/consultation.ts` — `performConsultation` развилка:
  алиас → старый `callUnifiedAi`, иначе → `runConsultationChain`.
  Запись фактических `actual_provider`/`actual_model`/`chain_attempts`
  в БД и в ответе.
- `server/src/migrations.ts` — миграция 123
  `123_consultation_chain_log` добавляет три nullable-колонки
  в `consultation_log` (идемпотентно через `PRAGMA table_info`).
- `server/test/consultationChain.test.ts` — 7 целевых тестов:
  Opus limit → SOL, Opus miss + SOL limit → Go, все падают, бизнес-ошибка,
  повторная попытка после провала, единственный вызов цепочки,
  обратная совместимость `opus` из старого алиаса.

## Проверки

- `npx tsc --noEmit` (server) — без ошибок.
- `npx vitest run test/consultation.test.ts test/consultationChain.test.ts test/consultRoleTool.test.ts test/consultationTriggers.test.ts`
  — 26/26 зелёных. Старые тесты консультации (5 кейсов, замоканный
  `callUnifiedAi`) прошли без правок: явные алиасы по-прежнему идут
  через старый путь.
- На реальный сетевой Opus/SOL/OpenCode-Go тесты не ходят: цепочка
  замокана на уровне `runConsultationChain`. Живой прогон — это
  ручное действие владельца.

## Что НЕ сделано и почему

- Сам живой сетевой запрос Opus/SOL/OpenCode-Go в этой карточке не
  выдан: `consultation_log` уже пишет `actual_provider/actual_model`,
  поэтому при первом живом запросе сразу видно, кто ответил и кто
  упал. Владелец сказал не расходовать живые лимиты ради широких
  тестов.
- Подписочные токены OpenCode-Go не смешиваются с подпиской Opus
  у anthropic/openai-codex: цепочка идёт по провайдерам из
  `ModelRuntime`, а не по алиасам подписок ролей.
- DeepSeek V4 Pro из ТЗ в каталоге `opencode-go` сейчас недоступен —
  по умолчанию берётся `deepseek-v4.1-flash`. Подмена через
  `TASKFLOW_CONSULT_GO_MODEL`.

## Границы карточки

- Не правил `callUnifiedAi`, `callRuntimeModel`, `providerFailover`,
  `providerProbe` и `ai.ts` — у них своя зона ответственности, эта
  правка только консультации.
- Не менял лимит R6 (одна консультация на attempt) — он сохранён и
  инкрементируется только при успехе любой ступени.
- Не правил файлы параллельных карточек
  (`planSubtaskAdmission`, `planMutations`, `planReviewLifecycle`,
  `slotConversation`, `inProcessRun`).
- Мак/iOS — вне зоны.
