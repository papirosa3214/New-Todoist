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

# ═══════ Подтянуть актуальное с origin перед сборкой ═══════
# Добавлено 30.08.2026: чтобы кнопка «собрать» в инфра-панели (а также
# tf-install) всегда работала с последним коммитом main, а не с тем, что
# случайно залежалось в локальной копии. Поведение:
#   - нет сети / origin недоступен → предупреждение, сборка на локальной
#     копии (не блокируем оффлайн-работу)
#   - локально позади origin → fast-forward pull
#   - локальная копия РАСХОДИТСЯ с origin (незапушенные коммиты или
#     незакоммиченные правки) → стоп, подробное сообщение что делать;
#     иначе молча перезатёрло бы чужие правки (см. баг 29.08: a1d077b
#     снёс 320 файлов, и reset на 102 затёр локальные несохранённые
#     копии). Это та защита, которая нужна.
# Отключить: TASKFLOW_SKIP_GIT_PULL=1 tf-install
if [ "${TASKFLOW_SKIP_GIT_PULL:-0}" != "1" ]; then
  шаг "Подтягиваю изменения с origin (если есть)"
  if ! git fetch origin main 2>&1; then
    printf '\033[33m⚠ git fetch не прошёл (нет сети?). Собираю на локальной копии.\033[0m\n' >&2
  else
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    if [ "$LOCAL" != "$REMOTE" ]; then
      # Считаем, насколько мы позади — pull нужен только если отстаём
      if ! git merge --ff-only origin/main 2>&1; then
        printf '\n\033[31m✗ Локальная копия РАСХОДИТСЯ с origin/main — fast-forward невозможен.\033[0m\n\n' >&2
        printf '  Сборка НЕ продолжена, чтобы не перетереть локальные правки.\n' >&2
        printf '\n' >&2
        printf '  Что это значит:\n' >&2
        printf '    • либо в локальной копии есть незапушенные коммиты,\n' >&2
        printf '    • либо есть незакоммиченные изменения в рабочей копии.\n' >&2
        printf '\n' >&2
        printf '  Что делать (выбери одно):\n' >&2
        printf '    1) Закоммить и запушить:\n' >&2
        printf '         cd %s\n' "$PROJECT" >&2
        printf '         git add -A && git commit -m "..." && git push origin main\n' >&2
        printf '    2) Откатить локальные правки (если они не нужны):\n' >&2
        printf '         cd %s\n' "$PROJECT" >&2
        printf '         git reset --hard origin/main\n' >&2
        printf '    3) Построить на текущей локальной копии (отключив pull):\n' >&2
        printf '         TASKFLOW_SKIP_GIT_PULL=1 tf-install\n' >&2
        printf '\n' >&2
        printf '  Диагностика:\n' >&2
        printf '    git -C %s status\n' "$PROJECT" >&2
        printf '    git -C %s log --oneline origin/main..HEAD\n' "$PROJECT" >&2
        exit 1
      fi
    fi
  fi
fi

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
