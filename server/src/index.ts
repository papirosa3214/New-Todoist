import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import { migrate } from "./db.js";
import { resolveUserIdFromToken } from "./auth.js";
import { addClient, removeClient } from "./ws.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerProjectLabelRoutes } from "./routes/projects.js";
import { registerSubtaskCommentRoutes } from "./routes/subtasks.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerSeedRoutes } from "./seed.js";

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";

const app = Fastify({ logger: true });

// Plugins
await app.register(cors, { origin: true, credentials: true });
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || "taskflow-dev-secret-2026",
});
await app.register(fastifyWebsocket);

// DB
migrate();

// Routes
registerAuthRoutes(app);
registerTaskRoutes(app);
registerProjectLabelRoutes(app);
registerSubtaskCommentRoutes(app);
registerNotificationRoutes(app);
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
  console.log(`🚀 TaskFlow API running at ${addr}`);
});
