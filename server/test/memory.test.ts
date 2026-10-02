// Память ролей (владелец 02.10.2026): роли пишут сами, владелец видит и
// правит, файлы в память, вспоминание по смыслу и в задание само.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Детерминированные «эмбеддинги»: мешок слов в 64 измерениях — похожие
// тексты близки, разные далеки, без Ollama.
function bagOfWords(text: string): number[] {
  const vec = new Array(64).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)) {
    let h = 0;
    for (const ch of word.slice(0, 5)) h = (h * 31 + ch.charCodeAt(0)) % 64;
    vec[h] += 1;
  }
  return vec;
}
vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async (input: string) => ({ embeddings: bagOfWords(input), dim: 64, durationMs: 1 })),
}));

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { memoryBlock, chunkText } = await import("../src/lib/memory.js");

describe("память ролей", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("DELETE FROM memories").run();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "MemOwner", email: `mem-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    owner = { authorization: `Bearer ${reg.json().token}` };
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  const post = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/memories", headers, payload });

  it("роль пишет сама: по умолчанию в свою память, похожее — обновляет, а не дублирует", async () => {
    const first = await post(as("role_builder"), { text: "Сервер тесты запускаются командой npx vitest run в папке server", kind: "lesson" });
    expect(first.statusCode).toBe(201);
    expect(first.json().memory).toMatchObject({ scope: "role", role_key: "builder", source_kind: "role", kind: "lesson" });

    const again = await post(as("role_builder"), { text: "Сервер: тесты запускаются командой npx vitest run в папке server", kind: "lesson" });
    expect(again.statusCode).toBe(200);
    expect(again.json().updated).toBe(true);
    expect(again.json().memory.id).toBe(first.json().memory.id);

    const team = await post(as("role_builder"), { text: "Деплой только после подтверждения владельца", scope: "team", kind: "preference" });
    expect(team.json().memory).toMatchObject({ scope: "team", role_key: null });
  });

  it("владелец видит всё и правит любое; роль — только своё; закрепляет владелец", async () => {
    const mine = await post(owner, { text: "Отвечать коротко, без воды", scope: "team", kind: "preference" });
    const id = mine.json().memory.id;
    expect(mine.json().memory.source_kind).toBe("owner");

    const roleEdit = await app.inject({ method: "PATCH", url: `/api/memories/${id}`, headers: as("role_qa"), payload: { text: "Отвечать длинно" } });
    expect(roleEdit.statusCode).toBe(403);
    const roleDelete = await app.inject({ method: "DELETE", url: `/api/memories/${id}`, headers: as("role_qa") });
    expect(roleDelete.statusCode).toBe(403);

    const pin = await app.inject({ method: "PATCH", url: `/api/memories/${id}`, headers: owner, payload: { pinned: true, text: "Отвечать коротко и по делу" } });
    expect(pin.json().memory).toMatchObject({ pinned: 1, text: "Отвечать коротко и по делу" });

    const list = await app.inject({ method: "GET", url: "/api/memories", headers: owner });
    expect(list.json().memories[0].id).toBe(id);
    expect(list.json().memories.length).toBeGreaterThanOrEqual(3);
    expect(list.json().memories[0].embedding).toBeUndefined();
  });

  it("вспоминание: общее и своё видно, чужая память роли — нет", async () => {
    await post(as("role_designer"), { text: "Иконки рисуем в SF Symbols, кастомные только для бренда", kind: "lesson" });
    const builder = await app.inject({ method: "GET", url: "/api/memories/recall?q=" + encodeURIComponent("как запускать тесты сервера vitest"), headers: as("role_builder") });
    const texts = builder.json().items.map((i: any) => i.text);
    expect(texts.some((t: string) => t.includes("vitest"))).toBe(true);
    const designerView = await app.inject({ method: "GET", url: "/api/memories/recall?q=" + encodeURIComponent("тесты сервера vitest"), headers: as("role_designer") });
    expect(designerView.json().items.some((i: any) => i.text.includes("vitest"))).toBe(false);
    // Закреплённое владельцем приходит всегда.
    expect(designerView.json().items.some((i: any) => i.pinned)).toBe(true);
  });

  it("файл в память: текст режется на куски и находится по смыслу", async () => {
    const doc = [
      "# Регламент релиза",
      "Релиз iOS собирается через xcodegen и xcodebuild на маке владельца.",
      "",
      "Перед релизом обязательно прогнать XCUITest по identifier-ам на симуляторе iPhone 17 Pro.",
      "",
      "Сервер на 192.168.1.110 обновляется git pull и перезапуском сервиса taskflow-server.",
    ].join("\n");
    const res = await app.inject({
      method: "POST",
      url: "/api/memories/files?name=" + encodeURIComponent("релиз.md") + "&scope=team",
      headers: { ...owner, "content-type": "text/markdown" },
      payload: Buffer.from(doc, "utf8"),
    });
    expect(res.statusCode).toBe(201);
    const memory = res.json().memory;
    expect(memory).toMatchObject({ kind: "file", title: "релиз.md", scope: "team" });
    expect(memory.chunks).toBeGreaterThanOrEqual(1);

    const view = await app.inject({ method: "GET", url: `/api/memories/${memory.id}`, headers: owner });
    expect(view.json().chunks.map((c: any) => c.text).join(" ")).toContain("XCUITest");

    const block = await memoryBlock({ roleKey: "qa", query: "релиз: сервер обновляется git pull и перезапуском сервиса taskflow-server" });
    expect(block).toContain("Память команды");
    expect(block).toContain("файл «релиз.md»");
  });

  it("нарезка: длинный абзац делится, короткие склеиваются", () => {
    const parts = chunkText(["коротко", "тоже коротко", "x".repeat(4000)].join("\n\n"));
    expect(parts[0]).toBe("коротко\n\nтоже коротко");
    expect(parts.length).toBeGreaterThan(3);
  });

  it("пустая память — блок пустой и без похода за эмбеддингом", async () => {
    expect(await memoryBlock({ roleKey: "researcher", projectId: "нет-такого", query: "что угодно" })).not.toBe("");
    db.prepare("DELETE FROM memories").run();
    expect(await memoryBlock({ roleKey: "researcher", query: "что угодно" })).toBe("");
  });
});
