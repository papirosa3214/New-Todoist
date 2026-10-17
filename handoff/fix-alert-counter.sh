#!/usr/bin/env bash
# Починка счётчика доставки тревог в ~/infra-ops/autonomy-report.py.
# Карточка bba9da7b-0c3a-4ddd-8445-25cce8777125, 17.10.2026.
#
# Что делает: перестаёт считать потерями каждую строку журнала отправок. Журнал
# пишется и при успешной доставке, поэтому сводка каждое утро писала
# «у отправителей НЕ УШЛО N» при N успешных отправках и rendezvous заводил на это
# карточку. Настоящие потери (непустая причина сбоя + тревога не ушла второй
# попыткой, либо запасная дорога не дошла) по-прежнему поднимают тревогу.
#
# Запускать от владельца машины (maksim): агентский сеанс работает от tfrole и в
# ~/infra-ops писать не может. Скрипт сам делает резервную копию, проверяет патч,
# компилирует и показывает, что теперь пишет проверка.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-/home/maksim/infra-ops}"
PATCH="${PATCH:-$HERE/notification-delivery-counter.patch}"

cd "$REPO"
BAK="autonomy-report.py.bak-$(date +%Y%m%d-%H%M%S)"
cp -a autonomy-report.py "$BAK"
git apply --check "$PATCH"
git apply "$PATCH"
python3 -m py_compile autonomy-report.py

echo "резервная копия: $REPO/$BAK"
echo "--- что теперь пишет проверка доставки:"
python3 - "$REPO/autonomy-report.py" "$REPO" <<'PY'
import importlib.util, sys, pathlib
path, repo = sys.argv[1], sys.argv[2]
for p in (pathlib.Path(path).parent, pathlib.Path(repo), pathlib.Path("/home/maksim/infra-ops")):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
spec = importlib.util.spec_from_file_location("autonomy_report_probe", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.delivery_watch())
PY
echo "Готово: сводка напишет «потерь за 36 ч нет», а не «НЕ УШЛО N»."
echo "Откат, если что-то пойдёт не так: cd $REPO && git checkout -- autonomy-report.py"