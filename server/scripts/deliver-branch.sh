#!/usr/bin/env bash
# Доставка ветки карточки без участия модели: коммит → проверка типов → push → отчёт.
#
# Зачем (владелец 13.11.2026). В ноябре 26 слотов разработчика, и типовой блок
# в результатах дословно: «в main его нет, а влить ветку и выложить на .110
# нечем: нет серверного клона, ssh на .110 отклоняется, push в GitHub без
# учётных данных». Причина не в GitHub: роли работают под пользователем tfrole,
# у которого нет ssh-ключей (server/src/runtime/localRoleOperations.ts:9).
# Этот скрипт запускается от maksim, у которого ключ есть, и делает ровно
# механическую часть.
#
# Чего скрипт НЕ делает: не вливает в main. Вливание — дело сервера
# (acceptedMerge → worktreeMergeQueue, auto_merge_mode=on), ручки «влить» нет.
#
# Использование:
#   server/scripts/deliver-branch.sh <task_id> [--commit] [--tsc] [--push]
#     --commit  закоммитить незакоммиченное в рабочей копии (автор maksim)
#     --tsc     прогнать tsc --noEmit в worktree
#     --push    отправить ветку roles/<task_id> в origin и github
# Итог — одна строка JSON в stdout, код возврата 0/2/3.
set -uo pipefail

DB=/home/maksim/Проекты/New-Todoist/server/taskflow.db
LIVE=${MAK70_LIVE_REPO:-/home/maksim/Проекты/New-Todoist}
WT_BASE=${TASKFLOW_WORKTREES:-$HOME/.local/state/taskflow-runs/worktrees}
KEY=${GITHUB_KEY:-$HOME/.ssh/github_ed25519}

TASK_ID=${1:-}
[ -z "$TASK_ID" ] && { echo '{"error":"usage: deliver-branch.sh <task_id> [--commit] [--tsc] [--push]"}'; exit 3; }
shift || true

DO_COMMIT=0; DO_TSC=0; DO_PUSH=0
for f in "$@"; do
  case "$f" in
    --commit) DO_COMMIT=1;;
    --tsc) DO_TSC=1;;
    --push) DO_PUSH=1;;
    *) echo "{\"error\":\"неизвестный флаг $f\"}"; exit 3;;
  esac
done

WT="$WT_BASE/$TASK_ID"
BRANCH="roles/$TASK_ID"

json() { python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin),ensure_ascii=False))'; }

if [ ! -d "$WT" ]; then
  echo "{\"state\":\"no_worktree\",\"task_id\":\"$TASK_ID\",\"path\":\"$WT\",\"next\":\"рабочей копии нет: карточка закрывалась без хоста или уже убрана\"}"
  exit 2
fi

cd "$WT" || exit 3
git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "{\"state\":\"not_a_repo\",\"path\":\"$WT\"}"; exit 2; }

NOTES=()
# ── 1. Незакоммиченное: это и есть «index.lock / нет прав» из отчётов ролей
DIRTY=$(git status --porcelain | wc -l)
if [ "$DIRTY" -gt 0 ] && [ "$DO_COMMIT" = 1 ]; then
  git add -A && git -c user.name="TaskFlow delivery" -c user.email="delivery@taskflow.local" \
    commit -q -m "deliver: правки карточки $TASK_ID" || NOTES+=("коммит не удался")
  NOTES+=("закоммичено файлов: $DIRTY")
elif [ "$DIRTY" -gt 0 ]; then
  NOTES+=("незакоммиченных файлов: $DIRTY (добавь --commit)")
fi

# ── 2. Сколько коммитов уходит вперёд main
AHEAD=$(git rev-list --count "main..$BRANCH" 2>/dev/null || echo 0)
if [ "$AHEAD" = 0 ]; then
  python3 - "$TASK_ID" "$BRANCH" "$DIRTY" <<'PY'
import json, sys
print(json.dumps({"state": "nothing_to_deliver", "task_id": sys.argv[1],
                  "branch": sys.argv[2], "dirty_files": int(sys.argv[3]),
                  "next": "ветка не ушла вперёд main; незакоммиченное добавляется флагом --commit"},
                 ensure_ascii=False))
PY
  exit 2
fi

# ── 3. Проверка типов (точечно, без прогона тестов)
TSC_CODE=null
if [ "$DO_TSC" = 1 ] && [ -d server ]; then
  ( cd server && npx tsc --noEmit >/tmp/deliver-tsc-$TASK_ID.log 2>&1 )
  TSC_CODE=$?
  [ "$TSC_CODE" != 0 ] && NOTES+=("tsc не чист: /tmp/deliver-tsc-$TASK_ID.log")
fi

# ── 4. Push ветки (ключ maksim, не tfrole)
PUSH_OK=false
if [ "$DO_PUSH" = 1 ]; then
  export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  PUSH_OK=true
  for remote in origin github; do
    git remote get-url "$remote" >/dev/null 2>&1 || continue
    if git push -q "$remote" "$BRANCH" 2>>/tmp/deliver-push-$TASK_ID.log; then
      NOTES+=("ветка ушла в $remote")
    else
      PUSH_OK=false
      NOTES+=("push в $remote отклонён: /tmp/deliver-push-$TASK_ID.log")
    fi
  done
fi

ON_MAIN=$(git merge-base --is-ancestor "$BRANCH" main && echo true || echo false)

python3 - "$TASK_ID" "$BRANCH" "$AHEAD" "$TSC_CODE" "$PUSH_OK" "$ON_MAIN" "${NOTES[*]:-}" <<'PY'
import json, sys
task, branch, ahead, tsc, pushed, on_main, notes = sys.argv[1:8]
payload = {
    "state": "already_in_main" if on_main == "true" else "ready_to_merge",
    "task_id": task,
    "branch": branch,
    "commits_ahead": int(ahead),
    "tsc_code": None if tsc == "null" else int(tsc),
    "pushed": pushed == "true",
    "in_main": on_main == "true",
    "notes": [n for n in notes.split("  ") if n],
    "next": "вливание делает сервер при приёмке результата (acceptedMerge, auto_merge_mode=on); "
            "ручного «влить» нет",
}
print(json.dumps(payload, ensure_ascii=False))
PY
exit 0
