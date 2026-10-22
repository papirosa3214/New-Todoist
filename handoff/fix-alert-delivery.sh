#!/usr/bin/env bash
# Починка доставки тревог на .110 — 22.10.2026
#
# Что делает:
#   1. кладёт резервные копии двух файлов ~/infra-ops (alert_send.py, autonomy-report.py);
#   2. применяет патч: третья дорога доставки напрямую в посредник tg-relay (мимо n8n,
#      чья база 21.10 подвисла) + честный счёт потерь в утренней сводке;
#   3. проверяет, что файлы компилируются, и печатает, как сводка видит доставку;
#   4. делает коммит в ~/infra-ops ТОЛЬКО этих двух файлов (чужие правки не трогает).
#
# Откат: cd ~/infra-ops && git checkout -- alert_send.py autonomy-report.py
set -euo pipefail
REPO="${1:-$HOME/infra-ops}"
PATCH="${2:-/var/tmp/notification-delivery-channel.patch}"
cd "$REPO"
STAMP=$(date +%Y%m%d-%H%M%S)
cp -p alert_send.py "alert_send.py.bak-$STAMP"
cp -p autonomy-report.py "autonomy-report.py.bak-$STAMP"
if ! git apply --check "$PATCH"; then
  echo "ПАТЧ НЕ ЛОЖИТСЯ НА ТЕКУЩУЮ ВЕРСИЮ ФАЙЛОВ — НИЧЕГО НЕ ПОМЕНЯЛ." >&2
  echo "Откат не нужен: файлы не тронуты. Копии: alert_send.py.bak-$STAMP" >&2
  exit 1
fi
git apply "$PATCH"
python3 -m py_compile alert_send.py autonomy-report.py
echo "--- как сводка видит доставку сейчас:"
python3 - <<'PY'
import importlib
m = importlib.import_module("autonomy-report")
print(m.delivery_watch())
PY
git add alert_send.py autonomy-report.py
git commit -q -m "Доставка тревог: третья дорога мимо n8n и честный счёт потерь

21.10 база n8n (SQLite) подвисла — вебхук тревог не отвечал, и десять тревог
за сутки не дошли до Telegram, хотя посредник был жив. Теперь тревога идёт
третьей дорогой напрямую в посредник tg-relay, мимо n8n.

В сводке потери разделены на новые (о них ещё не говорили — тревога и карточка)
и старые (канал ожил, о сбое уже сказали — история, без новой карточки)."
echo "--- готово. Откат: cd ~/infra-ops && git checkout -- alert_send.py autonomy-report.py"
