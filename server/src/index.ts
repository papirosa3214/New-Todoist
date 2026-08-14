import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import { migrate } from "./db.js";
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
import { registerAiRoutes } from "./routes/ai.js";
import { registerTranscribeRoutes } from "./routes/transcribe.js";
import { registerSeedRoutes } from "./seed.js";

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";

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
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || "taskflow-dev-secret-2026",
});
await app.register(fastifyWebsocket);

// DB
migrate();

// Routes
registerAuthRoutes(app);
registerTaskRoutes(app);
registerAgentStateRoutes(app);
registerProjectLabelRoutes(app);
registerSubtaskCommentRoutes(app);
registerNotificationRoutes(app);
registerSearchRoutes(app);
registerAttachmentRoutes(app);
registerAiRoutes(app);
registerTranscribeRoutes(app);
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
        if (data.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      } catch {}
    });
    socket.send(JSON.stringify({ type: "connected" }));
  });
});

// Start
app.listen({ port: PORT, host: HOST }).then((addr) => {
  // Сокетов после рестарта нет ни у кого — значит и «online» в базе быть не
  // может: иначе статус, оставшийся с прошлого запуска, врал бы до первого
  // подключения того же пользователя.
  resetAllOffline();
  console.log(`🚀 TaskFlow API running at ${addr}`);
});
