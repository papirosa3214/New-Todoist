# Доставка: ветка и PR (server + iOS)

Решение владельца 11.11.2026 для ролей, которые коммитят в GitHub.

## Репозитории

| Часть | GitHub | Корень на .110 |
| ----- | ------ | -------------- |
| Сервер (API) | `papirosa3214/New-Todoist` | `/home/maksim/Проекты/New-Todoist` |
| Нативный iOS | `papirosa3214/TaskFlowNativeBuild` | `/home/maksim/Проекты/TaskFlowNativeBuild` |

Это **разные** git-репозитории. Правка в обоих — **две ветки**, не один коммит.

## Запрет push в main

Штатный путь:

1. `git fetch github` и `git checkout -B <ветка> github/main` (или worktree под карточку).
2. Только свои файлы; отдельный коммит на каждую независимую правку.
3. Точечные тесты (`npx vitest run <файлы> --maxWorkers=4` для server).
4. `git push -u github <ветка>`.
5. Pull Request → merge (зелёный CI на PR, automerge в `.github/workflows/ci.yml`).

**Не делать:** `git push github main`, локальный merge в main с push, force-push.

## Гигиена веток

После merge PR:

- `git push github --delete <ветка>` (если remote остался);
- локально: `git branch -d <ветка>`, убрать свой worktree, если заводился только под задачу.

Не оставлять сиротские ветки и мусорные worktree.

## Разработчик на .110

- Перед первой правкой iOS: `server/scripts/ensure-ios-repo.sh`.
- Работа в папке проекта карточки — обычные инструменты Pi (read/bash/edit/write), **не** `taskflow_host_*` на Mac.
- Правило в реестре: C23, C29, R584; цикл — C02 (пункты про ветку/PR в чек-листе).

## Оркестратор

В `expected_result` шага указывать репозиторий, ветку и ссылку на PR. Правило R585.

## Где зашито в сервере

- `server/scripts/role-rules.json` — C29, C02, R584, R585.
- `server/src/runtime/roleHome.ts` — подсказка builder про ensure-ios-repo.
- `server/scripts/task-context-hosts.json` — builder без Mac roleDefault.
- `server/src/lib/roleToolScope.ts` — builder без `taskflow_host_*`.
