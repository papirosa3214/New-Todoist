import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { recallAcrossBanks } from "../lib/memoryBanks.js";
import {
  logMemoryAccess,
  memoryAgentStats,
  memoryBanksInUse,
  roleKeyOfBank,
  type MemoryBrowseItem,
} from "../lib/memoryAccessLog.js";

/**
 * Память TaskFlow глазами владельца (08.11.2026): сколько раз кто обращался,
 * и окно поиска по тому, что лежит в банках Mnemosyne.
 *
 * Отдельный экран, потому что «Интеграции» — про подключения, а память — это
 * тот самый реестр, в который роли пишут и из которого читают.
 */
export function registerMemoryWatchRoutes(app: FastifyInstance) {
  app.get("/api/memory/agents", { preHandler: authOrApiToken }, async () => {
    return { agents: memoryAgentStats(), banks: memoryBanksInUse() };
  });

  app.get("/api/memory/browse", { preHandler: authOrApiToken }, async (req) => {
    const query = String((req.query as { q?: string }).q ?? "").trim();
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 20) || 20, 1), 50);

    // Пустой запрос — «что вообще лежит»: свежее из локальной таблицы, она
    // знает заголовки и автора. Поиск — по банкам.
    if (!query) {
      const rows = db
        .prepare(
          `SELECT m.id, m.text, m.title, m.scope, m.role_key, m.created_at,
                  (SELECT bank FROM memory_mnemo_ids WHERE memory_id = m.id LIMIT 1) AS bank
             FROM memories m
            WHERE m.kind <> 'file'
            ORDER BY m.created_at DESC
            LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        text: string;
        title: string | null;
        scope: string;
        role_key: string | null;
        created_at: string;
        bank: string | null;
      }>;
      const items: MemoryBrowseItem[] = rows.map((row) => ({
        id: row.id,
        bank: row.bank ?? (row.scope === "role" ? `tf-role-${row.role_key ?? ""}` : "tf-team"),
        role_key: row.role_key,
        text: row.title ? `${row.title}\n${row.text}` : row.text,
        importance: null,
        score: null,
        at: row.created_at,
      }));
      return { items, banks: memoryBanksInUse() };
    }

    const banks = memoryBanksInUse();
    const hits = await recallAcrossBanks({ banks, query, limit });
    logMemoryAccess({ roleKey: null, query, hits: hits.length, kind: "owner" });
    const items: MemoryBrowseItem[] = hits.map((hit) => ({
      id: hit.id,
      bank: hit.bank,
      role_key: roleKeyOfBank(hit.bank),
      text: hit.content,
      importance: hit.importance ?? null,
      score: hit.score ?? null,
      at: hit.timestamp ?? null,
    }));
    return { items, banks };
  });
}
