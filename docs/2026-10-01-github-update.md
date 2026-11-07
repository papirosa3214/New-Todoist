# Обновление из GitHub — 01.10.2026

Источник: papirosa3214/TaskFlow-v1, ветка claude/fervent-fermi-2lswkc, коммит 61dfcc2a (6 коммитов после b96ba125).
Перенесены только изменения server/ в канонический серверный репозиторий; исходные app/ перенесены отдельно в TaskFlowNativeBuild.

Проверено: npm run build; vitest 99 файлов, 723/723 теста (PATH с Python 3.14). Миграция 082 на копии живой БД: integrity_check=ok.
Резервная копия .110: /home/maksim/backups/taskflow/before-github-20261001-010359.db.
Выложен b40f4a3 в main на .110 через остановку сервиса, git pull --ff-only, запуск. Проверено: systemctl --user is-active=active; /api/health ok=true; 082_live_collaboration_plan отмечена в schema_migrations; task_collaboration_plan_ops существует; integrity_check=ok.
QA/критика задачи 15c2db1f: живые данные не изменены, ожидается решение владельца.
