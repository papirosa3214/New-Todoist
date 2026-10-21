import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  checkKbSearch,
  KB_SEARCH_WATCH_TYPE,
} from "../src/lib/kbSearchWatcher.js";

const DOC = "919c1483-adb9-43c7-a077-931a9bebbd50";
const reply = (body: unknown) =>
  (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const alerts = () =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = ?")
      .get(KB_SEARCH_WATCH_TYPE) as { n: number }
  ).n;

describe("сторож поиска по базе знаний", () => {
  beforeAll(() => {
    migrate();
    runMigrations();
  });
  beforeEach(() => {
    process.env.RAGFLOW_TOKEN = "t";
    process.env.RAGFLOW_TASKFLOW_DATASET = "ds";
    db.prepare("DELETE FROM notifications WHERE type = ?").run(
      KB_SEARCH_WATCH_TYPE,
    );
  });

  it("молчит, когда известная заметка находится", async () => {
    const r = await checkKbSearch(
      reply({
        code: 0,
        data: { chunks: [{ document_keyword: `taskflow-${DOC}.md` }] },
      }),
    );
    expect(r.ok).toBe(true);
    expect(alerts()).toBe(0);
  });

  it("тревожит на «No chunk found» и не чаще раза в сутки", async () => {
    const broken = reply({
      code: 102,
      message: "No chunk found! Check the chunk status please!",
    });
    const r = await checkKbSearch(broken);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("tenant_embd_id");
    await checkKbSearch(broken);
    const owners = (
      db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")
        .get() as { n: number }
    ).n;
    expect(alerts()).toBe(owners);
  });

  it("тревожит, если выдача есть, но известной заметки в ней нет", async () => {
    const r = await checkKbSearch(
      reply({
        code: 0,
        data: { chunks: [{ document_keyword: "taskflow-other.md" }] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("919c1483");
  });
});
