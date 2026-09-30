import { startSecretaryVoiceBridge } from "./runtime/secretaryVoiceBridge.js";
import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import { setRoleTokenSigner } from "./runtime/roleRunAccess.js";
import { setInProcessApp } from "./runtime/inProcessRun.js";
import { startRoleRunWorker } from "./runtime/roleRunWorker.js";
import { finishCompletedPlans, recoverInterruptedPlanSubtasks } from "./runtime/planSubtaskAdmission.js";
import { startKnowledgeSyncSchedule } from "./lib/knowledgeSync.js";
import { startScheduler } from "./runtime/scheduler.js";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import { ensureJwtSecret } from "./env.js";
import db, { migrate, DB_PATH } from "./db.js";
import { runMigrations } from "./migrations.js";
import { resolveUserIdFromToken, authOrApiToken } from "./auth.js";
import { addClient, removeClient, resetAllOffline } from "./ws.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerAgentStateRoutes } from "./routes/agent-state.js";
import { registerManualRunRoutes } from "./routes/manual-run.js";
import { registerRetryRoutes } from "./routes/retry.js";
import { registerConsultationRoutes } from "./routes/consultation.js";
import { registerEmbeddingsRoutes } from "./routes/embeddings.js";
import { registerEnrichSemanticRoutes } from "./routes/enrichSemantic.js";
import { registerProjectLabelRoutes } from "./routes/projects.js";
import { registerSubtaskCommentRoutes } from "./routes/subtasks.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerReleaseRoutes } from "./routes/release.js";
import { registerLiveActivityRoutes } from "./routes/live-activity.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerAvatarRoutes } from "./routes/avatars.js";
import { registerAgentDetailsRoutes } from "./routes/agent-details.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerStructureRoutes } from "./routes/structure.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerChatsRoutes } from "./routes/chats.js";
import { registerTranscribeRoutes } from "./routes/transcribe.js";
import { registerCompassRoutes } from "./routes/compass.js";
import { registerDictationArchiveRoutes } from "./routes/dictation-archive.js";
import { registerAgentServiceRoutes } from "./routes/agent-service.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerJournalFolderRoutes } from "./routes/journalFolders.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerTaskOutcomeRoutes } from "./routes/taskOutcome.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerAgentInboxRoutes } from "./routes/agent-inbox.js";
import {
  registerActivityRoutes,
  startActivityObserver,
} from "./routes/activity.js";
import { startInboxTriageWatcher } from "./lib/inboxTriageWatcher.js";
import { startInboxResultsWriter } from "./lib/inboxResultsWriter.js";
import { registerSeedRoutes } from "./seed.js";
import { registerEnrichmentRoutes } from "./routes/enrichment.js";
import { registerDispatchRoutes } from "./routes/dispatch.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerRoleRoutes } from "./routes/roles.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { registerTaskIntakeRoutes } from "./routes/task-intake.js";
import { registerSecretaryVoiceRoutes } from "./routes/secretary-voice.js";
import { registerMcpManifestRoutes } from "./routes/mcp-manifest.js";
import { registerRoleRunJobRoutes } from "./routes/role-run-jobs.js";
import { registerTaskCollaborationPlanRoutes } from "./routes/task-collaboration-plans.js";
import { registerSubtaskArtifactRoutes } from "./routes/subtask-artifacts.js";
import { registerRuntimeContextRoutes } from "./routes/runtime-context.js";

/**
 * Собирает и возвращает готовый Fastify-инстанс — регистрирует плагины,
 * прогоняет миграции, вешает маршруты — но НЕ слушает порт. Вынесено из
 * старого монолитного top-level скрипта (до 15.08.2026 всё это плюс
 * app.listen() шло одним куском при импорте index.ts), чтобы тесты могли
 * получить работающее приложение через app.inject() (Fastify, без реального
 * порта и без вмешательства в живой процесс на :3001) — раньше это было
 * невозможно в принципе, импорт index.ts сразу поднимал настоящий сервер.
 * Реальный запуск (низ файла) — тонкий вызов buildApp().then(listen).
 */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Номер запроса: присланный клиентом X-Request-ID, если это короткая
 *  строка из безопасных символов (он попадает в лог и в заголовок ответа),
 *  иначе свой — `srv-<время>-<случайное>`. */
export function requestIdFor(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers["x-request-id"];
  const incoming = typeof raw === "string" ? raw.trim() : "";
  if (REQUEST_ID_RE.test(incoming)) return incoming;
  return `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Первые 2 КБ тела ответа для лога, с затёртыми ключами. */
export function errorBodyPreview(payload: unknown): string | undefined {
  let text: string | undefined;
  if (typeof payload === "string") text = payload;
  else if (Buffer.isBuffer(payload)) text = payload.subarray(0, 2048).toString("utf8");
  else if (payload && typeof payload === "object" && !("pipe" in (payload as object))) {
    try { text = JSON.stringify(payload); } catch { text = undefined; }
  }
  if (!text) return undefined;
  return text
    .slice(0, 2048)
    .replace(/("(?:token|api_token|access_token|refresh_token|password|secret|api_key)"\s*:\s*")[^"]*"/gi, '$1•••"')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1•••");
}

export async function buildApp(): Promise<FastifyInstance> {
  // До всего остального — секрет подписи JWT должен быть в process.env
  // раньше, чем fastifyJwt.register() ниже его прочитает (см. env.ts).
  ensureJwtSecret();

  // bodyLimit по умолчанию у Fastify — 1 МБ, мало для аудиозаписи диктовки
  // (кнопка микрофона, routes/transcribe.ts). Поднимаем до потолка самого
  // ASR-сервиса (25 МБ, см. local-asr-service.md) — выше смысла нет, он всё
  // равно откажет.
  // Секреты в лог не пишем. `/ws?token=...` — вынужденная форма: WebSocket из
  // браузера не умеет слать заголовок Authorization, и токен приходит строкой
  // запроса. Сам протокол это не меняет — режется только то, что попадает в
  // лог (08.09.2026: в dev-server.log лежало 2637 строк с живыми токенами).
  const SENSITIVE_QUERY_KEYS = ["token", "access_token", "api_key", "secret", "password"];

  const redactSensitiveQuery = (url: string): string => {
    const cut = url.indexOf("?");
    if (cut === -1) return url;
    const params = new URLSearchParams(url.slice(cut + 1));
    let touched = false;
    for (const key of SENSITIVE_QUERY_KEYS) {
      if (params.has(key)) {
        params.set(key, "***");
        touched = true;
      }
    }
    return touched ? url.slice(0, cut) + "?" + params.toString() : url;
  };

  const app = Fastify({
    logger: {
      // Заголовки с секретами не пишем вовсе: они не нужны для разбора
      // запроса, а утекают так же легко, как строка запроса.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-taskflow-token']",
        ],
        remove: true,
      },
      serializers: {
        req(request: any) {
          return {
            method: request.method,
            url: redactSensitiveQuery(request.url || ""),
            host: request.headers?.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
            // Корреляционный id: берём из заголовка X-Request-ID (если его
            // шлёт клиент), иначе генерим свой. Пробрасываем в response
            // через onSend-хук ниже — iOS-лог и серверный лог связываются
            // одним id, что сильно упрощает разбор «клиент упал, сервер
            // видит 200 — почему?». Это диагностическая инфраструктура
            // 27.09.2026: iPhone показывал «нет задач», а в логе сервера
            // всё было 200 — нужно было одной строкой связать обе стороны.
            requestId: request.id,
          };
        },
      },
    },
    // Номер запроса (27.09.2026): клиентский X-Request-ID, если он похож на
    // номер, иначе свой. Раньше эта функция лежала внутри logger — там
    // Fastify её не читает, и номера были стандартные req-1, req-2…
    genReqId: requestIdFor,
    bodyLimit: 25 * 1024 * 1024,
  });

  // Пробрасываем request-id обратно клиенту в response-header, чтобы
  // iPhone мог его залогировать и сопоставить со своим логом.
  // Ответ с ошибкой (4xx/5xx) — отдельной строкой в лог с началом тела:
  // по номеру запроса из лога телефона сразу видно, что именно сервер ему
  // ответил. Штатный лог Fastify тело не пишет (раньше пытались через
  // reply._body в сериализаторе — такого поля нет, тело не писалось).
  app.addHook("onSend", async (req, reply, payload) => {
    const id = (req as any).id;
    if (id && typeof reply.getHeader === "function") {
      reply.header("X-Request-ID", id);
    }
    if (reply.statusCode >= 400) {
      // reqId в строку добавляет сам логгер запроса.
      const entry = {
        method: req.method,
        url: redactSensitiveQuery(req.url || ""),
        statusCode: reply.statusCode,
        body: errorBodyPreview(payload),
      };
      if (reply.statusCode >= 500) req.log.error(entry, "ответ с ошибкой");
      else req.log.warn(entry, "ответ с ошибкой");
    }
    return payload;
  });

  // Сырые байты audio/* (запись из MediaRecorder на фронтенде) — не JSON,
  // парсим как Buffer и отдаём как есть в req.body. Без этого Fastify упадёт
  // с FST_ERR_CTP_INVALID_MEDIA_TYPE на любом Content-Type, для которого нет
  // зарегистрированного парсера.
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Вложения комментариев приходят тем же способом — сырыми байтами
  // (routes/attachments.ts). Типы перечислены поимённо, БЕЗ маски вида
  // `application/*`: под неё попал бы и application/json, парсер тела
  // перехватил бы его у Fastify, и весь остальной API перестал бы понимать
  // обычные запросы. Окончательное «такое не принимаем» решает сам маршрут —
  // он отвечает понятным текстом вместо сырого FST_ERR_CTP_INVALID_MEDIA_TYPE.
  const ATTACHMENT_CONTENT_TYPES = [
    /^image\//,
    // Любой текст: раньше перечисляли text/plain и text/markdown поимённо, и
    // .py/.sh/.js отлетали с сырым 415 ЕЩЁ ДО маршрута — разборщика тела на
    // их тип не было, и понятный ответ маршрута не успевал сработать (владелец
    // 20.09.2026: «хочу приложить питоновский скрипт»). Список разрешённого
    // для самого вложения — в routes/attachments.ts.
    /^text\//,
    "application/pdf",
    "application/octet-stream",
    "application/msword",
    /^application\/vnd\.openxmlformats-officedocument\./,
    /^application\/vnd\.oasis\.opendocument\./,
    // Кодовые/конфиговые типы, которые система отдаёт НЕ как text/*.
    // ВАЖНО: без application/json — на нём держится весь остальной API, и
    // перехватив его разборщиком буфера, мы сломали бы все JSON-запросы.
    /^application\/(xml|yaml|x-yaml|javascript|x-javascript|x-sh|x-shellscript|x-python|x-ruby|x-perl|x-httpd-php|sql|graphql|toml|x-ndjson)$/,
  ];
  // У Fastify два разборщика тела ИЗ КОРОБКИ: application/json и text/plain.
  // Встроенный text/plain отдаёт тело СТРОКОЙ, и он выигрывает у нашего
  // регулярного /^text\/plain/ — то есть любой .txt приезжал в маршрут не
  // буфером, и проверка Buffer.isBuffer отвергала его как «пустой файл».
  // Ошибка тихая: понятного текста про тип не было, файл просто не грузился.
  //
  // Заметно это стало 28.08.2026 на вложениях чата, но касается ВСЕГО
  // приложения — вложения задач ломались ровно так же. Правка от 26.08 про
  // markdown сработала только потому, что у text/markdown встроенного
  // разборщика нет.
  //
  // Снимаем встроенный перед регистрацией своих: обычный текст нам нужен
  // сырыми байтами, как и остальные вложения. JSON не трогаем — на нём
  // держится весь остальной API.
  app.removeContentTypeParser("text/plain");

  for (const type of ATTACHMENT_CONTENT_TYPES) {
    app.addContentTypeParser(
      type as any,
      { parseAs: "buffer" },
      (_req: any, body: any, done: any) => done(null, body),
    );
  }

  // Plugins
  // CORS: Явный список разрешённых источников вместо origin:true.
  // origin:true разрешает ВСЕ источники (что небезопасно, особенно с credentials:true).
  // Вместо этого: vite dev-сервер (localhost:5180 и 127.0.0.1:5180),
  // capacitor://localhost для мобильной обёртки, плюс доп. источники из переменной окружения.
  // Запросы БЕЗ заголовка Origin (curl, серверные вызовы, агенты по api_token)
  // продолжают работать — CORS не применяется к ним.
  const allowedOrigins = [
    "http://localhost:5180",
    "http://127.0.0.1:5180",
    "capacitor://localhost",
  ];
  const extraOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : [];
  const allOrigins = [...allowedOrigins, ...extraOrigins];

  await app.register(cors, {
    origin: allOrigins,
    credentials: true,
    // PUT здесь обязателен: сохранение записи Дневника идёт через
    // PUT /api/journal/:date, и без него браузер рубит запрос на
    // preflight — в UI это выглядит как вечное «Не удалось сохранить»
    // (Максим 26.08.2026), причём в логах сервера виден только OPTIONS,
    // а самого PUT нет вовсе. Список методов должен покрывать ВСЕ
    // глаголы, которые реально использует клиент (api/client.ts).
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  // ensureJwtSecret() выше гарантирует, что JWT_SECRET уже в process.env —
  // без литерала-запасного варианта: он либо пришёл снаружи, либо сгенерирован
  // и сохранён в server/.env при первом старте.
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET as string,
  });
  // Пропуск роли на время запуска агента подписывается тем же механизмом,
  // что вход в веб (runtime/roleRunAccess.ts).
  setRoleTokenSigner((payload, options) => app.jwt.sign(payload, options));
  // Агент роли внутри сервера ходит по маршрутам внутренним вызовом
  // (runtime/inProcessRun.ts) — без ключей, как профили у Гермеса.
  setInProcessApp(app);
  await app.register(fastifyWebsocket);
  // global: false — лимит НЕ применяется автоматически ко всем маршрутам.
  // Агенты и служба-будильник (taskflow-trigger) бьют по /api/tasks и
  // heartbeat раз в 90 секунд под одним и тем же LAN/localhost IP — общий
  // лимит по IP превратился бы в самопроизвольную блокировку рабочего
  // трафика. Ограничение включается точечно, через config.rateLimit на
  // конкретном маршруте (пока — только /api/auth/login и /register,
  // routes/auth.ts), где оно и нужно: подбор пароля идёт только туда.
  await app.register(fastifyRateLimit, { global: false });

  // DB
  migrate();
  // Версионные миграции поверх — новые изменения схемы идут сюда, не в
  // migrate() (см. migrations.ts).
  runMigrations();

  // Routes
  registerAuthRoutes(app);
  registerTaskRoutes(app);
  registerAgentStateRoutes(app);
  await registerManualRunRoutes(app);
  registerRetryRoutes(app);
  registerConsultationRoutes(app);
  registerEmbeddingsRoutes(app);
  registerEnrichSemanticRoutes(app);
  registerEnrichmentRoutes(app);
  registerDispatchRoutes(app);
  await registerReviewRoutes(app);
  registerRoleRoutes(app);
  registerRuntimeRoutes(app);
  registerRoleRunJobRoutes(app);
  registerTaskCollaborationPlanRoutes(app);
  registerTaskIntakeRoutes(app);
  registerSecretaryVoiceRoutes(app);
  registerMcpManifestRoutes(app);
  registerProjectLabelRoutes(app);
  registerCompassRoutes(app);
  registerSubtaskCommentRoutes(app);
  registerSubtaskArtifactRoutes(app);
  registerRuntimeContextRoutes(app);
  registerNotificationRoutes(app);
  registerLiveActivityRoutes(app);
  registerSearchRoutes(app);
  registerAttachmentRoutes(app);
  registerAvatarRoutes(app);
  registerAgentDetailsRoutes(app);
  registerAiRoutes(app);
  registerStructureRoutes(app);
  registerReportRoutes(app);
  registerResearchRoutes(app);
  registerChatsRoutes(app);
  registerTranscribeRoutes(app);
  // Архив диктовок (18.08.2026): аудио выгружается с телефона и хранится
  // бессрочно — прямое решение владельца.
  registerDictationArchiveRoutes(app);
  registerAgentServiceRoutes(app);
  registerReleaseRoutes(app);
  registerIntegrationRoutes(app);
  registerJournalFolderRoutes(app);
  registerKnowledgeRoutes(app);
  registerTaskOutcomeRoutes(app);
  registerNoteRoutes(app);
  registerChatRoutes(app);
  await registerAgentInboxRoutes(app);
  registerActivityRoutes(app);
  // Тикет ollama-observer: слой 3 живой строки — необязательное улучшение
  // поверх уже рабочих слоёв 1-2, включается/выключается на лету через
  // ACTIVITY_OBSERVER_ENABLED (см. комментарий в activity.ts).
  startActivityObserver();
  // Inbox-triage watcher: при появлении ticket'а в ~/Проекты/taskflow-уведомления/
  // inbox/*/_diagnostic/*.json создаёт карточку на диагностику прямо в БД.
  // Никаких внешних HTTP/Hermes/timer'ов — всё внутри процесса сервера
  // (правило Maksim 27.09.2026). Выключается через INBOX_TRIAGE_DISABLED=1.
  if (process.env.INBOX_TRIAGE_DISABLED !== "1") {
    startInboxTriageWatcher();
  }
  // Результаты: при закрытии карточки на диагностику/устранение дописывает
  // блок в файл уведомления (Phase 4, правило Maksim 27.09.2026 — внутри
  // TaskFlow, не внешний cron).
  startInboxResultsWriter();
  registerSeedRoutes(app);

  // Health
  app.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

  // Состояние сервера — для раздела «Сервер» в настройках приложения.
  //
  // Владелец 21.08.2026: «выведи в настройках информацию о статусе сервера».
  // Повод: сервер поднимается вручную и после перезапуска сам не встал —
  // понять это можно было только из терминала, а в приложении просто
  // «ничего не грузится». Владелец сидит с телефона, терминала у него нет.
  //
  // Отдаём то, по чему видно живость и свежесть, а не диагностический дамп:
  // сколько работает, на каком коде, велика ли база, идёт ли будильник.
  app.get("/api/server-status", { preHandler: authOrApiToken }, async () => {
    const uptime = Math.round(process.uptime());
    let commit: string | null = null;
    let commitAt: string | null = null;
    try {
      const root = path.resolve(import.meta.dirname, "../..");
      commit = execFileSync(
        "git",
        ["-C", root, "rev-parse", "--short", "HEAD"],
        {
          encoding: "utf8",
          timeout: 3000,
        },
      ).trim();
      commitAt = execFileSync(
        "git",
        ["-C", root, "log", "-1", "--format=%cI"],
        { encoding: "utf8", timeout: 3000 },
      ).trim();
    } catch {
      // Не в репозитории или git недоступен — не повод ронять весь ответ:
      // остальные строки полезны сами по себе.
    }

    const counts = db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'active') AS active," +
          " (SELECT COUNT(*) FROM tasks) AS total",
      )
      .get() as { active: number; total: number };

    let dbBytes: number | null = null;
    try {
      dbBytes = fs.statSync(DB_PATH).size;
    } catch {
      dbBytes = null;
    }

    // Будильник — отдельная служба (taskflow-trigger.service): это она
    // зовёт агентов в работу, и её молчание выглядит как «доска мёртвая».
    let trigger: string | null = null;
    try {
      trigger = execFileSync(
        "systemctl",
        ["--user", "is-active", "taskflow-trigger.service"],
        { encoding: "utf8", timeout: 3000 },
      ).trim();
    } catch (e: any) {
      // is-active возвращает ненулевой код, когда служба не работает, —
      // это ответ, а не ошибка.
      trigger = (e?.stdout || "").toString().trim() || "unknown";
    }

    // Проверка доступности локальной LLM (Ollama)
    let ollamaOnline = false;
    const ollamaBaseUrl = (
      process.env.OLLAMA_BASE_URL || "http://192.168.1.110:11434"
    ).replace(/\/+$/, "");
    const ollamaModel =
      process.env.OLLAMA_MODEL || "qwen3.6-27b-iq4-16k:latest";
    try {
      const ollamaRes = await fetch(`${ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      ollamaOnline = ollamaRes.ok;
    } catch {
      ollamaOnline = false;
    }

    return {
      ok: true,
      started_at: new Date(Date.now() - uptime * 1000).toISOString(),
      uptime_sec: uptime,
      node: process.version,
      commit,
      commit_at: commitAt,
      tasks_active: counts.active,
      tasks_total: counts.total,
      db_bytes: dbBytes,
      trigger,
      ollama_online: ollamaOnline,
      ollama_model: ollamaModel,
      server_ip: "192.168.1.110",
    };
  });

  // WebSocket for real-time. Auth via ?token=<jwt-or-api_token> — same token
  // accepted by the HTTP routes. The userId is derived from the token on the
  // server, never taken from the client-supplied query string, so a client
  // cannot subscribe to another user's event stream.
  app.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (socket, req) => {
      const token = (req.query as any)?.token;
      const userId = resolveUserIdFromToken(app, token);
      if (!userId) {
        socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        socket.close();
        return;
      }

      addClient(userId, socket as any);
      socket.on("close", () => removeClient(userId, socket as any));
      socket.on("message", (msg: Buffer) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === "ping")
            socket.send(JSON.stringify({ type: "pong" }));
        } catch {}
      });
      socket.send(JSON.stringify({ type: "connected" }));
    });
  });

  return app;
}

// Настоящий запуск — только когда этот файл выполняется как точка входа
// (`tsx src/index.ts` / `node dist/index.js`), не когда его импортирует
// тест. import.meta.url — свой путь модуля; process.argv[1] — то, что
// реально запущено.
//
// pathToFileURL(), не `file://${process.argv[1]}` — живая ошибка 15.08.2026:
// путь этого репозитория лежит под кириллической папкой (`~/Проекты/…`),
// import.meta.url её процент-кодирует (%D0%9F%D1%80…), а голая склейка
// строки — нет. Сравнение с такой склейкой никогда не совпадало, isMain
// был всегда false, сервер молча не слушал порт и просто завершался —
// без единой ошибки, просто «нечего больше делать». pathToFileURL()
// кодирует так же, как это делает сам import.meta.url, поэтому сравнение
// корректно на любом пути, кириллица там или нет.
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const PORT = Number(process.env.PORT) || 3001;
  const HOST = process.env.HOST || "0.0.0.0";

  buildApp().then(async (app) => {
    let stopRoleRuns: (() => Promise<void>) | null = null;
    let stopVoiceBridge: (() => Promise<void>) | null = null;
    let stopKnowledgeSync: (() => void) | null = null;
    let stopScheduler: (() => void) | null = null;
    app.addHook("onClose", async () => {
      stopKnowledgeSync?.();
      stopScheduler?.();
      if (stopRoleRuns) await stopRoleRuns();
      if (stopVoiceBridge) await stopVoiceBridge();
    });

    const addr = await app.listen({ port: PORT, host: HOST });
    // Сокетов после рестарта нет ни у кого — значит и «online» в базе быть
    // не может: иначе статус, оставшийся с прошлого запуска, врал бы до
    // первого подключения того же пользователя.
    resetAllOffline();
    // Durable worker стартует только в реальном process после listen.
    // buildApp() в unit tests остаётся полностью детерминированным.
    stopRoleRuns = startRoleRunWorker();
    // Документация проектов → база знаний раз в сутки (lib/knowledgeSync.ts).
    stopKnowledgeSync = startKnowledgeSyncSchedule();
    // Планировщик доски раз в 5 минут — внутри сервера (runtime/scheduler.ts).
    stopScheduler = startScheduler(app);
    // Ходы ролей живут в процессе: узлы плана, брошенные прошлым процессом,
    // — в ленту и продолжить (runtime/planSubtaskAdmission.ts).
    try {
      const finished = finishCompletedPlans();
      if (finished) console.log(`[plan] сданные планы отправлены на проверку: ${finished}`);
    } catch (error) {
      console.error("[plan] сдача завершённых планов не удалась:", error);
    }
    void recoverInterruptedPlanSubtasks()
      .then(({ resumed, blocked }) => {
        if (resumed || blocked) console.log(`[plan] после рестарта: продолжено ${resumed}, остановлено ${blocked}`);
      })
      .catch((error) => console.error("[plan] восстановление брошенных узлов не удалось:", error));
    stopVoiceBridge = await startSecretaryVoiceBridge(app);
    console.log(`🚀 TaskFlow API running at ${addr}`);
  });
}
