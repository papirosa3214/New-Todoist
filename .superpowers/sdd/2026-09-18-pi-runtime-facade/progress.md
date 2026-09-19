# SDD ledger — plan: docs/superpowers/plans/2026-09-18-pi-runtime-facade.md

Создан 2026-09-18, исполнитель: Архитектор (role_architect), модель: MiniMax-M3.
Карточка TaskFlow: f3108dcc-acc4-4df2-857d-4c1172378c7c.

## Preflight scan

Скан конфликтов в плане перед исполнением:

| Пара задач | Общий файл / интерфейс | Что один производит / другой потребляет | Найдено |
| --- | --- | --- | --- |
| Task 2 ↔ Task 9 | `server/scripts/trigger.py` | Task 2 переименовывает `agent_pi` в SHELL_AGENT_IDS; Task 9 переводит handle_task на единый путь. | Конфликт: Task 2 переименовывает ключ, Task 9 удаляет вызов resolve_agent_for_role, который этот ключ использовал. **Руль: Task 2 переименовывает ТОЛЬКО ключ в SHELL_AGENT_IDS, не трогает resolve_agent_for_role (тот падёт в Task 9).** |
| Task 2 ↔ Task 10 | `server/test/roles.test.ts` | Task 2 запускает тест — он падает на `default_shell: "agent_pi"`; Task 10 чинит ассерт. | Ок: это нормальный TDD-цикл. |
| Task 5 ↔ Task 6 | `server/src/runtime/` | Task 5 создаёт PiRuntimeAdapter; Task 6 делает над ним API. | Ок: Task 6 импортирует `piRuntime` из barrel, созданного в Task 5. |
| Task 5 ↔ Task 7 | `server/src/routes/runtime.ts` | Task 6 создаёт файл, Task 7 дополняет providers. | Ок: Task 7 модифицирует существующий файл. |
| Task 6 ↔ Task 7 | `server/src/index.ts` | Оба регистрируют маршруты в index.ts. | Конфликт: оба пишут `registerRuntimeRoutes(app)`. **Руль: Task 6 регистрирует, Task 7 НЕ трогает index.ts — только дописывает маршруты в runtime.ts (registerRuntimeRoutes уже вызван в Task 6).** |
| Task 8 ↔ Task 9 | `server/src/roleRouting.ts` | Task 8 переименовывает функции; Task 9 не трогает. | Ок. |
| Task 8 ↔ Task 5 | `server/src/roleRouting.ts` ↔ `server/src/runtime/PiRuntimeAdapter.ts` | Task 5 импортирует `loadRoleRouting` из roleRouting.ts; Task 8 переименовывает его. | Конфликт: Task 5 уже импортирует старое имя. **Руль: Task 5 импортирует `loadRoleRouting` AS-IS; Task 8 переименовывает и оставляет deprecated-обёртку `loadRoleRouting` (алиас на `loadRuntimeConfig`).** |

## Status

Task 1: complete (commits 2578e2a3, спек и план зафиксированы).
Task 2: complete (commits ff9b6eed, agent_pi → pi_runtime в role-routing и SHELL_AGENT_IDS, legacy-alias через SHELL_AGENT_ALIASES и resolve_shell_id()).
Task 3: complete (commits 560d05b6, LEGACY_EXTERNAL_AGENTS удалён — 124 строки, файл парсится ast.parse).
Task 4: complete (commits f9a37088, фасадные типы + 6 type guards).
Task 5: complete (commits 0c5ab971, RuntimeAdapter interface + PiRuntimeAdapter).
Task 6: complete (commits 02b7c899, API /api/runtime/{status,profiles,models}).
Task 7: complete (commits 437e51c3, API /api/runtime/providers + auth-заглушка).
Task 8: complete (commits d5c5c75e, roleRouting.ts: loadRoleRouting → loadRuntimeConfig, nextShellForRole → nextModelForProfile, SHELL_USER_IDS → SHELL_AGENT_IDS, + providerOfModel(). roles.ts:roleDetails → runtime_id рядом с default_shell. agent-state.ts:1306 оставлен на nextShellForRole — ruling).
Task 9: complete (commits c9004137, resolve_agent_for_role возвращает role_<role_name>).
Task 10: complete (commits 77a1af52, ассерты под pi_runtime).
Task 11: complete (commits 8ca642fa, docs/taskflow-orchestrator.md: Pi Agent → Pi runtime).
Task 12: pending (финальная проверка, закрытие).

## Environment notes

- `npx tsc --noEmit -p server` — clean (только warning про experimental EnvHttpProxyAgent).
- `npx vitest run server/test/roles.test.ts` — падает на инициализации БД: `SqliteError: FOREIGN KEY constraint failed` в migrations.ts:1376 (INSERT INTO projects owner_id='u1'). Это давний баг тестового окружения, не связан с этой карточкой. Проверено: падает и без моих правок (git stash → vitest → stash pop).
- `python3 -m pytest` — модуль pytest не установлен в окружении (`No module named pytest`). План использует pytest для trigger.py — буду запускать тесты через существующие runner'ы в server/scripts/ если есть, иначе фиксировать как skip.

## Auth

Claim карточки через `taskflow_claim` (MCP) падает с 400 «invalid transition»: MCP ходит как `Pi Agent` (service-account), карточка назначена на `role_architect`. Обход: `python3 ~/.claude/vault-run.py --secret TF=TASKFLOW_AGENT_TOKEN_ARCHITECT -- bash -c 'curl -sS -X POST http://localhost:3001/api/tasks/<id>/claim ...'`. Heartbeat тоже только через vault-run. `taskflow_subtask_work/done/comment` через MCP работают.

Lease: 5 минут, продлевать ≤4 минут через vault-run.

## Rulings (в хронологическом порядке)

- Task 2 vs Task 9 (resolve_agent_for_role): переименовать только ключ в Task 2, удалить функцию в Task 9. Cost if wrong: лишний поиск `agent_pi` через `resolve_agent_for_role` — но Task 9 удаляет вызов, так что риск 0.
- Task 6 vs Task 7 (index.ts): Task 7 не трогает index.ts. Cost if wrong: дубль регистрации — легко откатить.
- Task 5 vs Task 8 (loadRoleRouting): Task 5 импортирует старое имя, Task 8 оставляет deprecated-обёртку. Cost if wrong: если Task 8 не оставит обёртку — Task 5 сломается на импорте. Чек-лист: при выполнении Task 8 проверить, что в `server/src/roleRouting.ts` есть `export function loadRoleRouting` (даже если deprecated).
- Task 8 (nextShellForRole → nextModelForProfile в agent-state.ts:1306): **не переводить** вызов на новую семантику. Семантика «следующая модель для fallback» требует изменений в `attempts`/`executor_id`/`runner` и в логике перезапуска — это миграция БД и поведения, вне scope «фасад без миграции БД». Оставляю `nextShellForRole` + `loadRoleRouting` (deprecated алиасы) в вызове. Добавляю в комментарий указание на следующую карточку. **Cost if wrong**: семантика fallback'а остаётся прежней — если она сломается при provider limit (что невозможно в текущей архитектуре с одним Pi), поведение будет прежним. Чистый нулевой риск.
