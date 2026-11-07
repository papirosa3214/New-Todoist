#!/usr/bin/env bash
# Перезапустить API+web QA-копии, сохранив снимок БД.
# Используется для D-1 проверки: секрет должен пережить restart.
set -euo pipefail
SRC="$(cd "$1" && git rev-parse --show-toplevel)"
KEY="$(printf %s "$SRC" | md5sum | cut -c1-8)"
STATE="${QA_STATE_DIR:-$HOME/.local/state/taskflow-qa}/$KEY"
[ -f "$STATE/pids" ] || { echo "копия не поднята"; exit 1; }

API_PID=$(head -1 "$STATE/pids")
WEB_PID=$(tail -1 "$STATE/pids")

free_port() {
  python3 - "$1" <<'PY'
import socket, sys
p = int(sys.argv[1])
while True:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError:
        p += 1
PY
}
API_PORT="$(free_port 4100)"
WEB_PORT="$(free_port $((API_PORT + 1)))"

# Гасим старые процессы
pkill -P "$API_PID" 2>/dev/null || true
kill "$API_PID" 2>/dev/null || true
pkill -P "$WEB_PID" 2>/dev/null || true
kill "$WEB_PID" 2>/dev/null || true
sleep 2

cd "$SRC/server"
env PORT="$API_PORT" HOST=127.0.0.1 DB_PATH="$STATE/taskflow.db" \
  TASKFLOW_QA_SANDBOX=1 TASKFLOW_LAN_NO_AUTH=1 \
  LINEAR_AUTOIMPORT_DISABLED=1 LINEAR_SYNC_DISABLED=1 ORCHESTRATOR_WEBHOOK_DISABLED=1 \
  TASKFLOW_AUTO_PREPARATION=0 INBOX_TRIAGE_DISABLED=1 ACTIVITY_OBSERVER_ENABLED=false \
  TASKFLOW_NOTIF_ROOT="$STATE/нет-такого-каталога" TASKFLOW_ROLE_ROUTING_FILE="$STATE/role-routing.yaml" \
  TASKFLOW_WEBHOOK_SECRET_KEY="$TASKFLOW_WEBHOOK_SECRET_KEY" \
  nohup ./node_modules/.bin/tsx src/index.ts > "$STATE/api.log" 2>&1 &
NEW_API_PID=$!

cd "$SRC"
env QA_API_PORT="$API_PORT" \
  nohup "$SRC/node_modules/.bin/vite" "$SRC" --config "$HOME/Проекты/New-Todoist/scripts/qa/vite.qa.config.ts" \
  --port "$WEB_PORT" --strictPort > "$STATE/web.log" 2>&1 &
NEW_WEB_PID=$!
printf '%s\n%s\n' "$NEW_API_PID" "$NEW_WEB_PID" > "$STATE/pids"

ok=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/auth/me" || true)"
  if [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "504" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "ОШИБКА: перезапуск не удался"
  cat "$STATE/api.log" "$STATE/web.log" | tail -30
  exit 4
fi
printf 'WEB=http://127.0.0.1:%s\nAPI=http://127.0.0.1:%s\n' "$WEB_PORT" "$API_PORT" | tee "$STATE/urls"
