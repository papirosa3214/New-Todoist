#!/bin/bash
# Ставит taskflow-host как LaunchAgent пользователя (D11).
#
# Что делает: собирает dist/, пишет конфиг, кладёт ключ в Keychain и
# загружает plist через launchctl. Что НЕ делает: ничего не коммитит, ничего не
# кладёт вне ~/Library и ~/.config.
#
# Запуск:  ./scripts/install.sh ws://192.168.1.110:5181/host
set -euo pipefail

GATEWAY_URL="${1:-}"
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.taskflow.host"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
CONFIG_DIR="$HOME/.config/taskflow-host"
CONFIG="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/Library/Logs/taskflow-host"
TEMPLATE="$HOST_DIR/scripts/com.taskflow.host.plist.template"

die() { echo "ошибка: $*" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "скрипт ставит службу на маке (launchd). На $(uname -s) запускай хоста вручную: npm start"
fi
[[ -n "$GATEWAY_URL" ]] || die "укажи адрес шлюза: ./scripts/install.sh ws://192.168.1.110:5181/host"
[[ "$GATEWAY_URL" == ws://* || "$GATEWAY_URL" == wss://* ]] || die "адрес должен быть ws:// или wss://, получено: $GATEWAY_URL"
[[ -f "$TEMPLATE" ]] || die "нет шаблона $TEMPLATE"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "node не найден. На маке поставь через nvm и запускай скрипт из сессии с nvm use"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "нужен Node 22+, получено $("$NODE_BIN" -v)"

echo "Собираю $HOST_DIR"
# Сборке нужен tsc из devDependencies: ставим всё, собираем, потом отрезаем dev.
(cd "$HOST_DIR" && { npm ci --silent 2>/dev/null || npm install --silent; })
(cd "$HOST_DIR" && npm run build --silent && npm prune --omit=dev --silent)

mkdir -p "$PLIST_DIR" "$CONFIG_DIR" "$LOG_DIR"

# Конфиг без ключа: ключ живёт в Keychain (D7).
# Корень — только репозиторий нативного клиента, не весь $HOME: роль под
# sandbox-exec пишет ровно туда, куда разрешено (владелец 15.10.2026).
# Рабочие копии ролей — внутри корня (.worktrees в .gitignore), иначе
# песочница не пустит в них сборку. Переопределяется TASKFLOW_HOST_ROOT.
ROOT="${TASKFLOW_HOST_ROOT:-$HOME/Проекты/TaskFlowNativeBuild}"
MACHINE_ID="${TASKFLOW_HOST_MACHINE_ID:-mac}"
cat > "$CONFIG" <<JSON
{
  "gatewayUrl": "$GATEWAY_URL",
  "machineId": "$MACHINE_ID",
  "roots": ["$ROOT"],
  "worktreesBase": "$ROOT/.worktrees",
  "keychainService": "taskflow-host",
  "keychainAccount": "mac",
  "logLevel": "info"
}
JSON
chmod 600 "$CONFIG"

# Ключ спрашиваем интерактивно: так он не мелькнёт в выводе ps.
if ! security find-generic-password -a mac -s taskflow-host -w >/dev/null 2>&1; then
  echo "Ключа машины в Keychain нет. Сейчас спрошу и запишу (в выводе ps он не появится)."
  security add-generic-password -U -a mac -s taskflow-host -D user \
    -j "taskflow-host: ключ машины для шлюза TaskFlow"
else
  echo "Ключ в Keychain уже есть — не трогаю."
fi

sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__HOST_DIR__|$HOST_DIR|g" \
    -e "s|__CONFIG__|$CONFIG|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$TEMPLATE" > "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "plist не прошёл проверку: $PLIST"

# Старый агент снимаем молча: сначала установка, иначе не сменить Node.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID/$LABEL"

cat <<ИТОГ
Установлено.
  plist:  $PLIST
  config: $CONFIG
  логи:   $LOG_DIR/host.log и host.err.log

Проверить:
  launchctl print gui/$UID/$LABEL | head -20
  tail -f $LOG_DIR/host.err.log

Снять: ./scripts/uninstall.sh
ИТОГ