import { pathToFileURL } from "url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import { ensureJwtSecret } from "./env.js";
import { migrate } from "./db.js";
import { runMigrations } from "./migrations.js";
import { resolveUserIdFromToken } from "./auth.js";
import { addClient, removeClient, resetAllOffline } from "./ws.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerAgentStateRoutes } from "./routes/agent-state.js";
import { registerProjectLabelRoutes } from "./routes/projects.js";
import { registerSubtaskCommentRoutes } from "./routes/subtasks.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerAvatarRoutes } from "./routes/avatars.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerTranscribeRoutes } from "./routes/transcribe.js";
import { registerDictationArchiveRoutes } from "./routes/dictation-archive.js";
import { registerAgentServiceRoutes } from "./routes/agent-service.js";
import { registerSeedRoutes } from "./seed.js";

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
export async function buildApp(): Promise<FastifyInstance> {
  // До всего остального — секрет подписи JWT должен быть в process.env
  // раньше, чем fastifyJwt.register() ниже его прочитает (см. env.ts).
  ensureJwtSecret();

  // bodyLimit по умолчанию у Fastify — 1 МБ, мало для аудиозаписи диктовки
  // (кнопка микрофона, routes/transcribe.ts). Поднимаем до потолка самого
  // ASR-сервиса (25 МБ, см. local-asr-service.md) — выше смысла нет, он всё
  // равно откажет.
  const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

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
    /^text\/plain/,
    "application/pdf",
    "application/octet-stream",
    "application/msword",
    /^application\/vnd\.openxmlformats-officedocument\./,
    /^application\/vnd\.oasis\.opendocument\./,
  ];
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
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  // ensureJwtSecret() выше гарантирует, что JWT_SECRET уже в process.env —
  // без литерала-запасного варианта: он либо пришёл снаружи, либо сгенерирован
  // и сохранён в server/.env при первом старте.
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET as string,
  });
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
  registerProjectLabelRoutes(app);
  registerSubtaskCommentRoutes(app);
  registerNotificationRoutes(app);
  registerSearchRoutes(app);
  registerAttachmentRoutes(app);
  registerAvatarRoutes(app);
  registerAiRoutes(app);
  registerTranscribeRoutes(app);
  // Архив диктовок (18.08.2026): аудио выгружается с телефона и хранится
  // бессрочно — прямое решение владельца.
  registerDictationArchiveRoutes(app);
  registerAgentServiceRoutes(app);
  registerSeedRoutes(app);

  // Health
  app.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

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

  buildApp().then((app) => {
    app.listen({ port: PORT, host: HOST }).then((addr) => {
      // Сокетов после рестарта нет ни у кого — значит и «online» в базе быть
      // не может: иначе статус, оставшийся с прошлого запуска, врал бы до
      // первого подключения того же пользователя.
      resetAllOffline();
      console.log(`🚀 TaskFlow API running at ${addr}`);
    });
  });
}
