import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
const model = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/runtime/PiRuntimeAdapter.js", async original => ({
  ...await original<any>(),
  startChatRun: async (input: any) => {
    if(input.mode !== "discussion") throw new Error("разговорный ход должен быть только чтением");
    if (model.fail) throw new Error("модель недоступна");
    return { sessionId: "discussion", text: "Проверил формат: JSON." };
  },
}));
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { chatTools } from "../src/runtime/chatTools.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
let app: FastifyInstance;
const invoke = async (role: string, name: string, params: any) => {
  const tool = chatTools(role).find(t => t.name === name)!;
  const result = await tool.execute("test", params);
  return JSON.parse((result as any).content[0].text);
};
const messages = (chatId: string) => db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY rowid").all(chatId) as any[];
const auth = (role: string) => ({ authorization: `Bearer ${app.jwt.sign({id: 'role_'+role})}` });
beforeAll(async () => { app = await buildApp(); seedRoleAccounts(db); });
beforeEach(() => { model.fail = false; });
afterAll(async () => { await app.close(); });
it("personal agent question without @ receives a linked answer and closes the automatic exchange", async () => {
  const response = await app.inject({method:"POST",url:"/api/chats",headers:auth("architect"),payload:{kind:"direct",member_ids:["role_researcher"]}});
  const chatId = response.json().chat.id;
  const sent = await app.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers:auth("architect"),payload:{text:"Какой формат подходит?"}});
  expect(sent.statusCode).toBe(200);
  await vi.waitFor(() => expect(messages(chatId).some(m => m.from_user_id === "role_researcher")).toBe(true));
  await vi.waitFor(() => expect(db.prepare("SELECT count(*) n FROM chat_message_queue WHERE chat_id=? AND status IN ('pending','picked')").get(chatId)).toMatchObject({n:0}));
  const rows = messages(chatId);
  expect(rows[1]).toMatchObject({reply_to_message_id:sent.json().message.id,text:"Проверил формат: JSON."});
  expect(rows.length).toBeLessThanOrEqual(3);
});
it("chat_send invokes a sleeping internal role without a webhook subscription", async () => {
  const sent = await invoke("architect", "taskflow_chat_send", {to:"Researcher",text:"Проверь формат JSON"});
  expect(sent.chat_id).toEqual(expect.any(String));
  await vi.waitFor(() => expect(messages(sent.chat_id).some(m => m.from_user_id === "role_researcher" && m.reply_to_message_id === sent.id)).toBe(true));
  expect(db.prepare("SELECT count(*) n FROM webhook_wake_queue").get()).toMatchObject({n:0});
});
it("work and discussion roles receive the same messenger tools", () => {
  const names = taskflowTools("builder", "test").map(t => t.name);
  expect(names).toContain("taskflow_chat_send");
  expect(names).toContain("taskflow_chat_reply");
  expect(names).toContain("taskflow_chat_read");
});
it("group context without @ stays quiet; an explicit @ returns a linked answer", async () => {
  const chat = (await app.inject({method:"POST",url:"/api/chats",headers:auth("architect"),payload:{kind:"group",member_ids:["role_researcher","role_qa"]}})).json().chat.id;
  await invoke("architect", "taskflow_chat_send", {to:"всем",chat_id:chat,text:"Контекст работы"});
  expect(messages(chat)).toHaveLength(1);
  const sent = await invoke("architect", "taskflow_chat_send", {to:"Researcher",chat_id:chat,text:"Уточни формат"});
  await vi.waitFor(() => expect(messages(chat).some(m=>m.from_user_id==="role_researcher" && m.reply_to_message_id===sent.id)).toBe(true));
  expect(messages(chat).filter(m=>m.from_user_id==="role_qa")).toHaveLength(0);
});
it("a reply returns to the question author and read exposes the same conversation", async () => {
  const sent = await invoke("architect", "taskflow_chat_send", {to:"QA",text:"Как проверять формат?"});
  await vi.waitFor(() => expect(messages(sent.chat_id).some(m=>m.from_user_id==="role_qa")).toBe(true));
  const reply = await invoke("qa", "taskflow_chat_reply", {message_id:sent.id,text:"Проверяй схему JSON"});
  expect(db.prepare("SELECT from_user_id,reply_to_message_id,chat_id FROM chat_messages WHERE id=?").get(reply.id)).toMatchObject({from_user_id:"role_qa",reply_to_message_id:sent.id,chat_id:sent.chat_id});
  const read = await invoke("architect", "taskflow_chat_read", {chat_id:sent.chat_id});
  expect(JSON.stringify(read)).toContain("Проверяй схему JSON");
});
it("model failure remains visible and does not become a successful answer", async () => {
  model.fail = true;
  const sent = await invoke("architect", "taskflow_chat_send", {to:"Designer",text:"Уточни размер"});
  await vi.waitFor(()=>expect(messages(sent.chat_id).some(m=>m.reply_to_message_id===sent.id && m.text.includes("модель недоступна"))).toBe(true));
  await vi.waitFor(()=>expect(db.prepare("SELECT status FROM chat_message_queue WHERE message_id=?").get(sent.id)).toMatchObject({status:"failed"}));
});
it("a foreign chat cannot be used to deliver a question", async () => {
  const chat = (await app.inject({method:"POST",url:"/api/chats",headers:auth("qa"),payload:{kind:"direct",member_ids:["role_designer"]}})).json().chat.id;
  await expect(invoke("architect","taskflow_chat_send",{to:"Designer",chat_id:chat,text:"Чужой чат"})).rejects.toThrow();
  expect(messages(chat)).toHaveLength(0);
});

it("nested questions across personal chats keep the hop limit",async()=>{
  let sent=await invoke("architect","taskflow_chat_send",{to:"QA",text:"Уточни формат"});
  let sender="qa";
  const next={qa:"researcher",researcher:"architect",architect:"qa"} as Record<string,string>;
  for(let i=0;i<4;i++){
    const tool=chatTools(sender,{chatId:sent.chat_id,messageId:sent.id}).find(t=>t.name==="taskflow_chat_send")!;
    sent=JSON.parse((await tool.execute("nested",{to:next[sender],text:"Следующее уточнение"}) as any).content[0].text);
    sender=next[sender];
  }
  const tool=chatTools(sender,{chatId:sent.chat_id,messageId:sent.id}).find(t=>t.name==="taskflow_chat_send")!;
  await expect(tool.execute("too-deep",{to:next[sender],text:"Ещё уточнение"})).rejects.toThrow("Лимит цепочки");
});
