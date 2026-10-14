#!/usr/bin/env bash
# Погасить копию, поднятую scripts/qa/up.sh, и удалить её снимок базы.
#   scripts/qa/down.sh [каталог_шага]
set -uo pipefail
SRC="$(cd "${1:-$PWD}" && git rev-parse --show-toplevel)"
KEY="$(printf %s "$SRC" | md5sum | cut -c1-8)"
STATE="${QA_STATE_DIR:-$HOME/.local/state/taskflow-qa}/$KEY"
if [ -f "$STATE/pids" ]; then
  while read -r pid; do
    # Гасим процесс и его детей (обёртки npm/sh), чужие не трогаем.
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done < "$STATE/pids"
fi
sleep 1
rm -rf "$STATE"/taskflow.db* "$STATE/uploads" "$STATE/pids" "$STATE/urls"
echo "погашено: $SRC"
