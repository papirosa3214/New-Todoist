# Голосовой TaskFlow Секретаря: универсальный контракт

19.10.2026. Голосовой манифест строится из buildRoleToolCatalog и публикует
ровно один TaskFlow-инструмент taskflow — тот же discover/describe/invoke,
которым пользуется чат. Отдельный voice allowlist не используется. runVoiceTool
передаёт вызов в execute этого каталога и сохраняет универсальный ответ,
включая ok, error, hint и request_id.

## Совместимость голосового провайдера

Google LiveKit schema transformer удаляет additionalProperties, а затем
опускает объектные схемы без properties. Поэтому универсальное поле
arguments (Type.Record) сериализуется для функции голоса как строка JSON.
runVoiceTool разбирает её обратно в объект до общего execute. Это адаптация
схемы одного инструмента, не второй каталог операций. Worker получает исходную
JSON Schema из GET /secretary/tools, регистрирует каждую запись через
function_tool(raw_schema=...), а ответ /secretary/tool возвращает модели
строкой; текущий envelope проходит без изменения.

## Безопасная проверка live manifest

На .110 команда ниже делает только GET по Unix-сокету (без токена и без
записи задачи), проверяет число инструментов и допустимые действия, а тело
ответа не печатает:

```sh
ssh maksim 'sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/taskflow-secretary/voice.sock"; curl --silent --show-error --fail --unix-socket "$sock" http://localhost/secretary/tools | jq -e '"'"'.tools | length == 1 and .[0].name == "taskflow" and .[0].parameters.properties.action.enum == ["discover","describe","invoke"]'"'"' >/dev/null && echo "PASS: один универсальный taskflow"'
```

## Проверки и границы доказательства

- Красный тест до реализации воспроизводил 74 voice tools вместо одного и
  неизвестный taskflow при вызове.
- test/secretary-tool-parity.test.ts: 4/4 PASS на Node 22; проверяет manifest,
  action/request_id, восстановление JSON-аргументов и универсальный error envelope.
- tsc --noEmit -p tsconfig.json на Node 22: PASS.
- Python worker проверен чтением кода; отдельная правка ему не нужна.
- Текущий live Unix-socket manifest на момент проверки всё ещё содержит 74
  старых инструмента. Это ожидаемо: код не развёртывался и процесс не
  перезапускался. Активных строк в role_run_jobs и chat_message_queue при
  read-only проверке БД не было.
- Живой звонок не выполнялся; совместимость реального звонка не подтверждена.
