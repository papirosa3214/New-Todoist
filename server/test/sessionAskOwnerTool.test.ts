import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { createSessionAskOwnerTool } from "../src/sessions/sessionAskOwnerTool.js";
import { deliverAnswer } from "../src/lib/questionWait.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe("вопрос владельцу из сессии — запись и ожидание (владелец 13.11.2026)", () => {
  it("пишет вопрос без чата, отдаёт карточку и продолжает ход с ответом", async () => {
    const tool = createSessionAskOwnerTool();
    const updates: any[] = [];
    const run = tool.execute("call", {
      questions: [{ question: "Делать?", options: [{ label: "Да" }, { label: "Нет" }] }],
    } as any, undefined, (u: any) => updates.push(u), undefined as any);
    await new Promise((r) => setTimeout(r, 10));
    const id = updates[0].details.question.id as string;
    const row = db.prepare("SELECT chat_id, status FROM chat_questions WHERE id=?").get(id) as any;
    expect(row.chat_id).toBe("");
    expect(row.status).toBe("open");
    db.prepare("UPDATE chat_questions SET status='answered' WHERE id=?").run(id);
    expect(deliverAnswer(id, { answers: [{ questionIndex: 0, selected: ["Да"] }] } as any)).toBe(true);
    const result: any = await run;
    expect(result.details.status).toBe("answered");
    expect(result.content[0].text).toContain("Да");
  });
});
