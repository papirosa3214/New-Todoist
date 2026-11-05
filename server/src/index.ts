import { startChatMemoryObserver } from "./runtime/chatMemoryObserver.js";
import {registerChatSessionPreferenceRoutes} from "./routes/chat-session-preferences.js";
import {startBudgetCaptureWatcher} from "./runtime/chatBudgetCases.js";
import { serverListenOptions } from "./runtime/systemdSocket.js";
import {startToolRequestWatcher} from "./runtime/toolRequestStore.js";
import {startChatCoordinationWatcher} from "./runtime/chatCoordination.js";
import { startRoleLoadWatcher } from "./lib/roleLoadWatcher.js";
import { startReviewHistoryWatcher } from "./lib/reviewHistory.js";
import { startWorkPlanWatcher } from "./lib/workPlanWatcher.js";
import { registerPreparationRoutes, startPreparationWorker } from "./runtime/autoPreparation.js";
import { startSecretaryVoiceBridge } from "./runtime/secretaryVoiceBridge.js";
import { hierarchyViolations } from "./lib/taskHierarchy.js";
import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyJwt from "@fastify/jwt";
import { setRoleTokenSigner } from "./runtime/roleRunAccess.js";
import { setInProcessApp } from "./runtime/inProcessRun.js";
import { startRoleRunWorker } from "./runtime/roleRunWorker.js";
import { collapseDuplicateQueuedJobs } from "./runtime/roleRunQueue.js";
import { startChatQueueRecovery, scheduleChatQueueRecovery } from "./runtime/chatQueueRecovery.js";
import { recoverLiveDrafts } from "./runtime/chatLiveDraft.js";
import { finishCompletedPlans, recoverInterruptedPlanSubtasks } from "./runtime/planSubtaskAdmission.js";
import { startKnowledgeSyncSchedule } from "./lib/knowledgeSync.js";
import { startModelUsageRetention } from "./lib/modelUsageRetention.js";
import { startScheduler } from "./runtime/scheduler.js";
import { startStalledStepWatch } from "./runtime/stalledStepWatcher.js";
import { closeOrphanedAttempts, startOrphanedAttemptSweep } from "./runtime/orphanedAttempts.js";
import { startProviderProbe } from "./runtime/providerProbe.js";
import { startLinearAutoImport } from "./lib/linearAutoImport.js";
import { startOrchestratorWebhook } from "./lib/orchestratorWebhook.js";
import { startLinearSync } from "./lib/linearSync.js";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import { ensureJwtSecret, hardenEnvFile, hardenRepoAccess } from "./env.js";
import { runRetention, startRetention } from "./lib/dataRetention.js";
import db, { migrate, DB_PATH } from "./db.js";
import { runMigrations } from "./migrations.js";
import { resolveUserId, resolveUserIdFromToken, authOrApiToken, isRevokedDeviceToken } from "./auth.js";
import { addClient, handleDeviceOpResult, removeClient, resetAllOffline } from "./ws.js";
import {
  attachHostSocket,
  detachHostSocket,
  handleHostMessage,
  isMachineOnline,
  resetHostGatewaysForTests,
  runOperation,
  sendToHost,
  startHostHeartbeat,
} from "./host/gateway.js";
import {
  HOST_DEFAULT_TIMEOUT_MS,
  HOST_MAX_OUTPUT_BYTES,
  HOST_PING_MS,
  HOST_PROTOCOL_VERSION,
  intersectRoots,
  parseHostMessage,
  type ServerToHost,
} from "./host/protocol.js";
import {
  findMachineByToken,
  getMachine,
  markAllMachinesOffline,
} from "./host/machines.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPairingRoutes } from "./routes/pairing.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { startDeviceEventCleanup } from "./lib/deviceEvents.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerAttentionRoutes } from "./routes/attention.js";
import { registerAgentStateRoutes } from "./routes/agent-state.js";
import { registerManualRunRoutes } from "./routes/manual-run.js";
import { registerControlRoutes } from "./routes/control.js";
import { registerRetryRoutes } from "./routes/retry.js";
import { registerConsultationRoutes } from "./routes/consultation.js";
import { registerEmbeddingsRoutes } from "./routes/embeddings.js";
import { registerEnrichSemanticRoutes } from "./routes/enrichSemantic.js";
import { registerProjectLabelRoutes } from "./routes/projects.js";
import { registerSubtaskCommentRoutes } from "./routes/subtasks.js";
import { registerMergeMarkerRoutes } from "./routes/merge-marker.js";
import { registerCodeChangesRoutes } from "./routes/code-changes.js";
import { registerChatWorkspaceRoutes } from "./routes/chat-workspace.js";
import { registerOwnerControlRoutes } from "./routes/owner-controls.js";
import { reloadServerSettings } from "./lib/serverSettings.js";
import { registerOwnerCommandRoutes } from "./routes/owner-commands.js";
import { registerAdminServerSettingsRoutes } from "./routes/admin-server-settings.js";
import { registerSecretsRoutes } from "./routes/secrets.js";
import { registerJevRoutes } from "./routes/jev.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerEscalationRoutes } from "./routes/escalation.js";
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
import { registerTaskDiscussionRoutes } from "./routes/task-discussions.js";
import { registerRunToolsRoutes } from "./routes/run-tools.js";
import { resumePendingHandoffs } from "./runtime/taskDiscussion.js";
import { ensureCommonChat } from "./lib/chatCommon.js";
import { registerWidgetsRoutes } from "./routes/widgets.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerTranscribeRoutes } from "./routes/transcribe.js";
import { registerCompassRoutes } from "./routes/compass.js";
import { registerDictationArchiveRoutes } from "./routes/dictation-archive.js";
import { registerAgentServiceRoutes } from "./routes/agent-service.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerTelegramIntegrationRoutes } from "./routes/telegram-integration.js";
import { registerJournalFolderRoutes } from "./routes/journalFolders.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerTaskOutcomeRoutes } from "./routes/taskOutcome.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerRoleToolRequestRoutes } from "./routes/role-tool-requests.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerAgentInboxRoutes } from "./routes/agent-inbox.js";
import { registerAgentRulesRoutes } from "./routes/agent-rules.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import {
  bootstrapSecrets,
  startWebhookDeliveryLoop,
  startWakeDeliveryLoop,
} from "./lib/webhookSubscriptions.js";
import {
  registerActivityRoutes,
  startActivityObserver,
} from "./routes/activity.js";
import { startInboxTriageWatcher } from "./lib/inboxTriageWatcher.js";
import { startNoteAccessWatcher } from "./lib/noteAccessWatcher.js";
import { startKbTriageWatcher } from "./lib/kbTriageWatcher.js";
import { startOllamaHealthWatcher } from "./lib/ollamaHealthWatcher.js";
import { startWorktreeMergeWatcher } from "./lib/worktreeMergeWatcher.js";
import { startRoleFormatWatcher } from "./lib/roleFormatWatcher.js";
import { startToolErrorAccountingWatcher } from "./runtime/toolErrorAccountingWatcher.js";
import { startKbSearchWatcher } from "./lib/kbSearchWatcher.js";
import { startInboxResultsWriter } from "./lib/inboxResultsWriter.js";
import { registerSeedRoutes } from "./seed.js";
import { registerEnrichmentRoutes } from "./routes/enrichment.js";
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
import { registerLinearRoutes } from "./routes/linear.js";
import { registerComposioRoutes } from "./routes/composio.js";
import { registerCoordinationRoutes } from "./routes/coordination.js";
import { registerRoleToolAuditRoutes } from "./routes/role-tool-audit.js";
import {
  logServerEvent,
  normalizeServerError,
  startServerEventsRetention,
  type ServerEventsRetentionHandle,
} from "./lib/serverEvents.js";
import { registerServerEventsRoutes } from "./routes/serverEvents.js";

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

/** Параметры строки запроса, значение которых не попадает в журнал. */
const SENSITIVE_QUERY_KEYS = [
  "token",
  "access_token",
  "api_key",
  "secret",
  "password",
  "key",
];

/**
 * Замена секретов в строке запроса.
 *
 * Вынесено наружу, чтобы это можно было проверить тестом: внутри buildApp
 * функция была замыканием, и единственным способом её проверить оставалось
 * перехватывать журнал целиком.
 *
 * Параметр называется не одним способом: ключ машины-хоста приходит как
 * `key` (шлюз /host-ws, тикет 1), пользовательский токен — как `token`.
 */
export function redactSensitiveQueryForTest(url: string): string {
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
}

export async function buildApp(): Promise<FastifyInstance> {
  // До всего остального — секрет подписи JWT должен быть в process.env
  // раньше, чем fastifyJwt.register() ниже его прочитает (см. env.ts).
  ensureJwtSecret();
  // Права server/.env чинятся на КАЖДОМ старте, а не только когда секрет
  // генерируется: файл мог достаться в чужие руки после того, как был
  // создан (роли работают от пользователя tfrole, ему .env не нужен —
  // см. hardenEnvFile в env.ts).
  hardenEnvFile();
  // Доступ ролей (tfrole) к основному репозиторию закрывается на каждом
  // старте: роль пишет в СВОЕЙ рабочей копии, а в основном репозитории
  // (server/src, server/dist, .git/config, .git/refs/heads/main) ей писать
  // нельзя — иначе она подменяет исполняемый код сервера или хук, который
  // исполнится при коммите владельца. См. hardenRepoAccess в env.ts.
  hardenRepoAccess();
  // Уборка разросшихся таблиц (журнал идемпотентности инструментов и
  // снимки шагов ходов роли). Раз в сутки по таймеру + один проход на
  // старте — чтобы после простоя мусор не копился снова.
  try {
    const итог = runRetention();
    if (итог.toolRequests || итог.thinkingTrimmed) {
      console.log(
        `[retention] на старте убрано записей: ${итог.toolRequests}, обрезано снимков: ${итог.thinkingTrimmed}`,
      );
    }
  } catch (error) {
    console.warn("[retention] уборка на старте не прошла:", error);
  }

  // bodyLimit по умолчанию у Fastify — 1 МБ, мало для аудиозаписи диктовки
  // (кнопка микрофона, routes/transcribe.ts). Поднимаем до потолка самого
  // ASR-сервиса (25 МБ, см. local-asr-service.md) — выше смысла нет, он всё
  // равно откажет.
  // Секреты в лог не пишем. `/ws?token=...` — вынужденная форма: WebSocket из
  // браузера не умеет слать заголовок Authorization, и токен приходит строкой
  // запроса. Сам протокол это не меняет — режется только то, что попадает в
  // лог (08.09.2026: в dev-server.log лежало 2637 строк с живыми токенами).
  const redactSensitiveQuery = redactSensitiveQueryForTest;

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
    // Ответы API не кэшируются на устройстве (требование владельца
    // 31.10.2026: «без онлайна вообще ничего не грузилось, всё — на стороне
    // сервера»). До этого заголовков кэша не было вовсе, и URLSession на iOS
    // мог показать вчерашний ответ из своего кэша вместо свежего — то есть
    // «данные без сети» и «старый чат вместо нового». SSE
    // (/api/runtime/events) пишет в reply.raw напрямую и сюда не попадает.
    if (
      typeof reply.getHeader === "function" &&
      req.url?.startsWith("/api/") &&
      !reply.getHeader("cache-control")
    ) {
      reply.header("Cache-Control", "no-store, max-age=0");
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
      // Структурированная запись в общий серверный журнал (карточка
      // e87cd93f). Только 5xx — 4xx это нормальная работа API и в общий
      // журнал не пишется, чтобы не размывать сигнал.
      if (reply.statusCode >= 500) {
        logServerEvent({
          scope: "http_error",
          kind: "route_error",
          message: `${req.method} ${redactSensitiveQuery(req.url || "")} → ${reply.statusCode}`,
          data: {
            request_id: id,
            method: req.method,
            url: redactSensitiveQuery(req.url || ""),
            status_code: reply.statusCode,
            body_preview: errorBodyPreview(payload),
          },
          outcome: "err",
          errorCode: `http_${reply.statusCode}`,
        });
      }
    }
    return payload;
  });

  // Наружу — только безопасный текст. До этого обработчика не было вовсе, и
  // Fastify отдавал клиенту message исключения как есть: в живом журнале
  // 23.10.2026 так утекли SQL («near "hours": syntax error», имя таблицы и
  // колонок в «UNIQUE constraint failed: tf_realtime_dirty.topic,
  // tf_realtime_dirty.task_id») и вывод git из /api/merges/roll-back.
  // 4xx оставляем с текстом: это осмысленные отказы («только владелец»,
  // «invalid_window»), их показывает интерфейс. 5xx — обезличенно, детали
  // уже лежат в server_events и в pino (onError выше).
  app.setErrorHandler((err: any, req: any, reply: any) => {
    const status =
      typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;
    if (reply.sent) return;
    if (status >= 500) {
      req.log.error({ err }, "route failed");
      return reply.code(status).send({
        statusCode: status,
        error: "Internal Server Error",
        message: "внутренняя ошибка сервера",
        request_id: req.id,
      });
    }
    return reply.code(status).send({
      statusCode: status,
      error: err?.name || "Bad Request",
      message: err?.message || "некорректный запрос",
      request_id: req.id,
    });
  });

  // Журнал необработанных сбоев маршрута: тело ошибки пишем в общий серверный
  // журнал (карточка e87cd93f), наружу при этом уходит безопасный текст из
  // setErrorHandler выше.
  app.addHook("onError", async (req, reply, err) => {
    const norm = normalizeServerError(err, "fastify_route_error");
    logServerEvent({
      scope: "http_error",
      kind: "route_throw",
      message: `${req.method} ${redactSensitiveQuery(req.url || "")}: ${norm.message}`,
      data: {
        method: req.method,
        url: redactSensitiveQuery(req.url || ""),
        request_id: (req as any).id,
      },
      outcome: "err",
      errorCode: norm.code,
      errorMessage: norm.message,
    });
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
  // Сжатие ответов. До 24.10.2026 его не было вовсе: GET /api/tasks отдавал
  // 3,02 МБ JSON на 123 карточки (в нём 6 коррелированных подзапросов на
  // строку — «последний шаг», «счётчики детей» и т.п.), а это 399 тыс.
  // запросов за окно журнала. Клиенты (URLSession у iOS, fetch в браузере)
  // присылают Accept-Encoding сами, так что сжатие подхватывается без
  // правок клиента; порог 1 КБ — мелочь вроде /api/health не трогаем.
  // SSE (/api/runtime/events) пишет в reply.raw напрямую и через onSend не
  // идёт, потоки файлов сжимаются только если их тип сжимаемый (у картинок
  // и PDF — нет); тот же заголовок Content-Encoding, что уже стоит в ответе,
  // повторно не ставится.
  await app.register(compress, { global: true, threshold: 1024 });
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
  // Агенты и внутренняя автоматика сервера бьют по /api/tasks и
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
  reloadServerSettings();
  // Общий чат ролей (карточка ca816271, п. 2): идемпотентно завести
  // комнату, состав и закреплённый регламент, если их ещё нет.
  try {
    ensureCommonChat();
  } catch (error) {
    console.warn(
      "[index] общий чат не заведён:",
      error instanceof Error ? error.message : error,
    );
  }

  // Routes
  registerAuthRoutes(app);
  registerPairingRoutes(app);
  registerDeviceRoutes(app);
  // Реестр машин-хостов (тикет 1): список для приложения, заведение машины,
  // отзыв ключа и проверочный вызов операции.
  registerHostRoutes(app);
  // Журнал привязок живёт 30 дней (§11.1): чистим при старте и раз в
  // 6 часов, иначе таблица растёт бесконечно, а на ней же считаются
  // лимиты попыток обмена. Таймер unref'ится и снимается при закрытии
  // приложения — тесты не должны висеть из-за него.
  {
    const stopDeviceEventCleanup = startDeviceEventCleanup();
    app.addHook("onClose", async () => stopDeviceEventCleanup());
  }
  registerTaskRoutes(app);
  // Общий журнал синхронизации: /api/sync/changes — догон по курсору для
  // проектов, меток, заметок, дневника, рутин и вложений.
  registerSyncRoutes(app);
  // Рутины (крон-задачи): /api/schedules — CRUD и история запусков.
  registerScheduleRoutes(app);
  // «Входящие»: один ответ на весь экран важного (владелец 28.10.2026).
  registerAttentionRoutes(app);
  registerAgentStateRoutes(app);
  await registerManualRunRoutes(app);
  registerRetryRoutes(app);
  registerConsultationRoutes(app);
  registerEmbeddingsRoutes(app);
  registerEnrichSemanticRoutes(app);
  registerEnrichmentRoutes(app);
  await registerReviewRoutes(app);
  registerRoleRoutes(app);
  registerRuntimeRoutes(app);
  registerRoleRunJobRoutes(app);
  registerPreparationRoutes(app);
  registerTaskCollaborationPlanRoutes(app);
  registerTaskIntakeRoutes(app);
  registerSecretaryVoiceRoutes(app);
  registerMcpManifestRoutes(app);
  registerProjectLabelRoutes(app);
  registerCompassRoutes(app);
  registerSubtaskCommentRoutes(app);
  registerMergeMarkerRoutes(app);
  registerCodeChangesRoutes(app);
  registerChatWorkspaceRoutes(app);
  registerChatSessionPreferenceRoutes(app);
  registerOwnerControlRoutes(app);
  registerAdminServerSettingsRoutes(app);
  registerSecretsRoutes(app);
  registerJevRoutes(app);
  registerServerEventsRoutes(app);
  registerOwnerCommandRoutes(app);
  registerSubtaskArtifactRoutes(app);
  // Ручки «прервать шаг», «сбросить попытку», «отменить задание» —
  // MAK-69, владелец и оркестратор останавливают живой запуск через
  // /api/subtasks/:id/cancel, /api/subtasks/:id/reset, /api/tasks/:id/cancel.
  registerControlRoutes(app);
  registerRuntimeContextRoutes(app);
  registerComposioRoutes(app);
  registerLinearRoutes(app);
  // Диагностика координации (V2 контракт, документ a8bfa7ea-…):
  // четыре эндпоинта под `/api/coordination/*`. Сам резолвер — чистая
  // функция в `runtime/coordinationResolver.ts`, чтение фактов — в
  // `runtime/coordinationResolver.read.ts`. Наблюдательный, без
  // побочных эффектов; действия делают существующие маршруты.
  registerCoordinationRoutes(app);
  // Учёт вызовов инструментов ролями: сводка ошибок и выгрузка JSON/CSV
  // (карточка 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5). Наблюдательный
  // маршрут: ничего не меняет и не запускает.
  registerRoleToolAuditRoutes(app);
  registerNotificationRoutes(app);
  registerEscalationRoutes(app);
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
  registerTaskDiscussionRoutes(app);
  registerRunToolsRoutes(app);
  registerWidgetsRoutes(app);
  registerMemoryRoutes(app);
  registerTranscribeRoutes(app);
  // Архив диктовок (18.08.2026): аудио выгружается с телефона и хранится
  // бессрочно — прямое решение владельца.
  registerDictationArchiveRoutes(app);
  registerAgentServiceRoutes(app);
  registerIntegrationRoutes(app);
  registerTelegramIntegrationRoutes(app);
  registerJournalFolderRoutes(app);
  registerKnowledgeRoutes(app);
  registerTaskOutcomeRoutes(app);
  registerNoteRoutes(app);
  registerLibraryRoutes(app);
  registerRoleToolRequestRoutes(app);
  registerChatRoutes(app);
  await registerAgentInboxRoutes(app);
  await registerAgentRulesRoutes(app);
  registerWebhookRoutes(app);
  registerActivityRoutes(app);
  // Тикет ollama-observer: слой 3 живой строки — необязательное улучшение
  // поверх уже рабочих слоёв 1-2, включается/выключается на лету через
  // ACTIVITY_OBSERVER_ENABLED (см. комментарий в activity.ts).
  startActivityObserver();
  // Inbox-triage watcher: при появлении ticket'а в ~/Проекты/taskflow-уведомления/
  // inbox/*/_diagnostic/*.json создаёт карточку на диагностику прямо в БД.
  // Никаких внешних HTTP/timer'ов — всё внутри процесса сервера
  // (правило Maksim 27.09.2026). Выключается через INBOX_TRIAGE_DISABLED=1.
  if (process.env.INBOX_TRIAGE_DISABLED !== "1") {
    startInboxTriageWatcher();
    // Сторож прибора «учёт обращений к заметкам»: без счётчиков схема базы
    // знаний слепнет (заметка cfa5cdcd, шаг 1 из 4).
    startNoteAccessWatcher();
    const stopRoleLoadWatcher = startRoleLoadWatcher();
    app.addHook("onClose", async()=>stopRoleLoadWatcher());
    const stopReviewHistoryWatcher = startReviewHistoryWatcher();
    app.addHook("onClose", async () => stopReviewHistoryWatcher());
    const stopToolRequestWatcher=startToolRequestWatcher();
    app.addHook("onClose",async()=>stopToolRequestWatcher());
    const stopCoordinationWatcher=startChatCoordinationWatcher();
    app.addHook("onClose",async()=>stopCoordinationWatcher());
    const stopBudgetCaptureWatcher=startBudgetCaptureWatcher();
    app.addHook("onClose",async()=>stopBudgetCaptureWatcher());
    const stopWorkPlanWatcher = startWorkPlanWatcher();
    app.addHook("onClose", async () => stopWorkPlanWatcher());
    // Порог разбора заметок: набралось — заводим задачу Помощнику владельца.
    startKbTriageWatcher();
    // Локальная модель: молчит, пока отвечает; забитая очередь или
    // упавший Ollama — задача Помощнику владельца (владелец 12.10.2026).
    startOllamaHealthWatcher();
    // Автослияние веток ролей: очередь стоит, база падений протухла, main
    // грязный — уведомление в «Состояние системы» (LOCK-WORKTREE-MANAGER-20261019).
    startWorktreeMergeWatcher();
    // Формат ответов ролей: прибор, которым рисует всё приложение. Ломается
    // тихо (блок с неизвестным типом проходит нормализатор), поэтому у него
    // свой сторож (карточка cea8d997, docs/watchers.md).
    const stopRoleFormatWatcher = startRoleFormatWatcher();
    app.addHook("onClose", async () => stopRoleFormatWatcher());
    // Учёт ошибок вызовов инструментов: прибор ломается тихо — шлюз отсекает
    // неверный вызов раньше журнала операций. Сторож проверяет пробным ходом
    // через тот же шлюз (карточка 64af4c85, docs/watchers.md).
    if (process.env.TOOL_ERROR_ACCOUNTING_WATCHER_DISABLED !== "1") {
      const stopToolErrorAccountingWatcher = startToolErrorAccountingWatcher();
      app.addHook("onClose", async () => stopToolErrorAccountingWatcher());
    }
    // Поиск по базе знаний: пробный запрос с известным ответом (docs/watchers.md).
    const stopKbSearchWatcher = startKbSearchWatcher();
    app.addHook("onClose", async () => stopKbSearchWatcher());
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
  // сколько работает, на каком коде, велика ли база, включена ли «Система».
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

    // «Система» — единый переключатель серверной автоматики
    // (task_intake_mode владельца). Раньше здесь опрашивалась системная автоматика
    // taskflow-trigger.service; служба снята 05.10.2026, роли исполняет
    // сервер. Поле trigger сохранено для совместимости с приложением.
    let trigger: string | null = null;
    try {
      const owner = db
        .prepare(
          "SELECT task_intake_mode FROM users WHERE role='owner' ORDER BY created_at LIMIT 1",
        )
        .get() as { task_intake_mode?: string } | undefined;
      trigger = owner?.task_intake_mode === "automatic" ? "active" : "inactive";
    } catch {
      trigger = "unknown";
    }

    // Проверка доступности локальной LLM (Ollama)
    let ollamaOnline = false;
    const ollamaBaseUrl = (
      process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11500"
    ).replace(/\/+$/, "");
    const ollamaModel =
      process.env.OLLAMA_MODEL || "MiniMax-M3.1-Flash-Preview";
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
      // resolveUserId, а не resolveUserIdFromToken: сокету нужно знать, ЧЕМ
      // вошёл клиент. Токен устройства при отзыве закрывается кодом 4401,
      // а не обычным закрытием — иначе телефон решит, что пропала сеть, и
      // будет переподключаться до бесконечности.
      const resolved = resolveUserId(app, token);
      if (!resolved) {
        // Отозванное устройство — СВОИМ текстом, как и на HTTP (§11.2).
        // resolveUserId отбрасывает отозванные (revoked_at IS NULL), и без
        // этой проверки телефон после отзыва получал общий unauthorized:
        // приложение решило бы, что токен сломан, и ушло бы в бесконечное
        // переподключение вместо возврата на экран привязки (§10 п. 7).
        const отозван = !!token && isRevokedDeviceToken(token);
        socket.send(
          JSON.stringify({
            type: "error",
            error: отозван ? "device_revoked" : "unauthorized",
          }),
        );
        socket.close();
        return;
      }
      const { userId, deviceId } = resolved;

      addClient(userId, socket as any, deviceId ?? null);
      socket.on("close", () => removeClient(userId, socket as any));
      socket.on("message", (msg: Buffer) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === "ping")
            socket.send(JSON.stringify({ type: "pong" }));
          // Ответ устройства на команду (device_op → device_op_result).
          // Телефон шлёт его сам, без запроса с сервера, поэтому маршрут
          // живёт здесь, в единственном месте, где сервер слушает сокет.
          else handleDeviceOpResult(data);
        } catch {}
      });
      socket.send(JSON.stringify({ type: "connected" }));
    });
  });

  // Шлюз хостов: сюда подключается программа на маке (тикет 1, план
  // taskflow-host D3). ОТДЕЛЬНЫЙ путь, а не второй вход в /ws, потому что
  // клиент тут другой: ключ машины, а не токен пользователя; и логика другая
  // — операции и отмена вместо событий доски. Смешанный сокет означал бы, что
  // и приложение, и хост живут в одной таблице клиентов и одними правами.
  app.register(async function (fastify) {
    fastify.get("/host-ws", { websocket: true }, (socket, req) => {
      const key = (req.query as any)?.key as string | undefined;
      // Ключ проверяется здесь, в единственном месте: findMachineByToken
      // отбрасывает и неизвестные, и отозванные одинаково. Снаружи различие
      // не выдаётся — иначе перебором можно выяснить, какие ключи выдавали.
      const machine = key ? findMachineByToken(key) : null;
      if (!machine) {
        socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        socket.close();
        return;
      }

      // Корни хост присылает в hello, но welcome уходит сразу после проверки
      // ключа: иначе хост, который молча ждёт welcome, повесил бы соединение
      // на своём таймауте. Первое, что делает хост, — шлёт hello.
      if (!attachHostSocket(machine, socket as any)) {
        socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        socket.close();
        return;
      }
      socket.on("close", () => detachHostSocket(machine.id, socket as any));
      socket.on("message", (msg: Buffer) => {
        if (!handleHostMessage(machine.id, msg)) return;
        // hello несёт корни и версию: ответить пересечением корней, чтобы хост
        // знал, где ему разрешено работать, и не пытался за пределами.
        const сообщение = parseHostMessage(msg);
        if (сообщение?.type === "hello") {
          const машина = getMachine(machine.id);
          sendToHost(machine.id, {
            type: "welcome",
            protocolVersion: HOST_PROTOCOL_VERSION,
            machineId: machine.id,
            machineName: machine.name,
            allowedRoots: intersectRoots(машина?.allowed_roots ?? [], сообщение.roots),
            pingMs: HOST_PING_MS,
            maxOutputBytes: HOST_MAX_OUTPUT_BYTES,
            defaultTimeoutMs: HOST_DEFAULT_TIMEOUT_MS,
          });
          startHostHeartbeat();
        }
      });
      // Первое сообщение — welcome: хост по нему узнаёт свою машину и правила.
      socket.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: HOST_PROTOCOL_VERSION,
          machineId: machine.id,
          machineName: machine.name,
          allowedRoots: machine.allowed_roots,
          pingMs: HOST_PING_MS,
          maxOutputBytes: HOST_MAX_OUTPUT_BYTES,
          defaultTimeoutMs: HOST_DEFAULT_TIMEOUT_MS,
        } satisfies ServerToHost),
      );
      startHostHeartbeat();
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

  // Серверный журнал жизни процесса (карточка e87cd93f). Стартовая и
  // финальные точки ставятся один раз — этого достаточно, чтобы понять
  // «что было при загрузке и при выходе». unhandledRejection/Exception —
  // обвязка всего процесса, чтобы стек не уходил молча в никуда.
  {
    const startedAt = new Date().toISOString();
    let dbPath = "";
    try {
      dbPath = path.basename(DB_PATH);
    } catch {}
    logServerEvent({
      scope: "lifecycle",
      kind: "process_boot",
      message: `TaskFlow API стартует (port=${PORT}, host=${HOST})`,
      data: {
        port: PORT,
        host: HOST,
        node: process.version,
        pid: process.pid,
        db_file: dbPath,
        started_at: startedAt,
      },
    });
    process.on("unhandledRejection", (reason) => {
      const norm = normalizeServerError(reason, "unhandled_rejection");
      logServerEvent({
        scope: "system",
        kind: "unhandled_error",
        message: `unhandledRejection: ${norm.message || "(no message)"}`,
        outcome: "err",
        errorCode: norm.code,
        errorMessage: norm.message,
      });
    });
    process.on("uncaughtException", (err) => {
      const norm = normalizeServerError(err, "uncaught_exception");
      logServerEvent({
        scope: "system",
        kind: "unhandled_error",
        message: `uncaughtException: ${norm.message || "(no message)"}`,
        outcome: "err",
        errorCode: norm.code,
        errorMessage: norm.message,
      });
    });
    process.on("beforeExit", (code) => {
      logServerEvent({
        scope: "lifecycle",
        kind: "process_shutdown",
        message: `процесс завершается (code=${code})`,
        data: { exit_code: code },
        outcome: "ok",
      });
    });
  }

  buildApp().then(async (app) => {
    let stopPreparation: (() => Promise<void>) | null = null;
    let stopRoleRuns: (() => Promise<void>) | null = null;
    let stopVoiceBridge: (() => Promise<void>) | null = null;
    let stopKnowledgeSync: (() => void) | null = null;
    let stopModelUsageRetention: (() => void) | null = null;
    let stopDataRetention: (() => void) | null = null;
    let stopScheduler: (() => void) | null = null;
    let stopStalledWatch: (() => void) | null = null;
    let stopOrphanedAttempts: (() => void) | null = null;
    let stopProviderProbe: (() => void) | null = null;
    let stopChatMemoryObserver: (() => void) | null = null;
    let stopLinearAutoImport: (() => void) | null = null;
    let stopLinearSync: (() => void) | null = null;
    let stopWebhookDelivery: (() => void) | null = null;
    let stopWakeDelivery: (() => void) | null = null;
    let stopEventsRetention: ServerEventsRetentionHandle | null = null;
    let stopChatQueueSweep: (() => void) | null = null;
    app.addHook("onClose", async () => {
      stopKnowledgeSync?.();
      stopModelUsageRetention?.();
      stopDataRetention?.();
      stopScheduler?.();
      stopStalledWatch?.();
      stopOrphanedAttempts?.();
      stopProviderProbe?.();
      stopChatMemoryObserver?.();
      stopLinearAutoImport?.();
      stopLinearSync?.();
      stopWebhookDelivery?.();
      stopWakeDelivery?.();
      stopChatQueueSweep?.();
      stopEventsRetention?.stop();
      if (stopPreparation) await stopPreparation();
      if (stopRoleRuns) await stopRoleRuns();
      if (stopVoiceBridge) await stopVoiceBridge();
    });

    const addr = await app.listen(serverListenOptions(process.env, process.pid, PORT, HOST));
    // Сокетов после рестарта нет ни у кого — значит и «online» в базе быть
    // не может: иначе статус, оставшийся с прошлого запуска, врал бы до
    // первого подключения того же пользователя.
    resetAllOffline();
    // Машины-хосты — те же «сокеты после рестарта нет ни у кого»: оставшийся
    // с прошлого запуска machines.online = 1 врал бы приложению и заставил бы
    // роль стартовать на машине, к которой и подключиться не к кому.
    markAllMachinesOffline();

    // Карточка e87cd93f, шаг «Настройка ротации логов»: периодическая
    // чистка старых строк `server_events` по `created_at`. Интервал и
    // срок хранения — из serverEvents.ts (override/env, дефолт 1ч /
    // 180 дней). В QA-песочнице ротацию всё равно держим — она
    // работает локально и не трогает внешние сервисы.
    if (process.env.TASKFLOW_SERVER_EVENTS_ROTATION !== "off") {
      stopEventsRetention = startServerEventsRetention();
    }
    // Ротация счётчика расхода моделей (24.10.2026, аудит качества данных):
    // таблица model_usage росла без срока (~5000 строк в сутки) и через год
    // заняла бы больше всей остальной базы. Отчёт читает максимум 30 дней,
    // поэтому старые строки не нужны — но самая ранняя по каждой модели
    // остаётся, чтобы «учёт с» не сдвигался.
    if (process.env.TASKFLOW_MODEL_USAGE_ROTATION !== "off") {
      stopModelUsageRetention = startModelUsageRetention();
    }
    // Уборка журнала идемпотентности инструментов и снимков шагов ходов.
    // Таймер не должен мешать тестам: в тестовой среде выключается тем же
    // флагом, что и остальные фоновые службы.
    if (process.env.TASKFLOW_DATA_RETENTION !== "off" && !process.env.VITEST) {
      stopDataRetention = startRetention();
    }
    // Durable worker стартует только в реальном process после listen.
    // buildApp() в unit tests остаётся полностью детерминированным.
    // TASKFLOW_QA_SANDBOX=1 — копия приложения для живой проверки роли QA
    // (scripts/qa/up.sh): на копии базы нельзя запускать роли, планировщик,
    // сторож шагов, синхронизацию знаний и голосовой мост — они ушли бы в
    // реальные модели и внешние сервисы. Остальные службы гасятся своими флагами.
    const sandbox = process.env.TASKFLOW_QA_SANDBOX === "1";
    if (!sandbox) stopRoleRuns = startRoleRunWorker();
    // Карточка ebc4d338: восстановление durable-очереди чата при
    // рестарте. Делается ПОСЛЕ listen, чтобы не мешать runRoleInProcess
    // в тестах. Периодический sweep отключён: оживление
    // идёт через живой /messages, который кладёт delivery_id в
    // pending и поднимает in-memory очередь сам.
    if (!sandbox && process.env.TASKFLOW_QUEUE_RECOVERY !== "off") {
      // Ходы, оборванные падением/перезапуском сервера: сохраняем то, что
      // роль успела написать и передумать, частичным ответом (владелец
      // 31.10.2026). Живых ходов в памяти после старта нет — все строки
      // running заведомо осиротели.
      try {
        const healed = recoverLiveDrafts();
        if (healed > 0) {
          console.log(`[chatLiveDraft] восстановлено оборванных ходов: ${healed}`);
        }
      } catch (error) {
        console.error("[chatLiveDraft] восстановление черновиков не удалось:", error);
      }
      void resumePendingHandoffs().catch(error => console.error("[discussion] восстановление доставки не удалось:", error));
      const queueRecovery = startChatQueueRecovery();
      if (queueRecovery.recovered > 0) {
        console.log(`[chatQueue] recovered ${queueRecovery.recovered} pending deliveries`);
      }
      // Периодический проход: раньше функция была написана, но не
      // вызывалась — мёртвая доставка в очереди чата жила вечно и держала
      // выкладку сервера (карточка 568a2b93). Теперь доставки старше
      // порога закрываются в терминальный статус, а живые поднимаются.
      stopChatQueueSweep = scheduleChatQueueRecovery(
        Number(process.env.TASKFLOW_QUEUE_RECOVERY_INTERVAL_SEC ?? 600),
      );
    }
    // Лавина в очереди ролей: оставляем по одному заданию на намерение
    // (шаг/карточка), остальные — в cancelled. Без этого накопившиеся
    // 723 задания держали очередь и не давали ролям стартовать
    // (карточка 568a2b93).
    if (!sandbox) {
      const collapsed = collapseDuplicateQueuedJobs();
      if (collapsed > 0) {
        console.log(`[roleRunQueue] свёрнуто дублей заданий очереди ролей: ${collapsed}`);
      }
    }
    if(process.env.TASKFLOW_AUTO_PREPARATION!=="0") stopPreparation=startPreparationWorker();
    // Документация проектов → база знаний раз в сутки (lib/knowledgeSync.ts).
    if (!sandbox) stopKnowledgeSync = startKnowledgeSyncSchedule();
    // Планировщик доски раз в 5 минут — внутри сервера (runtime/scheduler.ts).
    if (!sandbox) stopScheduler = startScheduler(app);
    // Сторож зависших шагов: пинг 10/авто-перезапуск 20/blocked 30+ минут без пульса.
    // Карточка 71651ad0; до этого всё чинил оркестратор руками (А30/А37/Г1-к/Г1-л).
    if (!sandbox) stopStalledWatch = startStalledStepWatch();
    if (!sandbox) stopOrphanedAttempts = startOrphanedAttemptSweep();
    // Метка «провайдер в лимите» снимается по факту сброса: пробный запрос раз в 5 минут
    // (runtime/providerProbe.ts), а не только по пятичасовому таймеру.
    if (!sandbox) stopProviderProbe = startProviderProbe();
    if (!sandbox) stopChatMemoryObserver = startChatMemoryObserver();
    // Автоимпорт Linear раз в 5 минут — внутри сервера (lib/linearAutoImport.ts):
    // проекты с меткой «Сейчас», без подтверждения владельца, план не ставит.
    if (process.env.LINEAR_AUTOIMPORT_DISABLED !== "1") stopLinearAutoImport = startLinearAutoImport();
    if (process.env.ORCHESTRATOR_WEBHOOK_DISABLED !== "1") startOrchestratorWebhook();
    // Подписочный мост: durable delivery iOS-подпискам + wake-очередь
    // для пробуждения Codex-чата. Карточка c3c0c199… (hook_server).
    // Карточка 905db3e3-… (webhook V2): секреты HMAC обязаны переживать
    // restart, поэтому до запуска цикла прогреваем кеш расшифрованных
    // секретов из БД. Без ключа (TASKFLOW_WEBHOOK_SECRET_KEY) bootstrap
    // fail-closed только для этой подсистемы — остальной сервер работает.
    if (process.env.WEBHOOK_DELIVERY_DISABLED !== "1") {
      const boot = bootstrapSecrets();
      console.error(
        `[webhook] bootstrap секретов: loaded=${boot.loaded} skipped=${boot.skipped}${boot.reason ? ` reason=${boot.reason}` : ""}`,
      );
      stopWebhookDelivery = startWebhookDeliveryLoop();
      stopWakeDelivery = startWakeDeliveryLoop();
    }
    // Обратная синхронизация TaskFlow → Linear (карточка 20e30338): статусы
    // привязанных карточек раз в минуту; сбой Linear не трогает карточку.
    if (process.env.LINEAR_SYNC_DISABLED !== "1") stopLinearSync = startLinearSync();
    // Ходы ролей живут в процессе: узлы плана, брошенные прошлым процессом,
    // — в ленту и продолжить (runtime/planSubtaskAdmission.ts).
    try {
      const finished = finishCompletedPlans();
      if (finished) console.log(`[plan] сданные планы отправлены на проверку: ${finished}`);
    } catch (error) {
      console.error("[plan] сдача завершённых планов не удалась:", error);
    }
    if (!sandbox) void recoverInterruptedPlanSubtasks()
      .then(({ resumed, blocked }) => {
        if (resumed || blocked) console.log(`[plan] после рестарта: продолжено ${resumed}, остановлено ${blocked}`);
      })
      .catch((error) => console.error("[plan] восстановление брошенных узлов не удалось:", error));
    // Осиротевшие попытки (владелец 24.10.2026): рестарт обрывает запуски
    // ролей, их строки в attempts висят открытыми. Закрываем на старте.
    if (!sandbox) closeOrphanedAttempts();
    // Произвольная глубина (миграция 087): повреждённые связи и циклы
    // не исправляем молча — называем их в журнале.
    try {
      const violations = hierarchyViolations();
      if (violations.length) {
        console.warn(
          `[tasks] нарушения иерархии у ${violations.length} задач: ` +
            violations.slice(0, 10).map((v) => `«${v.title}» ${v.id}`).join(", "),
        );
      }
    } catch (error) {
      console.error("[tasks] проверка вложенности не удалась:", error);
    }
    if (!sandbox) stopVoiceBridge = await startSecretaryVoiceBridge(app);
    console.log(`🚀 TaskFlow API running at ${addr}`);
  });
}
