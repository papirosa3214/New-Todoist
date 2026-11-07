// Выгрузка документации в базу знаний внутри сервера (владелец 01.10.2026).
// Совместимость со старым ~/kb/taskflow_docs_ragflow_sync.py: хэш смысла,
// перенятое состояние, удаление только своего.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { contentSha, isSyncDue, noteDocument, runKnowledgeSync } from "../src/lib/knowledgeSync.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("хэш смысла — как у kb_content_hash.py", () => {
  // Эталоны сняты питоновским content_sha_text на .110 01.10.2026.
  const t1 = '---\nsource: taskflow\ndoc_id: "n1"\ntitle: "Проба"\ncreated_at: "2026-09-01 10:00:00"\nupdated_at: "2026-09-30 12:00:00"\n---\n# Проба\n\nТекст   \nвторая строка\n';
  it("совпадает с питоном; служебные даты шапки в хэш не входят", () => {
    expect(contentSha(t1)).toBe("f55e5c645ec21b63aed8a11d793b67937b4741fe");
    expect(contentSha(t1.replace("2026-09-30 12:00:00", "2026-10-01 09:00:00"))).toBe("f55e5c645ec21b63aed8a11d793b67937b4741fe");
    expect(contentSha("просто текст без шапки  \n")).toBe("d4c7de608f0186fb82ef51b28bd211e7a27a92a9");
  });
});

describe("когда пора суточный прогон", () => {
  const at = (h: number, m: number, day = 1) => new Date(2026, 9, day, h, m);
  it("после 06:20, раз в сутки; после сбоя — повтор через час", () => {
    expect(isSyncDue(at(6, 0), null)).toBe(false);
    expect(isSyncDue(at(6, 25), null)).toBe(true);
    const okToday = { at: "", at_epoch: at(6, 30).getTime(), ok: true };
    expect(isSyncDue(at(12, 0), okToday)).toBe(false);
    expect(isSyncDue(at(6, 30, 2), okToday)).toBe(true);
    const failed = { at: "", at_epoch: at(6, 30).getTime(), ok: false };
    expect(isSyncDue(at(7, 0), failed)).toBe(false);
    expect(isSyncDue(at(7, 31), failed)).toBe(true);
  });
});

describe("прогон выгрузки", () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  let unchanged: string;
  let changed: string;
  const legacy = path.join(os.tmpdir(), `kb-legacy-${process.pid}.json`);

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "KB owner", email: `kb-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    auth = { authorization: `Bearer ${reg.json().token}` };
    db.prepare("DELETE FROM user_notes").run();
    unchanged = (await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { markdown: "# Старая\n\nне менялась" } })).json().id;
    changed = (await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { markdown: "# Изменённая\n\nновый текст" } })).json().id;
    vi.stubEnv("RAGFLOW_TOKEN", "t");
    vi.stubEnv("RAGFLOW_TASKFLOW_DATASET", "ds");
    vi.stubEnv("TASKFLOW_KB_SYNC_LEGACY_STATE", legacy);
    fs.rmSync(path.join(process.env.TASKFLOW_KB_SYNC_DIR!, "state.json"), { force: true });
    // Состояние старого скрипта: «Старая» уже лежит с тем же смыслом,
    // «Изменённая» — с другим хэшем, «Удалённая» — заметки больше нет.
    const doc = noteDocument(unchanged)!;
    fs.writeFileSync(legacy, JSON.stringify({
      __algo: "content-v1",
      [doc.name]: `${contentSha(doc.text)}@ds`,
      [`taskflow-${changed}.md`]: "0000@ds",
      "taskflow-gone.md": "1111@ds",
    }));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(legacy, { force: true });
    await app.close();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("перенимает старое состояние: неизменное не льёт, изменённое заменяет, своё удалённое убирает, чужое не трогает", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body });
      if (url.includes("/documents?page=")) {
        return new Response(JSON.stringify({ data: { docs: [
          { id: "r-old", name: `taskflow-${unchanged}.md` },
          { id: "r-chg", name: `taskflow-${changed}.md` },
          { id: "r-gone", name: "taskflow-gone.md" },
          { id: "r-foreign", name: "taskflow-foreign.md" },
          { id: "r-other", name: "чужой.pdf" },
        ] } }));
      }
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/documents")) return new Response(JSON.stringify({ data: [{ id: "r-new" }] }));
      return new Response(JSON.stringify({ code: 0 }));
    }));

    const report = await runKnowledgeSync();
    expect(report).toEqual({ documents: 2, uploaded: 1, deleted: 1 });
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => String(c.body));
    expect(deletes).toEqual([JSON.stringify({ ids: ["r-gone"] }), JSON.stringify({ ids: ["r-chg"] })]);
    const upload = calls.find((c) => c.method === "POST" && c.url.endsWith("/documents"))!;
    expect(((upload.body as FormData).getAll("file") as File[]).map((f) => f.name)).toEqual([`taskflow-${changed}.md`]);

    const state = JSON.parse(fs.readFileSync(path.join(process.env.TASKFLOW_KB_SYNC_DIR!, "state.json"), "utf8"));
    expect(state["taskflow-gone.md"]).toBeUndefined();
    expect(state[`taskflow-${changed}.md`]).toMatch(/@ds$/);
    expect(state.__algo).toBe("content-v1");
  });
});
