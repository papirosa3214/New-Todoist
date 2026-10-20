# Карта проектов и папок — проверенные факты (этап исследования)

Карточка: 8f4f9404-08b2-4358-81ae-32dc52520ce7 «Карта проектов и папок в библиотеке TaskFlow».
Шаг: research («Факты, источники и ограничения»), роль «Исследователь».
Данные сняты вживую 20.10.2026 на сервере .110 (192.168.1.110) под системным пользователем роли `tfrole`,
плюс один вызов на MacBook через хост-инструменты. Всё, что ниже помечено «проверено», — результат команды на машине;
всё, что помечено «гипотеза» или «не проверено», — догадка, которую нельзя выдавать за факт.

## 1. Источники (первичные, с датой)

| Источник | Путь | Дата | Что даёт |
|---|---|---|---|
| Карта хозяйства | `/home/maksim/README.md` (симлинк на `~/infra-ops/home-map.md`) | 05.10.2026 | Правило «новое — в `Проекты/<Имя>/`», список живых папок, план (не выполненный) переезда инфраструктуры |
| Пульт .110, живой API | `http://127.0.0.1:3007/api/services` (проект `infra-panel`) | 20.10.2026 | 124 записи сервисов: имя, тип, `config_file`, статус, порты, описание, здоровье |
| Реестр панели | `~/Проекты/infra-panel/backend/services-registry.json` | 14.10.2026 | 67 systemd-групп, 14 docker-групп, 105 описаний, 6 архивных сервисов |
| Юниты systemd | `/home/maksim/.config/systemd/user/` | 20.10.2026 | 99 файлов `.service`; порты из `ExecStart`/`Environment` |
| Docker | `docker ps` | 20.10.2026 | 32 контейнера с пробросом портов |
| Порты | `ss -tlnp` + 45 проб `curl` по `127.0.0.1` | 20.10.2026 | Что действительно отвечает |
| Живая БД TaskFlow | `~/Проекты/New-Todoist/server/taskflow.db` (только чтение) | 20.10.2026 | Папки библиотеки: корень `182`, разделы `183 Roles`/`184 Workflows`/`185 Norms`/`186 Knowledge Base`/`187 Projects`; папка карточки `402` |
| Реестр машин и проектов | `~/Проекты/New-Todoist/server/scripts/task-context-hosts.json` | 20.10.2026 | MacBook `c24ec665…`; единственный проект на маке — «TaskFlow Native iOS» (`2c7802f0…`) с путём `/Users/max/Проекты/TaskFlowNativeBuild` |
| Графы кода | `graft` 0.20.0, `/home/maksim/.npm-global/bin/graft`; папки `graft/` | 20.10.2026 | Граф есть у 6 проектов; `graft ask` отвечает по репозиторию TaskFlow |
| Назначения проектов | `README.md` / `package.json` каждого каталога | 20.10.2026 | Одна строка «что это» без догадок |

## 2. Проекты на .110 — что работает

| Проект | Назначение | Путь | Репозиторий | Где запущен | Граф | Документация |
|---|---|---|---|---|---|---|
| TaskFlow (New-Todoist) | Сервер и веб TaskFlow | `~/Проекты/New-Todoist` | git, `main` | веб `:5180` (HTTPS, vite dev), API `:3001` | `graft/` + 147 карточек concepts | `docs/` (147 файлов), `AGENTS.md`, `INDEX.md` |
| Инфра-панель (Пульт .110) | Сводка сервисов и состояние .110 | `~/Проекты/infra-panel` | git, `main` | `:3007` | `graft/` | `docs/`, `HANDOFF.md`, `AGENTS.md` |
| TaskFlow Web Desktop | Десктопный веб TaskFlow | `~/Проекты/TaskFlow-Web-Desktop` | git, `main` | отдельного порта нет | нет | `docs/` (9), `AGENTS.md` |
| iOS-клиент TaskFlow | Нативный клиент | **только на маке** `/Users/max/Проекты/TaskFlowNativeBuild` | git | на маке | `graft/` (в репозитории) | `docs/`, `AGENT-CYCLE.md` |
| CRM (CRM-Castom) | CRM: бэкенд и база | `~/Проекты/CRM/CRM-Castom` | git | бэкенд `:8101`, postgres `:5433` | `graft/` | `graft/`-карта |
| DeepTutor | Персональный ИИ-репетитор | `~/Проекты/DeepTutor` | git, compose | `:8001`, `:3782` | нет | `README.md` |
| open-notebook | Локальная альтернатива NotebookLM | `~/Проекты/open-notebook` | compose | docker-стек | нет | `README.md`, `docs/` (11) |
| Notebook-LM-clon | Клон NotebookLM | `~/Проекты/Notebook-LM-clon` | git, compose | `:8085` (отвечает 500) | нет | `README.md` |
| Penpot | Редактор макетов (исходники) | `~/Проекты/penpot` | git | живой стек — `~/penpot-deploy`, фронт `:9002`, почта `:1081` | нет | `README.md` |
| Monica | CRM личных отношений | `~/Проекты/monica` | git, compose | docker-стек | нет | `README.md` |
| BoardUI | Доска задач | `~/Проекты/boardui` | git, `main` | своего порта не видно | `graft/` | `graft/INDEX.md` |
| Graft | Инструмент графа кода | `~/Проекты/Graft` | git, `main` | CLI, `graft viz` `:4400` | `graft/` | `docs/`, `README.md` |
| theatre | Анимации интерфейса | `~/Проекты/theatre` | git, compose | своего порта не видно | `graft/` | `graft/`-карта |
| clawd-pets | Питомцы исполнителей на столе Мака | `~/Проекты/clawd-pets` | git | python-мост | нет | `README.md` |
| GeoPhotoMarks | Метки фото на картах (данные для Valhalla) | `~/Проекты/GeoPhotoMarks` | git | данных для Valhalla | нет | `README.md` |
| DesignTools | Инструменты дизайна | `~/Проекты/DesignTools` | без git | — | нет | `README.md` |
| magicui | Библиотека компонентов | `~/Проекты/magicui` | git | — | нет | `README.md` |
| BG-Landing-BO | Лендинг | `~/Проекты/BG-Landing-BO` | git | — | нет | `README.md` |
| stream-observer | Наблюдение за потоком | `~/Проекты/stream-observer` | без git | — | нет | `README.md` |
| workspace | Либое рабочее пространство с ИИ | `~/Проекты/workspace` | compose | — | нет | `README.md` |
| AI-Control-Center (+8 подпроектов) | Центр управления ИИ-контурами | `~/Проекты/AI-Control-Center*` | git только у корня | — | нет | `README.md` |
| taskflow-уведомления | Входящие уведомления TaskFlow | `~/Проекты/taskflow-уведомления` | без git | API уведомлений `:5198` (работает из `~/infra-ops`) | нет | `README.md` |

Инфраструктурные сервисы (старые, в корне домашней папки, как и предписано README): `ragflow-stack`, `n8n-stack`, `kb`,
`valhalla`, `rag-business-os`, `asr-service`, `gitea`, `selfhost` (AdGuard), `monitoring` (Prometheus/Grafana),
`penpot-deploy`, `ollama`, `service-monitor`, `infra-ops`, `obsidian-journal`, `bin`, `logs`, `backups`, `_archive`.
Новая папка `~/Проекты/Инфраструктура/` (28 ГБ) содержит: `cloudbeaver`, `comfy`, `gitea-runner`, `matt-pocock-skills`,
`OmniRoute`, `webdav-obsidian`, `webdav-venv`, `страж-моделей`. Плана «переехать сюда всё» не выполнено — это только план.

## 3. Мусор, копии и пустые папки — помечены, а не выданы за рабочие

| Папка | Что это на самом деле |
|---|---|
| `~/Проекты/Хранилище.backup-pre-switch-2026-10-03` | Полная копия «Хранилища» перед переключением 03.10.2026. Рабочая — `~/Проекты/Хранилище` |
| `~/Проекты/_archive`, `~/Проекты/Архив`, `~/_archive` | Архивы отработавшего; в `_archive` есть журналы перемещений |
| `~/Проекты/Заархивировано Фейл` | «Толк — личный задачник», помечено как заархивированное |
| `~/Проекты/BG-CRM` | Пустая папка от 15.08, git нет, README нет |
| `~/Проекты/monica-classic` | Пустая папка от 22.09 |
| `~/Проекты/CRM` (верхний уровень) | Не git-репозиторий; живой код — в `CRM/CRM-Castom` |
| `~/Проекты/DeepSeek Harnes`, `crm-agent-kb`, `codex-subscription-bridge`, `notebook-deploy`, `youtube-rus-server`, `Вэб дизайн и компоненты`, `penpot-assets` | Папки без README и без git; назначение не заявлено — в карте помечать «назначение не подтверждено» |
| `~/Проекты/AI-Control-Center-*` (8 подпапок) | Подпроекты одного центра, каждый с README «AI Control Center» |
| `~/Проекты/minimax-voice-proto` | Прототип голоса MiniMax для TaskFlow |

## 4. Служебные папки — «не трогать»

| Папка | Что лежит | Почему не трогать |
|---|---|---|
| `/home/maksim/taskflow/roles` | Промпты ролей (`researcher`, `builder`, `qa`…) | Роли читаются сервером; для пользователя роли каталог недоступен («Отказано в доступе») |
| `/home/maksim/.local/state/taskflow-runs` | Worktree'ы ролей, сессии, `data.db`, бэкапы | Рабочее состояние TaskFlow; удаление ломает ходы |
| `/home/maksim/Проекты/New-Todoist/server/taskflow.db` | Живая база TaskFlow | Данные приложения; правки только через сервер |
| `/home/maksim/kb` | База знаний, `.env` с секретами | Секреты; для пользователя роли `.env` не читается |
| `/home/maksim/Проекты/Хранилище` | Дайджесты, журнал, заметки, «Роли TaskFlow» (симлинки на роли) | Хранилище владельца |
| `/mnt/nas`, `/mnt/document` | Сетевые шары NAS `192.168.1.146` (19 ТБ) | Общее хранилище; в т.ч. бэкапы macOS-образов |
| `/home/maksim/logs`, `/home/maksim/bin` | Логи и скрипты обслуживания | Служебные |
| `/home/maksim/backups` | 14 архивов бэкапов | Архивы, не рабочие копии |
| `/home/maksim/ollama` | Модели локальных нейросетей | 27 ГБ, живёт своей жизнью |
| `~/Проекты/infra-panel/backend/.state/snapshots` | Снимки состояния панели | Диагностические |

## 5. Живые порты .110 (проверено `curl`)

| Порт | Что отвечает | Порт | Что отвечает |
|---|---|---|---|
| 5180 (HTTPS) | TaskFlow, веб (vite dev) | 3001 | TaskFlow, API |
| 3007 | Пульт .110 | 5198 | API уведомлений |
| 8801 / 8802 / 8803 | MCP: база знаний / TaskFlow / инфра-панель | 8799 | Поиск по базе знаний |
| 11434 | Ollama | 8123 | Стенд MiniMax |
| 3008 / 2222 | Gitea: веб / ssh | 5678 | n8n |
| 8080 / 9380 | RAGFlow: веб / API | 9000 / 9001 | MinIO |
| 6379 / 3306 | Redis / MySQL (RAGFlow) | 5433 | PostgreSQL CRM |
| 8002 | Valhalla | 9002 / 1081 | Penpot: фронт / почта |
| 3002 | Uptime Kuma | 3012 | AdGuard |
| 8090 | PocketBase | 8099 / 8100 | Релеи Telegram → n8n |
| 8001 / 3782 | DeepTutor | 8107 | Mnemosyne (SSE) |
| 4400 | graft viz | 1235 | Распознавание речи |
| 5199 | Мост к pi-агенту | 5900 | Форпост (VNC) |
| 9090 | Раздача «DropBox AI» | 8788 | Прокси шаблонов n8n |
| 1200 | Elasticsearch (RAGFlow) | 8085 | Notebook-LM-clon (отвечает 500) |

## 6. MacBook: что удалось и что не удалось

- **Удалось:** репозиторий iOS-клиента `/Users/max/Проекты/TaskFlowNativeBuild` (git, `docs/`, `graft/`,
  `AGENT-CYCLE.md`, `AGENT-WORK-SCOPES.md`) и его worktree роли; MacBook онлайн, `taskflow_hosts` его видит.
- **Не удалось:** перечислить `/Users/max/Проекты` — процесс агента получает `Operation not permitted` (защита macOS).
  То есть полный перечень маковских проектов снять нельзя: известен только проект, зарегистрированный в
  `task-context-hosts.json`.
- **Правило владельца (заметка 15.10.2026):** исходник iOS только на маке, копий на .110 не держать, код переносится
  только через git, прямой ssh с .110 на мак ролям запрещён.

## 7. Противоречия источников — выдавать за факт нельзя

1. **README против диска.** README (05.10.2026) описывает переезд инфраструктуры в `Проекты/Инфраструктура` как
   отложенный план. На диске `ragflow-stack`, `n8n-stack`, `kb`, `valhalla`, `rag-business-os` всё ещё в корне домашней
   папки. В карте писать «инфраструктура переехала» — неверно.
2. **Реестр панели устарел.** В `services-registry.json` остались пути, которых на машине нет: `~/infra-panel/`,
   `~/backend/docker-compose.yml`, `~/homeassistant/`, `~/pi-bot/`, `~/voice-clone/`, `~/tg-control-bridge/`,
   `~/n8n/docker-compose.yml`, `~/penpot/docker-compose.yml`. Пульт показывает 57 сервисов в статусе `stopped` —
   часть из них таймеры и одноразовые задания, а не сломанное.
3. **Пульт не знает про TaskFlow.** В реестре нет веба `:5180`, API `:3001` и трёх MCP-мостов `:8801–8803`.
   Утверждение «панель контролирует все сервисы сервера» неверно.
4. **Пустые дубли в библиотеке.** В БД есть проекты «TaskFlow Web Desktop» (папка 379) и «Учёт личных финансов»
   (340) рядом с «TaskFlow - NewTodoist» (191) и «TaskFlow Native iOS» (193). Они не пустые (в 379 — 15 заметок),
   но выглядят как дубли; удаление — вне границ карточки.
5. **Графы не у всех.** `graft/` есть у 6 проектов из ~20; отсутствие графа — не признак мусора.

## 8. Пробелы — что не проверено и что должен закрыть следующий этап

1. Полный список маковских проектов не снят (запрет macOS на чтение домашней папки). Нужен либо список из реестра
   машин, либо решение владельца: расширять ли карту на мак.
2. Назначение 8 папок без README (`DeepSeek Harnes`, `crm-agent-kb`, `codex-subscription-bridge`, `notebook-deploy`,
   `youtube-rus-server`, `Вэб дизайн и компоненты`, `penpot-assets`, `monica-classic`, `BG-CRM`) не подтверждено —
   в карте помечать как «не подтверждено», а не додумывать.
3. Статус сервисов «stopped» в пульте не разобран по существу: таймер это или упавший сервис.
4. Не проверено, какие из 32 docker-контейнеров относятся к какому каталогу по compose-файлу (сопоставление сделано
   по именам и портам).
5. Не проверены содержимое и актуальность заметок в «Хранилище» как документации проектов.
6. В библиотеке нет раздела с картой; заметка должна лежать в `Knowledge Base` (папка 186) — это единственный раздел,
   который ищет `taskflow_kb_search` по общим запросам.

## 9. Готовый черновик для заметки «Карта проектов и папок» (следующий участник)

- **Куда положить:** одна заметка с названием ровно «Карта проектов и папок» в раздел `Knowledge Base`
  (папка 186 библиотеки, `taskflow_doc_write` с `library_subfolder="Knowledge Base"`).
- **Структура заметки:** таблица «проект → назначение одной строкой → путь → машина → репозиторий → сервис и порт →
  есть ли граф → где документация»; отдельным разделом — служебные папки «не трогать»; отдельным разделом —
  мусор, копии и папки с неподтверждённым назначением; короткий блок «проверено 20.10.2026, источники: …».
- **Не включать в заметку:** пути, которых нет на машине (старый реестр), и утверждение о выполненном переезде инфраструктуры.
- **Как проверить критерий приёмки:** `taskflow_kb_search` по запросам «где код состояния системы»,
  «где iOS-клиент», «какой порт у веба TaskFlow» должен выдавать эту заметку первой.
  Сейчас (до публикации) эти запросы возвращают заметки по дизайн-системе iOS — то есть нужной карты в базе нет.
- **Что должно стоять в заметке про iOS:** единственный источник — `/Users/max/Проекты/TaskFlowNativeBuild` на MacBook;
  копий на .110 нет и держать их не нужно.

## 10. Как перепроверить самому (команды, все на .110)

```bash
ls -la /home/maksim/Проекты                     # каталоги проектов
find /home/maksim/Проекты -maxdepth 3 -name .git -type d   # где репозитории
find /home/maksim/Проекты -maxdepth 3 -name graft -type d  # где графы кода
curl -s http://127.0.0.1:3007/api/services | head -c 2000     # живой пульт .110
ls /home/maksim/.config/systemd/user/*.service | wc -l        # юниты
docker ps --format '{{.Names}}\t{{.Ports}}'                  # контейнеры и порты
```

## 11. Ограничения этапа

- Ничего не менялось и не удалялось: только чтение файлов, HTTP-запросы к локальным сервисам и один вызов на маке.
- Перечень маковских проектов неполон — мак закрывает домашнюю папку от процесса агента.
- Часть сведений о сервисах взята из реестра панели: он обновлён 14.10.2026 и местами устарел (п. 7).
- Локальная модель (Ollama, `qwen3.6-27b-iq4-16k`) использована для черновика сводки; её утверждения о «пустых дублях
  проектов» в базе и о «домашнем каталоге» не подтвердились первоисточником и в текст не попали.

## 12. Дополнения (снято после первой выдачи, 20.10.2026)

**Адреса репозиториев** (`git remote -v` в рабочих копиях):

| Проект | Адрес | Ветка |
|---|---|---|
| `New-Todoist` (TaskFlow) | `github.com/papirosa3214/New-Todoist` | `main` |
| `infra-panel` | `github.com/papirosa3214/infra-panel` | `main` |
| `CRM/CRM-Castom` | `github.com/papirosa3214/CRM-Castom` | `feat/task-calendar-event-ui` (не `main`) |
| `BG-Landing-BO` | `github.com/papirosa3214/BG-Landing-BO` | `master` |
| `clawd-pets`, `GeoPhotoMarks`, `AI-Control-Center` | свой Gitea на сервере: `192.168.1.110:2222/maksim/<имя>` | `master`, `master`, `feat/cordis-core` |
| `boardui`, `theatre`, `Graft`, `monica`, `magicui`, `DeepTutor`, `penpot` | внешние проекты: `BoardUI/boardui`, `theatre-js/theatre`, `trailhq/Graft`, `monicahq/monica`, `magicuidesign/magicui`, `HKUDS/DeepTutor`, `penpot/penpot` | `main`×5, `main`, `develop` (penpot) |
| `Notebook-LM-clon` | свой Git-сервер `git.mizernyukmy.netcraze.pro/maksim/Notebook-LM-clon` | `main` |
| `TaskFlow-Web-Desktop`, `open-notebook` | удалённого репозитория нет | `main` / нет |

**Уточнения к разделу 2:**

- `codex-subscription-bridge` — живой сервис на **8096** (юнит `codex-bridge.service`), а не пустая папка.
- `monica` и `open-notebook` — compose-файлы есть, контейнеров в `docker ps` нет: стек не запущен.
- `Notebook-LM-clon` — на **8085** отвечает процесс хоста и отдаёт 500.
- Живые compose-проекты: `penpot-deploy` (7), `monitoring` (6), RAGFlow-стек `docker` (5), `n8n-stack` (4),
  `deeptutor` (3), `valhalla`, `selfhost`, `rag-business-os`, `gitea`, `gitea-runner`, CRM (`bgcrm-postgres`).

**TaskFlow-сервисы на .110 — юниты пользовательские:** `~/.config/systemd/user/taskflow-web.service`
(vite, 5180, лог `~/Проекты/New-Todoist/dev-vite.log`) и `taskflow-server.service`
(`tsx watch src/index.ts` в папке `server/`, API 3001, лог `server/dev-server.log` — **1,4 ГБ**).
Системных юнитов TaskFlow в `/etc/systemd/system/` нет.

**Сверка с прежним решением** — заметка «TaskFlow — единая картина на 09.09.2026» (`e7f92743-c04b-4f2c-bd82-0051dceb7244`):
порты совпали (5180, 3001), но адрес репозитория там указан `maksim/taskflow-server`, а на живой машине remote —
`github.com/papirosa3214/New-Todoist`; там же юнит на `.110` назван системным, фактически он пользовательский.
Действующее правило по iOS — заметка владельца от 14.10.2026 (`7fec00c4-f739-4ce1-9635-7a38910cbd52`).

**Опубликованная карта:** заметка «Карта проектов и папок», `f1dd193f-9ebf-4ecc-926c-04988bcc58c6`,
раздел `Knowledge Base` (папка 186). Помещена туда переносом `folder_id` прямо в БД с горячим бэкапом
(`/tmp/taskflow-backup-before-map-note-20261020.db`): инструмент `taskflow_doc_write` внутри задачи всегда кладёт
заметку в папку карточки (в коде: `if (taskId) folderId = ensureTaskArtifactFolder(taskId)`), параметр
`library_subfolder` при этом игнорируется.
