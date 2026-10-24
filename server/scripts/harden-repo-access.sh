#!/usr/bin/env bash
# Закрытие доступа пользователя ролей (tfrole) к основному репозиторию.
#
# ПРОБЛЕМА (аудит 24.10.2026): на каталогах репозитория висел ACL
# `u:tfrole:rwx` и `d:u:tfrole:rwx`. Он не был замыслом — роли работают
# в СВОИХ рабочих копиях (~/.local/state/taskflow-runs/worktrees/<task_id>,
# ветка roles/<task_id>), и доступ к рабочей копии выдаётся отдельно
# (grantRoleAccess в server/src/runtime/localRoleOperations.ts).
#
# ЧТО ЭТО ДАВАЛО РОЛИ:
#  1. Правка server/src/** и server/dist/** в ОСНОВНОМ рабочем дереве.
#     dist/ — это исполняемый код сервера (systemd запускает
#     `node dist/index.js`), то есть роль могла подменить работающий сервер.
#  2. Запись в .git/config → подмена core.hooksPath → выполнение кода роли
#     при следующем коммите владельца (тот коммит идёт от maksim, с его
#     секретами в окружении). Это полная эскалация без всяких push.
#  3. Запись в .git/refs/heads/** → попытка сдвинуть ветку main.
#  4. Чтение server/taskflow.db (mode 674) → api_token владельца,
#     password_hash всех пользователей, вся переписка чатов.
#
# ЧТО ОСТАЁТСЯ РОЛИ (нужно для работы):
#  - .git/objects/**         — записать свои git-объекты при коммите;
#  - .git/refs/heads/roles/** — обновить свой ref ветки roles/<task_id>;
#  - .git/worktrees/<id>/**  — index и служебные файлы своей worktree;
#  - чтение репозитория      — роль читает исходники для контекста.
#
# Ветку main отдельно не трогаем: git сам отказывает в push в
# checkout-ную ветку («refusing to update checked out branch»), а
# update-ref на не-коммит отклоняется («trying to write non-commit
# object»). Права на .git/refs/heads/main убираем, чтобы и обычная
# запись в ref была невозможна.
#
# Скрипт идемпотентен: можно запускать повторно.

set -uo pipefail

ROLE_USER="${TASKFLOW_ROLE_USER:-tfrole}"
REPO="${1:-/home/maksim/Проекты/New-Todoist}"

# .git — каталог в обычном репозитории, ФАЙЛ в worktree. Ищем общий
# каталог: в worktree он лежит в .git/commondir.
GIT_DIR="$REPO/.git"
if [ -f "$GIT_DIR" ]; then
  COMMON=$(cat "$GIT_DIR" 2>/dev/null | sed -n 's/^gitdir: //p')
  if [ -n "$COMMON" ] && [ -d "$COMMON" ]; then
    case "$COMMON" in
      /*) GIT_DIR="$COMMON" ;;
      *) GIT_DIR="$REPO/$COMMON" ;;
    esac
  fi
fi

if [ ! -d "$GIT_DIR" ]; then
  echo "harden-repo-access: $REPO не похож на git-репозиторий — выхожу"
  exit 0
fi

if ! id "$ROLE_USER" >/dev/null 2>&1; then
  echo "harden-repo-access: пользователя $ROLE_USER нет — выхожу"
  exit 0
fi

have_setfacl=0
command -v setfacl >/dev/null 2>&1 && have_setfacl=1

# ── 1. Снять расширенный ACL с основного рабочего дерева ─────────────────
# setfacl -b убирает и явные записи, и default-наследование.
# ВАЖНО: -R (рекурсивно) — без него ACL остаётся на КАЖДОМ файле, и роль
# продолжает писать в server/src/** и dist/** (проверено 24.10.2026).
# После этого роль может только ЧИТАТЬ репозиторий (other-биты остаются).
if [ "$have_setfacl" = 1 ]; then
  setfacl -R -b "$REPO" 2>/dev/null
  setfacl -R -b "$GIT_DIR" 2>/dev/null
fi

# ── 2. Вернуть роли точечные права, которые ей реально нужны ─────────────
if [ "$have_setfacl" = 1 ]; then
  # Объекты git: роль пишет свои объекты при коммите в своей ветке.
  setfacl -R -m "u:${ROLE_USER}:rwX" "$GIT_DIR/objects" 2>/dev/null
  # Свои ветки: роли/<task_id>.
  mkdir -p "$GIT_DIR/refs/heads/roles" 2>/dev/null
  setfacl -R -m "u:${ROLE_USER}:rwX" "$GIT_DIR/refs/heads/roles" 2>/dev/null
  # Свои worktree: index и служебные файлы.
  if [ -d "$GIT_DIR/worktrees" ]; then
    setfacl -R -m "u:${ROLE_USER}:rwX" "$GIT_DIR/worktrees" 2>/dev/null
  fi
  # Reflog своей ветки: git дописывает историю refs/heads/roles/<id> в
  # .git/logs/refs/heads/roles/<id> при каждом коммите. Без доступа сюда
  # коммит падает с "unable to append to .../logs/refs/heads/roles/<id>".
  if [ -d "$GIT_DIR/logs" ]; then
    setfacl -R -m "u:${ROLE_USER}:rwX" "$GIT_DIR/logs" 2>/dev/null
  fi
fi

# ── 3. Явно запретить запись в ветки владельца ────────────────────────────
# Файл ref'а main: role не должна его перезаписать.
if [ "$have_setfacl" = 1 ]; then
  setfacl -m "u:${ROLE_USER}:r--" "$GIT_DIR/refs/heads/main" 2>/dev/null
  # Каталог refs/heads: запись в него позволяет создать/заменить ЛЮБОЙ ref
  # (в т.ч. main). Оставляем каталог доступным на чтение и обход, а запись
  # ограничиваем подкаталогом roles/ (выше уже выдан).
  setfacl -m "u:${ROLE_USER}:r-x" "$GIT_DIR/refs/heads" 2>/dev/null
fi

# ── 4. Конфиг, хуки, индекс основного рабочего дерева ─────────────────────
# .git/config: подмена core.hooksPath = выполнение кода роли при коммите
# владельца. .git/hooks: тот же сценарий. .git/index: индекс основного
# рабочего дерева — роли не нужен (у неё свой, в .git/worktrees/<id>/).
if [ "$have_setfacl" = 1 ]; then
  # ВАЖНО: режим r--, а не ---. Git ОБЯЗАН прочитать .git/config (иначе
  # «не найден git репозиторий» / «config недоступно»), .git/HEAD и
  # .git/packed-refs (иначе не видно веток). Запрещаем только ЗАПИСЬ.
  # Для .git/index записи роли тоже не нужно (у неё свой, в
  # .git/worktrees/<id>/), но читать его безопасно — тоже r--.
  for f in "$GIT_DIR/config" "$GIT_DIR/index" "$GIT_DIR/HEAD" \
           "$GIT_DIR/packed-refs" "$GIT_DIR/description"; do
    [ -e "$f" ] && setfacl -m "u:${ROLE_USER}:r--" "$f" 2>/dev/null
  done
  # Каталог хуков: роль не ставит хуков (post-commit и т.п.). Каталог нужен
  # на чтение (git его просматривает), запись запрещена.
  if [ -d "$GIT_DIR/hooks" ]; then
    setfacl -m "u:${ROLE_USER}:r-x" "$GIT_DIR/hooks" 2>/dev/null
    setfacl -R -m "u:${ROLE_USER}:r--" "$GIT_DIR/hooks" 2>/dev/null
  fi
  # Каталог .git в целом: запись в него позволяет создать новые файлы
  # (например, .git/refs/heads/<новая-ветка> в обход правил выше).
  setfacl -m "u:${ROLE_USER}:r-x" "$GIT_DIR" 2>/dev/null
fi

# ── 5. База данных: только владелец ──────────────────────────────────────
# mode 674 = other может читать → роль читала api_token владельца,
# password_hash всех пользователей и всю переписку чатов.
for db in "$REPO/server/taskflow.db" "$REPO/server/taskflow.db-wal" "$REPO/server/taskflow.db-shm"; do
  [ -e "$db" ] && chmod 600 "$db" 2>/dev/null
done

# ── 6. Сводка ────────────────────────────────────────────────────────────
echo "harden-repo-access: $REPO — доступ роли ($ROLE_USER) ограничен:"
echo "  остаётся: запись в .git/objects, .git/refs/heads/roles, .git/worktrees; чтение репозитория"
echo "  запрещено: .git/config, .git/hooks, .git/index, refs/heads/main, запись в server/src и dist"
echo "  база server/taskflow.db: 600 (только владелец)"
