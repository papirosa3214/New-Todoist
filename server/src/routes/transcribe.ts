import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";

// ═══════════ Голос → текст (свой ASR-сервис на .110, не сторонний) ═══════════
// Проксирует записанный в браузере звук на локальный ASR (:1235, whisper
// large-v3-turbo/CPU — см. память local-asr-service.md). Причина отдельного
// прохода через НАШ сервер, а не прямой fetch с фронтенда на :1235 — та же,
// что и у AI-разбивки подзадач (routes/ai.ts): фронтенд знает только про
// свой собственный API, адрес локальной инфраструктуры остаётся в одном
// месте на сервере.
const ASR_BASE_URL = (
  process.env.ASR_BASE_URL || "http://192.168.1.110:1235"
).replace(/\/+$/, "");

// CPU-инференс медленнее GPU — длинная диктовка (до 5 минут, см. лимит на
// фронтенде) должна успеть обработаться. С запасом.
const ASR_TIMEOUT_MS = 300_000;

class AsrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrError";
  }
}

async function transcribeAudio(
  audio: Buffer,
  contentType: string,
): Promise<string> {
  let res: Response;
  try {
    // /asr (не /v1/audio/transcriptions) — тот же сервис отдаёт оба, но
    // /asr принимает сырые байты без multipart-обёртки: наш фронтенд уже
    // прислал их нам как есть (Blob из MediaRecorder), лишний раунд
    // упаковки/распаковки не нужен.
    res = await fetch(`${ASR_BASE_URL}/asr`, {
      method: "POST",
      headers: { "Content-Type": contentType || "application/octet-stream" },
      // Buffer's type is generic over ArrayBufferLike (which includes
      // SharedArrayBuffer) — DOM's BlobPart wants a concrete ArrayBuffer,
      // so passing the Buffer straight through doesn't typecheck even
      // though it works fine at runtime. Uint8Array.from() copies into a
      // fresh, concretely-typed Uint8Array<ArrayBuffer> that satisfies
      // both.
      body: new Blob([Uint8Array.from(audio)]),
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new AsrError(
        "Распознавание речи не уложилось в отведённое время. Попробуйте короче.",
      );
    }
    throw new AsrError(
      "Не удалось связаться с локальным сервисом распознавания речи. Проверьте, что он запущен.",
    );
  }

  if (!res.ok) {
    throw new AsrError(
      `Сервис распознавания речи ответил ошибкой (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as any;
  const text: string | undefined = data?.text;
  if (typeof text !== "string") {
    throw new AsrError("Сервис распознавания речи вернул пустой ответ.");
  }
  return text;
}

export function registerTranscribeRoutes(app: FastifyInstance) {
  app.post(
    "/api/audio/transcribe",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      // Content-type parser (см. index.ts) кладёт сырые байты в req.body
      // для любого audio/* — если сюда пришло что-то другое, парсер их не
      // тронул и req.body не Buffer.
      if (!Buffer.isBuffer(req.body)) {
        return reply
          .code(400)
          .send({ error: "Ожидалось тело audio/* (сырые байты записи)" });
      }
      if (req.body.length === 0) {
        return reply.code(400).send({ error: "Пустая запись" });
      }

      try {
        const text = await transcribeAudio(
          req.body,
          req.headers["content-type"] || "",
        );
        return { text };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось распознать речь" });
      }
    },
  );
}
