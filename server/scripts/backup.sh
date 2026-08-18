#!/usr/bin/env bash
# Ночной слепок базы TaskFlow + вложений на NAS.
#
# Тот же приём, что ~/bin/kaneo-backup.sh (Kaneo — предшественник этого
# трекера, урок 06.08.2026: случайное удаление проекта снесло 37 задач без
# корзины, спас случайный слепок): молчит при успехе, кричит в n8n при
# сбое, ротация по возрасту, размер бэкапа проверяется — пустой файл это
# провал, а не «технически бэкап создан».
#
# Два куска, не один: сама база (server/taskflow.db) и файлы вложений
# (server/uploads/) — они физически разделены (см. db.ts, комментарий у
# CREATE TABLE attachments), скопировать только базу — потерять
# прикреплённые файлы без следа: в базе останется голая запись attachments
# со stored_name, которому будет некуда указывать.
#
# База сначала копируется ЛОКАЛЬНО через `sqlite3 .backup` (штатный
# безопасный путь SQLite для горячего бэкапа при живом писателе — сервер
# держит базу в WAL-режиме, db.ts, и обычно жив во время бэкапа, поэтому
# нельзя просто `cp` исходник), а уже готовый статичный файл — обычным `cp`
# на NAS. НЕ backup напрямую на NAS: `/mnt/nas` — сетевой диск (CIFS/SMB,
# см. `mount`), а .backup открывает и блокирует ЦЕЛЕВОЙ файл как базу
# SQLite при записи, и CIFS не даёт нужной блокировки — живая ошибка
# 15.08.2026, ".backup" прямо на /mnt/nas падал с "database is locked" на
# КАЖДОЙ попытке, хотя источник был в полном порядке (та же команда в /tmp
# отрабатывала с первого раза). Копия обычным `cp` уже готового, закрытого
# файла такой проблемы не имеет — он просто байты, не живая цель блокировки.
set -uo pipefail

REPO="/home/maksim/Проекты/New-Todoist"
DB="$REPO/server/taskflow.db"
UPLOADS="$REPO/server/uploads"
DST="/mnt/nas/backups/taskflow"
STAGE="/tmp/taskflow-backup-stage"          # локально — сюда безопасно писать .backup
KEEP=30                                     # дней хранения
DATE=$(date +%F)
LOG="$HOME/logs/taskflow-backup.log"
HOOK="http://127.0.0.1:5678/webhook/alert"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
alert() {
  curl -s --noproxy '*' -m 10 -X POST "$HOOK" -H 'Content-Type: application/json' \
    -d "$(printf '{"source":"taskflow-backup","level":"%s","title":"%s","text":"%s"}' "$1" "$2" "$3")" \
    >/dev/null 2>&1
}

mkdir -p "$(dirname "$LOG")"

if ! mountpoint -q /mnt/nas; then
  log "NAS не подключён — слепок пропущен"
  alert error "Слепок TaskFlow" "NAS не подключён, слепок не снят."
  exit 1
fi

if [ ! -f "$DB" ]; then
  log "базы нет: $DB"
  alert error "Слепок TaskFlow" "Файла базы нет: $DB."
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE" || {
  log "не создать локальный staging $STAGE"
  alert error "Слепок TaskFlow" "Не создать локальный staging $STAGE."
  exit 1
}

# 1. База — локально, .timeout на случай короткой блокировки записи от
# живого сервера (без него sqlite3 сразу отвечает "database is locked"
# вместо того, чтобы чуть подождать и попробовать снова).
if sqlite3 "$DB" ".timeout 10000" ".backup '$STAGE/taskflow.db'" 2>>"$LOG"; then
  SIZE=$(stat -c %s "$STAGE/taskflow.db")
  if [ "$SIZE" -lt 1000 ]; then
    log "бэкап базы подозрительно мал: $SIZE байт"
    alert error "Слепок TaskFlow" "Бэкап базы вышел пустым ($SIZE байт) — проверь TaskFlow."
    rm -rf "$STAGE"
    exit 1
  fi
  log "база (локально): $SIZE байт"
else
  log "sqlite3 .backup не отработал"
  alert error "Слепок TaskFlow" "Не смог снять бэкап базы (sqlite3 .backup)."
  rm -rf "$STAGE"
  exit 1
fi

# 2. Вложения — тоже сначала локально: та же логика, один каталог назначения
if [ -d "$UPLOADS" ]; then
  if cp -a "$UPLOADS" "$STAGE/uploads"; then
    N=$(find "$STAGE/uploads" -type f | wc -l)
    log "вложения (локально): $N файлов"
  else
    log "копирование вложений в staging не отработало"
    alert error "Слепок TaskFlow" "База скопирована, но вложения — нет. Проверь $UPLOADS."
    # без exit 1 — база важнее, продолжаем с тем, что получилось
  fi
fi

# 3. Готовое (статичное, закрытое) — на NAS одним куском
OUT="$DST/$DATE"
mkdir -p "$OUT" || {
  log "не создать каталог на NAS $OUT"
  alert error "Слепок TaskFlow" "База и вложения собраны локально, но не создать $OUT на NAS."
  rm -rf "$STAGE"
  exit 1
}
if cp -a "$STAGE/." "$OUT/"; then
  log "слепок на NAS: $OUT"
else
  log "копирование на NAS не отработало"
  alert error "Слепок TaskFlow" "База и вложения собраны локально ($STAGE), но не скопировались на NAS."
  exit 1
fi

rm -rf "$STAGE"

# 4. Убрать старое — только каталоги вида ГГГГ-ММ-ДД старше KEEP дней
find "$DST" -maxdepth 1 -type d -name '20*' -mtime +"$KEEP" -exec rm -rf {} + 2>/dev/null

log "слепок готов: $OUT"
exit 0
