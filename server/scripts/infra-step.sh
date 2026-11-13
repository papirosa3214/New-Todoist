#!/usr/bin/env bash
# Один шаг Инженера .110 без рассуждений: состояние, здоровье, выкладка, перезапуск, журнал.
#
# Зачем (владелец 13.11.2026). В ноябре 14 слотов Инженера .110, и типовой
# результат шага дословно: «из этой сессии на .110 нет канала записи (ssh без
# ключа, host-инструменты знают только macbook, taskflow_inspect — только
# чтение)». Роль под tfrole не может ни systemctl, ни ssh
# (server/src/runtime/localRoleOperations.ts:7-9). Этот скрипт запускается от
# maksim и делает механику; роль решает только «что делать» и читает код возврата.
#
# Использование (от maksim, не от tfrole):
#   server/scripts/infra-step.sh health
#   server/scripts/infra-step.sh status
#   server/scripts/infra-step.sh logs [N]
#   server/scripts/infra-step.sh restart
#   server/scripts/infra-step.sh deploy        # тяжёлая: вызывает infra-ops/deploy-now.sh
#
# Каждый вызов печатает одну строку JSON и выходит с кодом:
#   0 — действие выполнено и проверено, 1 — выполнено с замечанием, 2 — не удалось,
#   3 — неверное использование.
set -uo pipefail

UNIT=${TASKFLOW_UNIT:-taskflow-server}
HEALTH_URL=${TASKFLOW_HEALTH_URL:-https://127.0.0.1:5180/api/health}
DEPLOY_STATE=$HOME/.local/state/taskflow-deploy
DEPLOY_LOG=$DEPLOY_STATE/deploy.log

ACTION=${1:-}
ARG=${2:-30}

emit() { # emit <state> <code> <json-поля>
  local state="$1" code="$2" extra="${3:-}"
  [ -n "$extra" ] && extra=",$extra"
  echo "{\"state\":\"$state\",\"unit\":\"$UNIT\"$extra}"
  exit "$code"
}

health_body() {
  curl -s -k --max-time 8 "$HEALTH_URL" 2>/dev/null
}

case "$ACTION" in
  health)
    BODY=$(health_body)
    CODE=$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null)
    if [ "$CODE" = "200" ]; then
      emit ok 0 "\"http\":200,\"body\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$BODY")"
    fi
    emit unhealthy 2 "\"http\":${CODE:-000}"
    ;;

  status)
    ACTIVE=$(systemctl --user is-active "$UNIT" 2>/dev/null || echo unknown)
    PID=$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
    RSS=""
    [ "${PID:-0}" -gt 0 ] 2>/dev/null && RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
    DEPLOYED=$(cat "$DEPLOY_STATE/deployed" 2>/dev/null || echo "")
    LASTDEPLOY=$(tail -n 1 "$DEPLOY_LOG" 2>/dev/null | cut -c1-160 || echo "")
    HCODE=$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null)
    NEWEST=$(systemctl --user show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null || echo "")
    PAYLOAD=$(python3 - "$ACTIVE" "${PID:-0}" "${RSS:-0}" "$HCODE" "$DEPLOYED" "$NEWEST" "$LASTDEPLOY" <<'PY'
import json, sys
active, pid, rss, hcode, deployed, since, lastline = sys.argv[1:8]
print(json.dumps({
    "active": active,
    "main_pid": int(pid or 0),
    "rss_mb": round(int(rss or 0) / 1024) if rss else 0,
    "health_http": hcode,
    "deployed_commit": deployed.strip(),
    "since": since.strip(),
    "last_deploy_line": lastline.strip(),
}, ensure_ascii=False))
PY
)
    [ "$ACTIVE" = "active" ] && [ "$HCODE" = "200" ] && emit ok 0 "\"facts\":$PAYLOAD"
    emit degraded 1 "\"facts\":$PAYLOAD"
    ;;

  logs)
    echo "{\"state\":\"ok\",\"unit\":\"$UNIT\",\"lines\":$ARG}"
    journalctl --user -u "$UNIT" -n "$ARG" --no-pager 2>/dev/null | tail -n "$ARG"
    exit 0
    ;;

  restart)
    systemctl --user restart "$UNIT" 2>/tmp/infra-step-restart.err
    RC=$?
    if [ "$RC" != 0 ]; then
      emit restart_failed 2 "\"error\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$(cat /tmp/infra-step-restart.err)")"
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      HCODE=$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null)
      [ "$HCODE" = "200" ] && emit restarted 0 "\"http\":200"
    done
    emit restarted_unhealthy 2 "\"http\":${HCODE:-000}"
    ;;

  deploy)
    [ -x "$HOME/infra-ops/deploy-now.sh" ] || emit deploy_missing 2 "\"path\":\"$HOME/infra-ops/deploy-now.sh\""
    LOG=/tmp/infra-step-deploy-$(date +%Y%m%d-%H%M%S).log
    "$HOME/infra-ops/deploy-now.sh" >"$LOG" 2>&1
    RC=$?
    HCODE=$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null)
    DEPLOYED=$(cat "$DEPLOY_STATE/deployed" 2>/dev/null | tr -d '\n')
    if [ "$RC" = 0 ] && [ "$HCODE" = "200" ]; then
      emit deployed 0 "\"log\":\"$LOG\",\"deployed_commit\":\"$DEPLOYED\""
    fi
    emit deploy_failed 2 "\"log\":\"$LOG\",\"rc\":$RC,\"http\":${HCODE:-000}"
    ;;

  *)
    echo '{"state":"usage","actions":["health","status","logs [N]","restart","deploy"]}'
    exit 3
    ;;
esac
