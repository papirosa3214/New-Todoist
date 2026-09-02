#!/usr/bin/env bash
# Синк нативного проекта с .110 на Мак и сборка там.
# Код пишется и хранится на .110 (единственная копия), Мак — только сборочная площадка.
#
#   ./sync-build.sh sync     — только залить исходники на Мак
#   ./sync-build.sh sim      — залить + собрать под симулятор (быстрая проверка компиляции)
#   ./sync-build.sh device   — залить + подписанная сборка + установка на iPhone Air
#
# Мак ищется по mDNS (адрес плавает по DHCP), а не берётся из конфига.
set -euo pipefail

# Мак и каталог сборки на нём — общие для всех исполнителей. Без замка два
# rsync --delete и два xcodebuild наезжают друг на друга: чужой синк подменяет
# файлы прямо во время чужой компиляции. Замок локальный (все запуски идут
# с .110), поэтому очередь выстраивается сама.
exec 9>/tmp/tf-native-build.lock
flock 9

SRC="$HOME/Проекты/New-Todoist/native/"
DST_DIR="Проекты/TaskFlowNativeBuild"
SCHEME="TaskFlow"
PROJECT="TaskFlow.xcodeproj"
BUNDLE_ID="com.maksim.taskflow.native"
DEVICE_UUID="B752C915-688A-5FE2-B7A2-CD355FCD8D47"   # iPhone Air, из xcrun devicectl list devices
SIM_NAME="iPhone 17 Pro"

MAC_IP="$(avahi-resolve -n MacBook-Pro-Maksim.local 2>/dev/null | awk '{print $2}')"
[ -n "$MAC_IP" ] || { echo "Мак не резолвится по mDNS — включён ли он?"; exit 1; }
MAC="max@$MAC_IP"
REMOTE="\$HOME/$DST_DIR"

sync() {
  echo "→ синк на $MAC:$DST_DIR"
  ssh "$MAC" "mkdir -p '$DST_DIR'"
  rsync -az --delete \
    --exclude 'build_*' --exclude '*.xcodeproj' --exclude '.DS_Store' \
    -e ssh "$SRC" "$MAC:$DST_DIR/"
}

generate() { ssh "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd $REMOTE && xcodegen generate"; }

case "${1:-sim}" in
  sync) sync ;;
  sim)
    sync; generate
    ssh "$MAC" "cd $REMOTE && xcodebuild -project $PROJECT -scheme $SCHEME -sdk iphonesimulator \
      -destination 'platform=iOS Simulator,name=$SIM_NAME' -derivedDataPath build_sim build" 2>&1 | tail -25
    ;;
  device)
    sync; generate
    ssh "$MAC" "cd $REMOTE && xcodebuild -project $PROJECT -scheme $SCHEME -sdk iphoneos -configuration Debug \
      -destination 'id=$DEVICE_UUID' -derivedDataPath build_dev_signed -allowProvisioningUpdates build" 2>&1 | tail -25
    ssh "$MAC" "xcrun devicectl device install app --device $DEVICE_UUID \
      $REMOTE/build_dev_signed/Build/Products/Debug-iphoneos/$SCHEME.app"
    ;;
  *) echo "sync | sim | device"; exit 1 ;;
esac
