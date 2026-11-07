#!/usr/bin/env bash
# taskflow-shim.sh — bash-обёртка над API TaskFlow для dsh, когда MCP-плагин
# @deepseek-ai/dsh-mcp-client падает с `process is not defined` (29.08.2026).
#
# Использование (через tool-bash в dsh):
#   taskflow-shim.sh <command> [--json '<json>'] [--jq '<expr>']
#
# Команды (подмножество API):
#   me                      — кто я (auth/me)
#   projects                — список проектов
#   agents                  — список агентов
#   task <id>               — детали задачи
#   claim <id>              — взять задачу
#   comment <id> <text...>  — оставить комментарий
#   state <id> <state>      — сменить state (in_progress|review|blocked)
#   subtask_done <id> <text> — закрыть шаг с результатом
#   create_project <name>   — создать проект, печатает id
#   create_task <json>      — создать задачу
#
# Авторизация: берёт токен из $TASKFLOW_VAULT_KEY, читает значение через
# vault-get по этому имени, иначе использует сам $TASKFLOW_VAULT_KEY как токен.
# Переменная $TASKFLOW_BASE позволяет переопределить API base (default http://localhost:3001).

set -euo pipefail

BASE="${TASKFLOW_BASE:-http://localhost:3001}"
TOKEN="$(/home/maksim/.claude/vault-get.py --raw "${TASKFLOW_VAULT_KEY}" 2>/dev/null || echo "${TASKFLOW_VAULT_KEY}")"

api() {
  local method="$1" path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body" "$BASE$path"
  else
    curl -sS --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" "$BASE$path"
  fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  me)                api GET /api/auth/me ;;
  projects)          api GET /api/projects ;;
  agents)            api GET /api/agents ;;
  task)              api GET "/api/tasks/${1:?usage: task <id>}" ;;
  claim)             api POST "/api/tasks/${1:?usage: claim <id>}/claim" '{}' ;;
  comment)           shift; api POST "/api/tasks/${1:?usage: comment <id> <text...>}/comments" "$(python3 -c "import json,sys;print(json.dumps({'text':' '.join(sys.argv[1:])}))" "$@")" ;;
  state)             api POST "/api/tasks/${1:?usage: state <id> <state>}/state" "$(python3 -c "import json,sys;print(json.dumps({'state':sys.argv[1]}))" "${2:?}")" ;;
  subtask_done)      api PATCH "/api/subtasks/${1:?usage: subtask_done <id> <text>}" "$(python3 -c "import json,sys;print(json.dumps({'done':True,'result':sys.argv[1]}))" "${2:?}")" ;;
  create_project)    api POST /api/projects "$(python3 -c "import json,sys;print(json.dumps({'name':sys.argv[1]}))" "${1:?}")" ;;
  create_task)
    payload="${1:?usage: create_task <json>}"
    api POST /api/tasks "$payload"
    ;;
  help|*)
    cat <<EOF
taskflow-shim.sh — обёртка над API TaskFlow.
Команды: me, projects, agents, task <id>, claim <id>, comment <id> <text>,
state <id> <state>, subtask_done <id> <text>, create_project <name>,
create_task <json>
Переменные окружения: TASKFLOW_VAULT_KEY (имя ключа в vault, либо сам ключ),
TASKFLOW_BASE (default http://localhost:3001).
EOF
    exit 1
    ;;
esac
