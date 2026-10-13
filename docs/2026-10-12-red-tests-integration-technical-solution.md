# Техническое решение: интеграция результатов 6 серверных групп

Карточка 71c1cd6e-ee8d-48ca-8a03-dc5723c958f7, шаг architecture («Техническое решение и риски»), 2026-10-12.

## Контекст и ограничения
- База для всех шести дочерних карточек — один и тот же коммит `7dcddc35` (= HEAD `main`). Слияние линейное, без разъезда миграций и истории.
- В работу входят только серверные правки (`server/`). Веб не трогали (был зелёный), iOS в этой карточке не проверяется.
- Новых зависимостей и новых файлов миграций нет: `package.json` / `package-lock.json` не изменены ни в одной ветке. Добавляются только QA-документы `docs/2026-10-12-qa-prochee-red-tests*.md` и `qa/qa-report.md` (ветка b41b0aca).
- Миграции трогает только ветка b021488c (`server/src/migrations.ts`, пометка 133_agent_rules_manifests как noTransaction). Одновладелец → конфликтов миграций и порядка нет.

## Инвентарь: ветка → коммиты → файлы
| Карточка | Ветка | Коммиты | Файлов |
|---|---|---|---|
| Routing / провайдеры | roles/e36f4852-… | 681b4b06 | 5 |
| Архитектура ролей и инструменты | roles/fb952d5c-… | aace73c9 | 6 |
| Планы коллаборации | roles/39fe9350-… | 5fe283bd (+1835543a QA-doc) | 2 |
| Intake / preparation | roles/b021488c-… | f795cafd, a64dccc | 9 |
| Outcome / отчёты | roles/38772db1-… | 7dd1259b | 5 |
| Прочее | roles/b41b0aca-… | 78d7c034, f715c9e9 (+QA-docs) | 3 + док-ты |

Пересечения файлов между ветками:
- `server/src/lib/webhookWakeWatcher.ts` — три ветки (e36f4852, fb952d5c, b021488c);
- `server/src/runtime/autoPreparation.ts` — две (e36f4852, b021488c);
- `server/src/lib/integrationResponsibility.ts` — две (39fe9350, b021488c).

## Порядок интеграции
1. e36f4852 (681b4b06)
2. fb952d5c (aace73c9)
3. 39fe9350 (5fe283bd)
4. b021488c (f795cafd → a64dccc)
5. 38772db1 (7dd1259b)
6. b41b0aca (78d7c034 → f715c9e9)

Порядок проверен пробным слиянием: пересекающиеся правки `webhookWakeWatcher.ts` и `autoPreparation.ts` ложатся автоматически; единственный конфликт — `integrationResponsibility.ts` на шаге 4.

## Разрешение единственного конфликта
`server/src/lib/integrationResponsibility.ts` — обе ветки правят соседние строки выбора владельца интеграции. Нужны оба смысла:
```
const suggested=candidates.find(c=>c.role==='code_orchestrator'||c.role==='orchestrator')??candidates.find(c=>c.role==='architect')??candidates[0]??null;
const explicitOwner=task.integration_owner_id ? candidates.find(c=>c.id===task.integration_owner_id) ?? {id:task.integration_owner_id,title:task.integration_owner_id,role:'executor'} as Choice : null;
const owner=task.integration_mode==='not_required'?null:task.integration_mode==='manual'?(candidates.find(c=>c.id===task.integration_owner_id)??null):(explicitOwner??suggested);
```
Так сохраняются оба поведения: 5fe283bd даёт фолбэк `suggested` на любого участника, f795cafd отдаёт приоритет явно назначенному `integration_owner_id`.

## Проверки (приёмка)
1. Полный серверный прогон: `cd server && npx vitest run` — 0 красных файлов и 0 красных тестов.
2. `npx tsc --noEmit` — чисто.
3. Совместный прогон на объединённом дереве обязателен: каждая группа проверялась отдельно, полного прогона всех 218 файлов на общем дереве никто не делал.

## Текущий замер (пробное слияние)
Пробное слияние всех шести веток в одноразовой копии + полный прогон:
- на `main`: 62 красных теста в 30 файлах;
- на объединённом дереве: 18 красных в 6 файлах.

Остаточные красные на объединённом дереве:
- `ownerDictation.test.ts` — 5 (детерминированно красные и на main);
- `inProcessRun.test.ts` — 4 (красные и на main);
- `topicTeam.test.ts` — 3;
- `readyDispatchBridge.test.ts` — 3, но поодиночке файл зелёный (19/19) → изоляция/порядок прогона, не логика слияния;
- `branchPlan.test.ts` — 1; `scheduleRepeat.test.ts` — падение файла.

Вывод: объединение закрывает бóльшую часть красных, но приёмка «0 красных» пока не достигнута. Часть остатка — прежние красные, которых не было в списках шести групп (ownerDictation, inProcessRun и др.), часть — изоляция полного прогона.

## Риски интеграции
- **R1.** Три независимые правки `webhookWakeWatcher.ts` сложились текстово, но вместе не проверялись — нужен полный прогон.
- **R2.** `DELETE FROM tasks WHERE id LIKE 'probe-%'` при старте сторожа (ветка e36f4852) — широкое удаление; проверить, что оно не задевает пользовательские задачи.
- **R3.** Изоляция полного прогона: часть красных воспроизводится только в общем прогоне (readyDispatchBridge). Чинить либо изоляцию тестов, либо подтверждать пробным прогоном.
- **R4.** `explicitOwner` может вернуть синтетического кандидата с `role:'executor'`, если `integration_owner_id` не входит в кандидатов — принять как осознанный фолбэк или ограничить.

## Маршрут и ответственный
- Реализация слияния и доведение полного прогона до 0 — шаг `executor` (builder).
- Проверка — шаг `qa`.
- Вердикт — шаг `critic`.
- Ответственный за интеграцию — Архитектор: после положительного вердикта переносит принятый объединённый результат в `main` и проверяет совместный прогон на `main` (шаг `architect_2`).
