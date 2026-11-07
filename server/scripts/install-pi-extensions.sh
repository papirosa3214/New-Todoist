#!/usr/bin/env bash
# Устанавливает Pi-плагины TaskFlow в глобальный каталог расширений Pi.
#
# Источник правды — ЭТОТ репозиторий, папка `server/scripts/pi-extensions/`.
# Pi грузит расширения из `~/.pi/agent/extensions/` (проверено по загрузчику
# `@earendil-works/pi-coding-agent`: globalExtDir = agentDir/extensions,
# discoverExtensionsInDir берёт *.ts поштучно).
#
# Копируем, а НЕ симлинкуем: Node резолвит реальный путь модуля, и при
# симлинке импорт `@earendil-works/pi-coding-agent` искался бы в репозитории,
# где node_modules нет — плагин не загрузился бы.
#
# Запуск на .110 (от пользователя maksim):
#   server/scripts/install-pi-extensions.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/pi-extensions" && pwd)"
DST_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$DST_DIR"

for f in "$SRC_DIR"/*.ts; do
  [ -e "$f" ] || continue
  cp -f "$f" "$DST_DIR/$(basename "$f")"
  echo "installed $(basename "$f") -> $DST_DIR"
done
