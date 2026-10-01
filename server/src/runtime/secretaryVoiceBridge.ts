import { NonTaskInputError } from "../lib/taskPreparation.js";
import { composeLayer, instructionManifest } from "../lib/roleContextResolver.js";
// Закрытый канал Python-воркера к живому серверу. Никаких TCP-маршрутов
// или постоянных api_token: только Unix socket владельца процесса (0600).
import type { FastifyInstance } from "fastify";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import db from "../db.js";
import { requestTaskSummary } from "../lib/secretaryTaskSummary.js";
import { submitOwnerTaskText } from "../lib/ownerDraft.js";

export const secretaryVoiceSocket = () => join(
  process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`,
  "taskflow-secretary", "voice.sock",
);

export async function startSecretaryVoiceBridge(app: FastifyInstance, socketPath = secretaryVoiceSocket()) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  // После остановки процесса может остаться только его socket-файл.
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error("voice bridge path is not a socket");
    unlinkSync(socketPath);
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/secretary/instructions") {
      send(200,{instructions:composeLayer("secretary","secretary.voice")!.effective,greeting:composeLayer("secretary","secretary.greeting")!.effective,manifest:instructionManifest("secretary","voice")}); return;
    }
    if (req.method !== "POST" || !["/secretary/tasks", "/secretary/summary"].includes(req.url || "")) {
      send(404, { error: "неизвестный инструмент" }); return;
    }
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 32768) { send(413, {error:"слишком большой запрос"}); return; }
      }
      let body: any;
      try { body = JSON.parse(raw); } catch { send(400, {error:"неверный JSON"}); return; }
      const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {id:string} | undefined;
      if (!owner || body.owner_id !== owner.id) {
        send(403, {error:"только владелец голосовой комнаты"}); return;
      }
      const text = body.text;
      if (typeof text !== "string" || !text.trim() || text.length > 6000) {
        send(400,{error:"нужен полный текст поручения, до 6000 символов"}); return;
      }
      if (req.url === "/secretary/summary") {
        if (body.send_to_chat !== undefined && typeof body.send_to_chat !== "boolean") {
          send(400,{error:"send_to_chat должен быть boolean"}); return;
        }
        send(200,await requestTaskSummary(owner.id,text,body.send_to_chat===true)); return;
      }
      const mode = (db.prepare("SELECT task_intake_mode FROM users WHERE id=?").get(owner.id) as any).task_intake_mode;
      const intake = await submitOwnerTaskText(text,owner.id,mode);
      const row = db.prepare("SELECT t.id,t.title,t.creator_id,t.due_date,t.start_time,t.priority,t.assignee_id,t.ready_for_pickup,u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?").get(intake.parentId) as Record<string,unknown>;
      const labels = db.prepare("SELECT l.id,l.name FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=?").all(intake.parentId);
      const task = {...row,labels};
      send(200,{task,child_ids:intake.childIds,questions:intake.questions,
        requires_plan_approval:intake.requiresPlanApproval,dispatched:intake.dispatched,queued:intake.queued});
    } catch (error) {
      if (error instanceof NonTaskInputError) { send(422,{error:error.message,intent:error.intent,task:null}); return; }
      app.log.error({err:error}, "ошибка локального инструмента голосового Секретаря");
      if (!res.headersSent) send(500, {error:"сбой инструмента Секретаря"});
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
  });
  return async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { unlinkSync(socketPath); } catch (error:any) { if (error.code !== "ENOENT") throw error; }
  };
}
