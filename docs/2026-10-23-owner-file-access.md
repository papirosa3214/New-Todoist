# Доступ владельца к рабочим файлам TaskFlow

23.10.2026. Владелец поручил: файлы, создаваемые ролями, должны быть доступны его учётке.

## Причина

В каноническом репозитории default ACL содержал tfrole, но не именованную запись maksim. Новые файлы роли принадлежали tfrole:tfrole, остальные имели только чтение. Директория worktrees уже содержала default ACL maksim; grantRoleAccess в localRoleOperations.ts также предусматривает его для рабочих копий, но не исправлял основной репозиторий.

## Воспроизведение до правки

os.access(rules.ts, os.W_OK) == False. Новый вложенный файл от tfrole в основном репозитории: запись от maksim завершалась PermissionError.

## Исправление

server/scripts/repair_owner_access.py добавляет u:maksim:rwX существующим объектам, а каталогам также default:user:maksim:rwx. Существующие именованные ACL сохраняются. Объекты tfrole обрабатываются через уже разрешённый sudo -n -u tfrole /bin/bash; root и пароль не требуются. Симлинки не обходятся; node_modules, venv, __pycache__ и Git objects не изменяются.

Обработаны 24954 файла/каталога /home/maksim/Проекты/New-Todoist. Проверено и закреплено default ACL /home/maksim/.local/state/taskflow-runs/worktrees. Снимок ACL до правки: /home/maksim/.local/state/taskflow-runs/owner-acl-before-20261023.txt (0600).

## Проверка после правки

python3 server/test/owner_file_access_test.py — PASS. Реальный tfrole создаёт каталог, вложенный каталог и файл с umask 077. maksim читает, переписывает, переименовывает и удаляет. Проверено в корне репозитория, schedules/ и worktrees/. rules.ts и tick.ts открываются r+ без изменения содержимого.

Default ACL действует при обычном создании файлов любой учёткой в этих каталогах. Не выдавался глобальный root-доступ: смена владельца, принудительный chmod, явно снимающий ACL mask, и системные каталоги остаются отдельными административными операциями. Сохранённые файлы рутин не изменены этой правкой; сервер не перезапускался.
