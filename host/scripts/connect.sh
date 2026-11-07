#!/bin/bash
# Подключение мака к шлюзу TaskFlow — одной командой.
#
# Что делает:
#   1. кладёт ключ машины в Keychain (аргументом или ключом из окружения);
#   2. пишет конфиг хоста в ~/.config/taskflow-host/config.json;
#   3. ставит taskflow-host как LaunchAgent — автозапуск и перезапуск при падении.
#
# Запуск:        ./scripts/connect.sh
# С ключом:     ./scripts/connect.sh tfh_XXXX…
# Отключение:   ./scripts/uninstall.sh
#
# Ключ можно не вставлять руками: положи его в файл ~/.config/taskflow-host/key
# (права 600), и скрипт возьмёт оттуда.
set -euo pipefail

HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.taskflow.host"
SERVICE="taskflow-host"
ACCOUNT="mac"
GATEWAY_HOST="${TASKFLOW_GATEWAY_HOST:-192.168.1.110}"
GATEWAY_PORT="${TASKFLOW_GATEWAY_PORT:-3001}"
ROOTS="${TASKFLOW_HOST_ROOTS:-/Users/max}"

die() { echo "ошибка: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "этот скрипт ставит службу на маке (launchd)"

CONFIG_DIR="$HOME/.config/taskflow-host"
CONFIG="$CONFIG_DIR/config.json"
KEY_FILE="$CONFIG_DIR/key"
mkdir -p "$CONFIG_DIR"

# ── ключ ────────────────────────────────────────────────────────────────
KEY="${1:-}"
if [[ -z "$KEY" && -f "$KEY_FILE" ]]; then
  KEY="$(cat "$KEY_FILE")"
fi
[[ -n "$KEY" ]] || die "не знаю ключ. Либо положи его в $KEY_FILE, либо передай первым аргументом: ./scripts/connect.sh tfh_XXXX…"

# Ключ кладём в Keychain без попадания в историю команд и в ps.
if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1; then
  echo "ключ в Keychain уже есть — перезаписываю свежим."
else
  echo "ключ кладу в Keychain ($SERVICE/$ACCOUNT)…"
fi
security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" -D user \
  -j "taskflow-host: ключ машины для шлюза TaskFlow" -w "$KEY" >/dev/null
chmod 600 "$CONFIG_DIR/config.json" 2>/dev/null || true

# ── конфиг ──────────────────────────────────────────────────────────────
IFS=',' read -r -a ROOTS_ARR <<< "$ROOTS"
ROOTS_JSON=""
for r in "${ROOTS_ARR[@]}"; do
  r="$(printf '%s' "$r" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$r" ]] && continue
  [[ -n "$ROOTS_JSON" ]] && ROOTS_JSON="$ROOTS_JSON,"
  ROOTS_JSON="$ROOTS_JSON\"$r\""
done
ROOTS_JSON="[$ROOTS_JSON]"

cat > "$CONFIG" <<JSON
{
  "gatewayUrl": "ws://$GATEWAY_HOST:$GATEWAY_PORT/host-ws",
  "machineId": "$ACCOUNT",
  "roots": $ROOTS_JSON
}
JSON
echo "конфиг: $CONFIG"
echo "шлюз:   ws://$GATEWAY_HOST:$GATEWAY_PORT/host-ws"
echo "корни:  $ROOTS"

# ── сборка и установка ──────────────────────────────────────────────────
cd "$HOST_DIR"
echo "собираю…"
npm install --silent --no-audit --no-fund >/dev/null 2>&1 || true
npm run build >/dev/null
echo "ставлю службу…"
"$HOST_DIR/scripts/install.sh" "ws://$GATEWAY_HOST:$GATEWAY_PORT/host-ws"

echo
echo "Готово."
echo "  состояние: launchctl list | grep $LABEL"
echo "  логи:      tail -f ~/Library/Logs/taskflow-host/host.log"
