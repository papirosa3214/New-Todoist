import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { piRuntime } from "../src/runtime/PiRuntimeAdapter.js";
import { qualifyModelRef, resolveCatalogModel, roleModelOptions } from "../src/runtime/modelCatalog.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

// Карточка e11eae7a: серверный контракт панели чата — модели с провайдером,
// /controls с актуальным окном и командами, Помощник в чате, реальные slash.
describe("панель чата: модели, controls, Помощник, команды", () => {
  let app: any;
  let owner: any;
  let outsider: any;
  let chat: any;

  const auth = (u: any) => ({ authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    app = await buildApp();
    const reg = async (name: string) =>
      (await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name, email: `${name}@panel.test`, password: "password123" },
      })).json();
    owner = await reg("panel-owner");
    outsider = await reg("panel-outsider");
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.user.id);
    chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: auth(owner),
        payload: { kind: "direct", member_ids: ["u-secretary"] },
      })
    ).json().chat;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("модели роли отдаются с провайдером и не сливаются между провайдерами", async () => {
    vi.spyOn(piRuntime, "listModels").mockResolvedValue([
      { id: "deepseek-v4.1-flash", provider: "opencode-go", name: "DeepSeek (Go)", available: true, contextWindow: 160000 },
      { id: "deepseek-v4.1-flash", provider: "minimax", name: "DeepSeek (MiniMax)", available: true },
      { id: "hidden-model", provider: "minimax", name: "Hidden", available: false },
    ] as any);
    const res = await app.inject({ url: "/api/roles/builder/models", headers: auth(owner) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.models.map((m: any) => m.id);
    expect(ids).toContain("opencode-go/deepseek-v4.1-flash");
    expect(ids).toContain("minimax/deepseek-v4.1-flash");
    expect(ids).not.toContain("hidden-model");
    const first = body.models.find((m: any) => m.id === "opencode-go/deepseek-v4.1-flash");
    expect(first.provider).toBe("opencode-go");
    expect(first.modelID).toBe("deepseek-v4.1-flash");
    expect(first.title).toBe("DeepSeek (Go)");
    expect(first.contextWindow).toBe(160000);
    if (body.current) expect(body.current).toContain("/");
  });

  it("явный выбор провайдера не подменяется моделью с тем же именем у другого", () => {
    const catalog = [
      { id: "deepseek-v4.1-flash", provider: "opencode-go" },
      { id: "deepseek-v4.1-flash", provider: "minimax" },
    ];
    expect(resolveCatalogModel(catalog, "minimax/deepseek-v4.1-flash")?.provider).toBe("minimax");
    expect(resolveCatalogModel(catalog, "opencode-go/deepseek-v4.1-flash")?.provider).toBe("opencode-go");
    // Такой модели у провайдера нет — подмены нет.
    expect(resolveCatalogModel(catalog, "anthropic/deepseek-v4.1-flash")).toBeNull();
    // Голый id работает как раньше.
    expect(resolveCatalogModel(catalog, "deepseek-v4.1-flash")?.provider).toBe("opencode-go");
    expect(qualifyModelRef("minimax/MiniMax-M3.1-Flash")).toBe("minimax/MiniMax-M3.1-Flash");
    expect(roleModelOptions(catalog).map((m) => m.id)).toEqual([
      "opencode-go/deepseek-v4.1-flash",
      "minimax/deepseek-v4.1-flash",
    ]);
  });

  it("controls отдаёт контекст и команды участнику и не отдаёт чужому", async () => {
    const missing = await app.inject({ url: `/api/chats/${chat.id}/controls`, headers: auth(owner) });
    expect(missing.statusCode).toBe(400);
    const stranger = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=${outsider.user.id}`,
      headers: auth(owner),
    });
    expect(stranger.statusCode).toBe(404);
    const notMember = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(outsider),
    });
    expect(notMember.statusCode).toBe(404);
    const res = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.context.roleID).toBe("u-secretary");
    expect(["measured", "no_session", "after_compaction", "unavailable"]).toContain(body.context.status);
    expect(body.context.tokens === null || typeof body.context.tokens === "number").toBe(true);
    expect(Array.isArray(body.commands)).toBe(true);
    for (const command of body.commands) {
      expect(["skill", "mcp"]).toContain(command.kind);
      expect(command.invocation.startsWith(command.kind === "skill" ? "/skill:" : "/mcp:")).toBe(true);
      expect(command.id).not.toBe("definitely-not-a-real-command");
    }
  });

  it("неизвестный slash-вызов отклоняется и ничего не исполняет", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=?").get(chat.id) as any;
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "/skill:definitely-not-a-real-skill почини" },
    });
    expect(res.statusCode).toBe(400);
    const after = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=?").get(chat.id) as any;
    expect(after.n).toBe(before.n);
  });

  it("Помощник в личной переписке работает только в чате", async () => {
    const mode = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/execution-mode`,
      headers: auth(owner),
      payload: { execution_mode: "card" },
    });
    expect(mode.statusCode).toBe(403);
    const card = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "Оформи как карточку", execution_mode: "card" },
    });
    expect(card.statusCode).toBe(403);
    const room = (await app.inject({ url: `/api/chats/${chat.id}`, headers: auth(owner) })).json().chat;
    expect(room.execution_mode).toBe("chat");
  });

  it("глубокое исследование доступно Помощнице владельца", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "Изучи, как устроены модели провайдеров", work_mode: "deep_research" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("Помощница получает исследовательский набор сама и без карточного отчёта", () => {
    const secretary = taskflowTools("secretary", null, undefined, undefined, true, { chatId: "", messageId: "" });
    const names = secretary.map((t: any) => t.name);
    for (const tool of ["web_search", "web_get", "ocr", "youtube", "local_model"]) {
      expect(names).toContain(tool);
    }
    expect(names).not.toContain("taskflow_report");
    const researcher = taskflowTools("researcher", null, undefined, undefined, true, { chatId: "", messageId: "" });
    expect(researcher.map((t: any) => t.name)).toContain("taskflow_report");
  });
});
