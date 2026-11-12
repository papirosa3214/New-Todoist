// Расход OpenCode — отдельный раздел экрана «Статистика» (владелец 09.11.2026:
// «нужно установить консоль OpenCode, чтобы была возможность отслеживать
// расходы… добавь конкретную вкладку OpenCode»).
//
// Откуда данные. OpenCode (CLI на .110) сам пишет каждое сообщение модели в
// свою базу `~/.local/share/opencode/opencode.db`, таблица `message`, поле
// `data` — JSON с `tokens` (input/output/reasoning/cache) и `cost`. Отдельного
// HTTP-API у консоли для истории расхода нет: `opencode-console status` отдаёт
// только признак входа. Поэтому читаем базу напрямую — но **только на чтение**
// и только для показа: ничего не пишем и не меняем.
//
// Путь переопределяется OPENCODE_DB — тесты и перенос базы не должны требовать
// правки кода.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";

export type OpenCodeWindow = "today" | "week" | "month";

const WINDOW_MS: Record<OpenCodeWindow, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export function openCodeDbPath(): string {
  const custom = (process.env.OPENCODE_DB ?? "").trim();
  if (custom) return custom;
  return path.join(os.homedir(), ".local/share/opencode/opencode.db");
}

export interface OpenCodeModelUsage {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface OpenCodeUsage {
  /** Есть ли вообще база: нет — честный пустой ответ, а не «ноль расхода». */
  available: boolean;
  /** Путь к базе, чтобы владелец видел, что читается. */
  database: string;
  window: OpenCodeWindow;
  /** Начало периода, ISO UTC. */
  since: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Сколько вызовов без данных о токенах: цифры ниже — только по известным. */
  unknownUsageCalls: number;
  models: OpenCodeModelUsage[];
  /** Строка про источник, её показывает экран под цифрами. */
  note: string;
}

function emptyUsage(database: string, window: OpenCodeWindow): OpenCodeUsage {
  return {
    available: false,
    database,
    window,
    since: null,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    unknownUsageCalls: 0,
    models: [],
    note: "База OpenCode не найдена — OpenCode на этой машине ещё не запускался.",
  };
}

/** Собрать расход из базы OpenCode за окно. Только чтение. */
export function readOpenCodeUsage(window: OpenCodeWindow, dbPath = openCodeDbPath()): OpenCodeUsage {
  if (!fs.existsSync(dbPath)) return emptyUsage(dbPath, window);
  const since = Date.now() - WINDOW_MS[window];
  let db: Database.Database | undefined;
  try {
    // readonly: файл принадлежит OpenCode; писать в него TaskFlow не имеет права.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT data FROM message
          WHERE time_created >= ?
            AND json_extract(data,'$.role') = 'assistant'`,
      )
      .all(since) as Array<{ data: string }>;

    const byModel = new Map<string, OpenCodeModelUsage>();
    let calls = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cost = 0;
    let unknown = 0;

    for (const row of rows) {
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        unknown += 1;
        continue;
      }
      // Сообщение с ошибкой провайдера — не расход: токенов у него нет.
      if (parsed?.error) continue;
      const tokens = parsed?.tokens ?? null;
      const model = String(parsed?.modelID ?? "неизвестная модель");
      const provider = String(parsed?.providerID ?? "—");
      const key = `${provider}/${model}`;
      const entry = byModel.get(key) ?? {
        model,
        provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      };
      entry.calls += 1;
      calls += 1;
      const inTok = Number(tokens?.input ?? 0);
      const outTok = Number(tokens?.output ?? 0);
      const cacheTok = Number(tokens?.cache?.read ?? 0);
      const costUsd = Number(parsed?.cost ?? 0);
      if (!tokens) unknown += 1;
      entry.inputTokens += inTok;
      entry.outputTokens += outTok;
      entry.cacheReadTokens += cacheTok;
      entry.costUsd += costUsd;
      input += inTok;
      output += outTok;
      cacheRead += cacheTok;
      cost += costUsd;
      byModel.set(key, entry);
    }

    const models = [...byModel.values()].sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
    return {
      available: true,
      database: dbPath,
      window,
      since: new Date(since).toISOString(),
      calls,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      costUsd: cost,
      unknownUsageCalls: unknown,
      models,
      note: "Данные из локальной базы OpenCode на .110. Это только OpenCode — расход ролей TaskFlow в разделе выше.",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...emptyUsage(dbPath, window),
      note: `База OpenCode не читается: ${reason}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* закрытие базы не должно ронять ответ */
    }
  }
}

export function registerOpenCodeUsageRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { window?: string } }>(
    "/api/opencode/usage",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "доступно только владельцу" });
      const window = String(req.query?.window ?? "week") as OpenCodeWindow;
      if (!(window in WINDOW_MS)) return reply.code(400).send({ error: "invalid_window" });
      return readOpenCodeUsage(window);
    },
  );
}
