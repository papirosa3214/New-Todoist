#!/bin/bash
# Кладёт ключ машины в Keychain macOS (D7).
#
# Ключ намеренно вводится руками: `security add-generic-password` спросит его
# сам, и секрет не появится ни в истории команд, ни в выводе ps. Автоматическая
# передача ключа аргументом означала бы его в ps на всё время работы security.
#
# Ключ выпускается на .110 (vault, тикет 1) и кладётся здесь.
set -euo pipefail

ACCOUNT="${1:-mac}"
SERVICE="${2:-taskflow-host}"

die() { echo "ошибка: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Keychain есть только на маке"

if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1; then
  echo "Запись $SERVICE/$ACCOUNT уже есть. Перезаписать? (yes/no)"
  read -r answer
  [[ "$answer" == "yes" ]] || { echo "Оставляю как есть."; exit 0; }
fi

echo "Введи ключ машины (ввод не отображается):"
security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" -D user \
  -j "taskflow-host: ключ машины для шлюза TaskFlow"

echo "Готово. Проверить: security find-generic-password -a $ACCOUNT -s $SERVICE -w | wc -c"