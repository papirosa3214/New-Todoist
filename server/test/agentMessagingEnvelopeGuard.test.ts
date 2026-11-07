// Сообщение коллеге инструментом — обычный текст. Владелец 06.11.2026: в
// чате появился сырой JSON-конверт ответа роли ({"schema_version":1,"ok":true,
// "output":[{"type":"report"…) — роль отправила его через taskflow_chat_reply/
// taskflow_chat_send, где валидатора не было. Теперь инструмент отказывает, и
// модель переписывает сообщение.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { agentMessagingTools, roleEnvelopeMessageError } from "../src/runtime/agentMessaging.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const envelope = '{"schema_version":1,"ok":true,"output":[{"type":"report","report_kind":"final","sections":{"result":[{"type":"text","text":"Готово"}]}}]}';

describe("сообщение коллеге не может быть JSON-конвертом ответа", () => {
  it("распознаёт конверт, в том числе в блоке кода и оборванный", () => {
    expect(roleEnvelopeMessageError(envelope)).toMatch(/обычн/);
    expect(roleEnvelopeMessageError("```json\n" + envelope + "\n```")).toMatch(/обычн/);
    expect(roleEnvelopeMessageError('{ "schema_version": 1, "ok": true, "output": [ { "type": "rep')).toMatch(/обычн/);
    expect(roleEnvelopeMessageError('{"ok":false,"output":"не вышло","error":"нет доступа"}')).toMatch(/обычн/);
  });

  it("обычный текст проходит, даже с фигурными скобками внутри", () => {
    expect(roleEnvelopeMessageError("Готово: поправил конфиг, ключ {schema_version} не трогал")).toBeNull();
    expect(roleEnvelopeMessageError("Пример запроса: {\"id\": 1}")).toBeNull();
    expect(roleEnvelopeMessageError("@builder проверь, пожалуйста, сборку")).toBeNull();
  });

  it("инструменты отправки отказывают до доставки", async () => {
    const tools = agentMessagingTools("architect") as any[];
    const send = tools.find((t) => t.name === "taskflow_chat_send");
    const reply = tools.find((t) => t.name === "taskflow_chat_reply");
    await expect(send.execute("t1", { to: "builder", text: envelope })).rejects.toThrow(/обычн/);
    await expect(reply.execute("t2", { message_id: "нет-такого", text: envelope })).rejects.toThrow(/обычн/);
  });
});
