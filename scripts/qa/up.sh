#!/usr/bin/env bash
# Поднять КОПИЮ приложения для живой проверки роли QA.
#   scripts/qa/up.sh [каталог_шага]     (по умолчанию — текущий git-каталог)
# Печатает строки WEB=… API=… STATE=…; гасить — scripts/qa/down.sh с тем же каталогом.
#
# Что делает: снимок живой базы (sqlite .backup, живую не трогает), свой API и
# свой vite на свободных портах из ЭТОГО каталога, вход без пароля (LAN_NO_AUTH,
# только 127.0.0.1). Фоновые службы копии выключены: роли, планировщик, Linear,
# голос, база знаний — иначе копия ушла бы в реальные модели и внешние сервисы.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "${1:-$PWD}" && git rev-parse --show-toplevel)"
LIVE_DB="${QA_SOURCE_DB:-$HOME/Проекты/New-Todoist/server/taskflow.db}"
KEY="$(printf %s "$SRC" | md5sum | cut -c1-8)"
STATE="${QA_STATE_DIR:-$HOME/.local/state/taskflow-qa}/$KEY"

if [ -f "$STATE/pids" ] && kill -0 "$(head -1 "$STATE/pids")" 2>/dev/null; then
  echo "уже поднято для $SRC:"; cat "$STATE/urls"; exit 0
fi

# Без флага песочницы в коде каталога копия запустила бы роли на настоящих моделях.
if ! grep -q TASKFLOW_QA_SANDBOX "$SRC/server/src/index.ts"; then
  echo "ОТКАЗ: в $SRC/server/src/index.ts нет TASKFLOW_QA_SANDBOX — влей свежий main в ветку." >&2
  exit 3
fi
[ -e "$SRC/node_modules" ] || ln -s "$HOME/Проекты/New-Todoist/node_modules" "$SRC/node_modules"
[ -e "$SRC/server/node_modules" ] || ln -s "$HOME/Проекты/New-Todoist/server/node_modules" "$SRC/server/node_modules"

mkdir -p "$STATE"
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

# Снимок базы + обезвреживание: очередь запусков ролей пустая, чтобы ничто не стартовало.
rm -f "$STATE"/taskflow.db*
sqlite3 "$LIVE_DB" ".backup '$STATE/taskflow.db'"
sqlite3 "$STATE/taskflow.db" "DELETE FROM role_run_jobs;" 2>/dev/null || true

cd "$SRC/server"
env PORT="$API_PORT" HOST=127.0.0.1 DB_PATH="$STATE/taskflow.db" \
  TASKFLOW_QA_SANDBOX=1 TASKFLOW_LAN_NO_AUTH=1 \
  LINEAR_AUTOIMPORT_DISABLED=1 LINEAR_SYNC_DISABLED=1 ORCHESTRATOR_WEBHOOK_DISABLED=1 \
  TASKFLOW_AUTO_PREPARATION=0 INBOX_TRIAGE_DISABLED=1 ACTIVITY_OBSERVER_ENABLED=false \
  TASKFLOW_NOTIF_ROOT="$STATE/нет-такого-каталога" \
  nohup ./node_modules/.bin/tsx src/index.ts > "$STATE/api.log" 2>&1 &
API_PID=$!

cd "$SRC"
env QA_API_PORT="$API_PORT" \
  nohup "$SRC/node_modules/.bin/vite" "$SRC" --config "$HERE/vite.qa.config.ts" \
  --port "$WEB_PORT" --strictPort > "$STATE/web.log" 2>&1 &
WEB_PID=$!
printf '%s\n%s\n' "$API_PID" "$WEB_PID" > "$STATE/pids"

# Ждём, пока ответит и фронт, и API через его прокси; иначе гасим и называем логи.
ok=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/auth/me" || true)"
  if [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "504" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "ОШИБКА: копия не поднялась, логи: $STATE/api.log $STATE/web.log" >&2
  "$HERE/down.sh" "$SRC" >/dev/null 2>&1 || true
  exit 4
fi
printf 'WEB=http://127.0.0.1:%s\nAPI=http://127.0.0.1:%s\nSTATE=%s\n' "$WEB_PORT" "$API_PORT" "$STATE" | tee "$STATE/urls"
