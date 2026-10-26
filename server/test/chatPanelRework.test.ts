import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { openChatSession, _clearChatContextForTests } from "../src/runtime/chatContextUsage.js";
import { ensureResearchDocument } from "../src/runtime/chatResearchDocument.js";
import { chatModeInstruction } from "../src/runtime/chatWorkMode.js";

// Доработка по замечаниям проверки карточки e11eae7a:
// D1 — после «Новая сессия» панель не показывает окно прошлой сессии;
// D2 — реальный slash-навык доступен до первого хода роли;
// D3 — список команд учитывает режим чата (Планирование);
// D4 — глубокое исследование оставляет документ с выводами.
describe("панель чата: доработка D1–D4", () => {
  let app: any;
  let owner: any;
  let chat: any;

  const auth = (u: any) => ({ authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    app = await buildApp();
    const reg = async (name: string) =>
      (await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name, email: `${name}@fix.test`, password: "password123" },
      })).json();
    owner = await reg("fix-owner");
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

  it("D1: после новой сессии панель не показывает прежнее окно контекста", async () => {
    _clearChatContextForTests();
    // Замер прежней сессии: занятое окно 5000 токенов.
    openChatSession({
      chatId: chat.id,
      roleId: "u-secretary",
      session: { getContextUsage: () => ({ tokens: 5000, contextWindow: 200000 }) },
      sessionId: "sess-old",
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
    });
    const before = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    expect(before.json().context.sessionID).toBe("sess-old");
    expect(before.json().context.tokens).toBe(5000);

    const reset = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/new-session`,
      headers: auth(owner),
      payload: { role_id: "u-secretary" },
    });
    expect(reset.statusCode).toBe(200);

    const after = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    const context = after.json().context;
    expect(context.sessionID).toBeNull();
    expect(context.tokens).toBeNull();
    expect(context.status).toBe("no_session");
  });

  it("D2: реальный навык виден в командах и вызывается до первого хода роли", async () => {
    _clearChatContextForTests();
    const controls = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    expect(controls.statusCode).toBe(200);
    const skills = controls.json().commands.filter((c: any) => c.kind === "skill");
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((s: any) => s.id)).toContain("chat-report-format");
    // Настоящий вызов навыка не должен отклоняться как «не найден».
    const call = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "/skill:chat-report-format сделай отчёт" },
    });
    expect(call.statusCode).toBe(200);
    const stored = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id=? ORDER BY rowid DESC LIMIT 1")
      .get(chat.id, owner.user.id) as { text: string } | undefined;
    expect(stored?.text ?? "").toContain("chat-report-format");
  });

  it("D3: список команд учитывает режим чата", async () => {
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "Спланируй работу", work_mode: "plan" },
    });
    const controls = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    const ids = controls.json().commands.map((c: any) => c.id);
    expect(ids).not.toContain("bash");
    expect(ids).not.toContain("write");
    expect(ids).not.toContain("edit");
    // В режиме работы эти инструменты остаются.
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: auth(owner),
      payload: { text: "Сделай работу", work_mode: "work" },
    });
    const work = await app.inject({
      url: `/api/chats/${chat.id}/controls?role_id=u-secretary`,
      headers: auth(owner),
    });
    expect(work.json().commands.map((c: any) => c.id)).toContain("bash");
  });

  it("D4: глубокое исследование оставляет документ с выводами", async () => {
    // Инструкция режима требует сохранить документ.
    expect(chatModeInstruction("deep_research")).toContain("документ");
    // Роль ничего не сохранила — сервер сохраняет её ответ как документ.
    const roleUserId = "u-secretary";
    const since = new Date(Date.now() - 60_000).toISOString();
    const result = ensureResearchDocument({
      roleUserId,
      text: "Выводы исследования: X — источник https://example.com",
      sinceIso: since,
      taskId: null,
      projectId: null,
    });
    expect(result?.createdByServer).toBe(true);
    expect(result?.document.ref.startsWith("note://")).toBe(true);
    const note = db
      .prepare("SELECT title, content FROM user_notes WHERE id=?")
      .get(result!.document.id) as { title: string; content: string } | undefined;
    expect(note).toBeTruthy();
    expect(String(note!.content)).toContain("example.com");
    // Документ уже есть — новый не создаётся (роль сохранила сама).
    const again = ensureResearchDocument({
      roleUserId,
      text: "Ещё текст",
      sinceIso: since,
      taskId: null,
      projectId: null,
    });
    expect(again?.createdByServer).toBe(false);
  });
});
