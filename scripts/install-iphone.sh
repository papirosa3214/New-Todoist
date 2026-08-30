#!/bin/bash
# ═══════════ Собрать TaskFlow и поставить на iPhone ═══════════
#
# Запускается НА МАКЕ, руками (27.08.2026, решение владельца: «ты мне будешь
# просто команды давать, которые всё это создают и устанавливают»). Подпись
# из ssh-сессии не проходит — связка ключей не отдаёт ключ без графической
# сессии, поэтому шаг xcodebuild должен идти из терминала самого владельца.
#
# Что делает: собирает веб → переносит его в iOS-проект → собирает и
# подписывает приложение → ставит на телефон по Wi-Fi.
#
#   tf-install            обычный заход
#   tf-install --fast     пропустить сборку веба (правок во фронте не было)

set -euo pipefail

# Корень репо. По умолчанию — родительская директория самого скрипта
# (scripts/ лежит в корне репо, значит, корень = scripts/..). Это работает
# в любом cwd, без env. $TASKFLOW_DIR перебивает — для случая, когда
# скрипт копируют отдельно от репо или держат несколько клонов.
PROJECT="${TASKFLOW_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# UDID телефона для сборки и его же идентификатор для установки. Разные
# системы — xcodebuild берёт первый, devicectl второй.
DEVICE_UDID="${TASKFLOW_IPHONE_UDID:-00008150-001545400144401C}"
DEVICE_CORE="${TASKFLOW_IPHONE_CORE:-B752C915-688A-5FE2-B7A2-CD355FCD8D47}"

export PATH="/opt/homebrew/bin:$PATH"

шаг() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

cd "$PROJECT"

if [ "${1:-}" != "--fast" ]; then
  шаг "Собираю веб"
  npm run build

  шаг "Переношу в iOS-проект"
  npx cap sync ios
fi

шаг "Проверяю телефон"
if ! xcrun devicectl list devices 2>/dev/null | grep -q "$DEVICE_CORE"; then
  echo "Телефон не виден. Разблокируй его и держи в одной сети с Маком (или воткни кабель)." >&2
  exit 1
fi

шаг "Собираю и подписываю приложение"
cd ios/App
# -allowProvisioningUpdates: профиль бесплатной подписи Xcode заводит сам.
# Команду разработчика НЕ переопределяем — с чужой даёт «No Account for Team».
xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphoneos -configuration Release \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath build_dev_signed \
  -allowProvisioningUpdates build

шаг "Ставлю на телефон"
xcrun devicectl device install app --device "$DEVICE_CORE" \
  build_dev_signed/Build/Products/Release-iphoneos/App.app

printf '\n\033[32m✓ Готово — приложение на телефоне.\033[0m\n'
