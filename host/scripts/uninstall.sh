#!/bin/bash
# Снимает taskflow-host. Ключ из Keychain по умолчанию НЕ удаляется: он может
# понадобиться при переустановке, а отзыв ключа — дело реестра на .110 (D7).
set -euo pipefail

LABEL="com.taskflow.host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="$HOME/.config/taskflow-host"

die() { echo "ошибка: $*" >&2; exit 1; }

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "Снят $PLIST"
else
  echo "Агента $LABEL и не было — нечего снимать."
fi

echo "Конфиг оставлен в $CONFIG_DIR (удали сам, если он больше не нужен)."
echo "Ключ в Keychain оставлен. Убрать: security delete-generic-password -a mac -s taskflow-host"
echo "Папку с кодом и логи удали сам: ~/Library/Logs/taskflow-host"