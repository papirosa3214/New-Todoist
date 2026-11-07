# taskflow-host

Демон на маке: сам подключается к шлюзу TaskFlow на `.110` по WebSocket и выполняет
операции ролей (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`,
`git_worktree`) прямо на маке. Обратный ход не нужен: сервер ни к маку не ходит,
мак засыпает и меняет адрес (D3).

План: [taskflow-host](../artifacts/taskflow-host-plan) — решения D3, D6, D6a, D7, D11.
Тикет: [2. Мак: программа taskflow-host](../artifacts/taskflow-host-plan/tickets/02-mac-host-daemon).

## Что внутри

| Файл | Зачем |
| --- | --- |
| `src/client.ts` | подключение, рукопожатие, вызовы, поток, отмена, пинг, переподключение |
| `src/protocol.ts` | **временная** копия описания сообщений; её заменит модуль из тикета 1 |
| `src/operations/*` | сами операции |
| `src/pathSafety.ts` | проверка, что путь внутри разрешённого корня (D6) |
| `src/keychain.ts` | чтение ключа из Keychain мака (D7) |
| `src/config.ts` | конфигурация: файл → окружение → аргументы |
| `scripts/install.sh` | ставит LaunchAgent пользователя (D11) |

## Постановка на маке

```bash
cd ~/Проекты/taskflow-host
npm ci
npm run build

# ключ машины (спросит ввод, в ps не попадёт)
./scripts/install-keychain.sh

# конфиг + plist + запуск
./scripts/install.sh ws://192.168.1.110:5181/host
```

Проверить:

```bash
launchctl print gui/$UID/com.taskflow.host | head -20
tail -f ~/Library/Logs/taskflow-host/host.err.log
```

Снять: `./scripts/uninstall.sh`. Службу и launchd в этом репозитории не запускали —
живой запуск делается после того, как сойдётся серверная половина.

## Конфигурация

Файл `~/.config/taskflow-host/config.json` (путь меняется флагом `--config=` или
`TASKFLOW_HOST_CONFIG`). Каждое поле перекрывается переменной `TASKFLOW_HOST_*`, а
затем аргументом `--поле=значение`.

| Поле | По умолчанию | Смысл |
| --- | --- | --- |
| `gatewayUrl` | — | адрес шлюза, обязателен; единственная вещь, которая меняется при смене порта |
| `machineId` | `mac` | идентификатор машины в реестре (D4) |
| `roots` | `[os.homedir()]` | разрешённые корни; на маке это `/Users/max` (D6) |
| `worktreesBase` | `~/.local/state/taskflow-runs/worktrees` | база worktree ролей, как `worktreesBase()` на .110 |
| `keychainService` | `taskflow-host` | служба в Keychain, где лежит ключ |
| `keychainAccount` | `mac` | учётка в Keychain |
| `heartbeatMs` | `30000` | интервал пинга |
| `reconnectMinMs` / `reconnectMaxMs` | `1000` / `30000` | пауза переподключения с разбросом |
| `handshakeTimeoutMs` | `20000` | сколько ждать ответа на приветствие |
| `bashTimeoutMs` | `600000` | потолок времени команды — как в `builderXcode.ts` |
| `bashOutputLimitBytes` | `4194304` | потолок вывода — как в `builderXcode.ts` |
| `maxConcurrentOps` | `8` | сколько операций одновременно |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

Показать фактические значения (без ключа): `npm start -- --print-config`.

## Протокол

JSON-текст в одном кадре WebSocket. Версия — `protocolVersion: 1`. Направление
указано от имени того, кто шлёт.

### Хост → шлюз

```jsonc
// 1. приветствие с ключом, сразу после открытия сокета
{"type":"hello","protocolVersion":1,"key":"…","machineId":"mac","hostVersion":"0.1.0",
 "platform":"darwin","hostname":"mac-mini","pid":4711}

// 2. корни и версия — после welcome
{"type":"register","machineId":"mac","hostVersion":"0.1.0","platform":"darwin",
 "hostname":"mac-mini","roots":["/Users/max"],
 "operations":["bash","read","write","edit","grep","find","ls","git_worktree"]}

// 3. поток вывода операции; stream — "stdout" или "stderr"
{"type":"chunk","opId":"c-17","stream":"stdout","text":"Build succeeded\n"}

// 4. итог операции: либо ok с данными, либо ok:false с ошибкой
{"type":"result","opId":"c-17","ok":true,"data":{ /* что вернула операция */ }}
{"type":"result","opId":"c-17","ok":false,"error":{"code":"path_denied","message":"…"}}

// 5. пинг
{"type":"ping","at":1791975403337}
{"type":"pong","at":1791975403337}
```

### Шлюз → хост

```jsonc
{"type":"welcome","sessionId":"…","protocolVersion":1,"heartbeatMs":30000}
{"type":"registered","sessionId":"…","acceptedRoots":["/Users/max"],
 "acceptedOperations":["bash","read","write","edit","grep","find","ls","git_worktree"],
 "heartbeatMs":30000}

{"type":"call","opId":"c-17","op":"bash",
 "args":{"command":"xcodebuild …","cwd":"/Users/max/Проекты/TaskFlowNativeBuild"}}
{"type":"cancel","opId":"c-17","reason":"роль передумала"}

{"type":"reject","code":"unauthorized","message":"ключ не найден в реестре"}
{"type":"ping","at":1791975403337}
{"type":"pong","at":1791975403337}
```

### Правила, на которые стоит опереться

1. **`hello` — первое сообщение.** Неверный ключ → `reject` и закрытие, после
   которого хост переподключаться не пытается (тот же ключ получит тот же отказ).
2. **`register` идёт после `welcome`**, а не вместо него: шлюз сверяет ключ по
   `hello`, а `acceptedRoots` может сузить корни (D4). Пустой `acceptedRoots` —
   хост не считает себя готовым к работе.
3. **`acceptedOperations` необязателен.** Если поля нет или оно пустое — разрешены
   все операции хоста. Непустое — выключенные отклоняются с `operation_disabled`.
4. **`opId` — связка вызова с потоком и результатом.** Шлюз обязан возвращать его
   дословно.
5. **Вывод идёт только потоком `chunk`.** В `result.data` его нет: повторная
   отправка четырёх мегабайт, которые шлюз уже получил, смысла не имеет. Куски
   одного потока склеиваются на стороне хоста, порядок внутри потока сохраняется.
6. **`cancel` без `opId` результата не даёт** — отменяется ровно одна операция.
   Отменённая операция приходит как `result` с `error.code = "cancelled"`.
7. **Обрыв соединения** = офлайн машины. Хост переподключается сам с паузой
   `reconnectMinMs…reconnectMaxMs` и разбросом. Тишина в два `heartbeatMs` без
   `pong` считается мёртвым каналом: хост рвёт его сам.
8. **Коды ошибок**: `unauthorized`, `protocol_mismatch`, `unknown_operation`,
   `operation_disabled`, `too_many_ops`, `path_denied`, `bad_args`, `not_found`,
   `conflict`, `limit_exceeded`, `cancelled`, `timeout`, `internal`.

### Аргументы и результаты операций

| Операция | Аргументы | `data` при `ok:true` |
| --- | --- | --- |
| `bash` | `command`, `cwd?`, `timeoutMs?`, `shell?` | `{exitCode, signal, truncated, timedOut, durationMs, stdoutBytes, stderrBytes}` — **без вывода** |
| `read` | `path`, `offset?` (строка с 1), `limit?` (≤2000) | `{path, content, startLine, endLine, totalLines, truncated, bytes, eol}` |
| `write` | `path`, `content` | `{path, bytes, created, createdDirs}` |
| `edit` | `path`, `oldText`, `newText`, `replaceAll?` | `{path, occurrences, bytes}` |
| `grep` | `pattern` (регулярка), `path?`, `ignoreCase?`, `glob?`, `maxMatches?`, `skipDirs?` | `{matches:[{path,line,text}], truncated, filesScanned, unreadable}` |
| `find` | `pattern?`, `path?`, `type?` (`file`\|`dir`), `maxDepth?`, `limit?` | `{entries:[{path,type}], truncated, unreadable}` |
| `ls` | `path` | `{path, entries:[{name,path,type,size,mtimeMs}]}` |
| `git_worktree` | `action` (`create`\|`remove`), `repo`, `taskId`, `branch?` | `{action, repo, path, branch, changed}` |

`git_worktree` повторяет `roleWorkspace.ts` с `.110`: ветка `roles/<taskId>`,
база `worktreesBase`, уже заведённая копия переиспользуется. `taskId` —
только `[A-Za-z0-9._-]`, иначе отказ: из id карточки не должен получаться путь.

## Границы

- Всё выполняется **только внутри `roots`**; путь снаружи — явная ошибка
  `path_denied`, а не тихий отказ. Симлинк, уводящий наружу, — тоже отказ.
- Ключ — в Keychain. Запасной источник через `TASKFLOW_HOST_KEY` есть, но
  включается только флагом `TASKFLOW_HOST_ALLOW_ENV_KEY=1` и нужен для разработки.
- Сном мака не управляем (D8): недоступен — значит недоступен.

## Проверка

```bash
npm run typecheck   # tsc по src и test
npm run build       # сборка в dist/
npm test            # vitest: операции, пути, конфиг и полный цикл против фейкового шлюза
```