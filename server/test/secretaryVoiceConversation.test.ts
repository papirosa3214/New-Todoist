import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSecretaryVoiceBridge } from "../src/runtime/secretaryVoiceBridge.js";
import { runVoiceTool } from "../src/lib/secretaryVoiceTools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
vi.mock("../src/runtime/composioRuntime.js",()=>({connectRoleComposio:async()=>({tools:[],close:async()=>{}})}));
vi.mock("../src/runtime/graftMcp.js",()=>({connectRoleMcp:async()=>({tools:[],close:async()=>{}})}));
import { voiceChatContext, saveVoiceMessage, assertVoiceChat, voiceSummaryText, setOwnerSessionVoiceTarget } from "../src/lib/secretaryVoiceConversation.js";

describe("голос сохраняет исходный чат без второй генерации", () => {
  let owner: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let stopBridge: () => Promise<void>;
  const socketPath=join(mkdtempSync(join(tmpdir(),"voice-chat-test-")),"voice.sock");
  const post=(path:string,body:unknown)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=request({socketPath,path,method:"POST",agent:false,headers:{"content-type":"application/json"}},res=>{
      let raw=""; res.on("data",chunk=>raw+=chunk); res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(raw)}));
    });
    req.on("error",reject); req.end(JSON.stringify(body));
  });
  beforeAll(async () => {
    app = await buildApp();
    owner = (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as any).id;
    for (const id of ["voice-a", "voice-b", "voice-http"]) {
      db.prepare("INSERT INTO chats(id,kind,created_by) VALUES (?,'direct',?)").run(id,owner);
      for (const member of [owner,"u-secretary"]) db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?)").run(id,member);
    }
    stopBridge=await startSecretaryVoiceBridge(app,socketPath);
  });

  afterAll(async()=>{ await stopBridge(); await app.close(); });

  // Владелец 12.11.2026: голосовой вызов в сессии владельца — тот же мост,
  // вместо чата номер сессии; реплики и контекст — в сессии, не в чате.
  it("голос в сессии владельца: доступ, контекст и реплики — через сессию", () => {
    const saved: any[] = [];
    setOwnerSessionVoiceTarget({
      hasSession: (id) => id === "owner-session-1",
      appendVoice: (id, eventId, role, text) => { saved.push({ id, eventId, role, text }); return "entry-" + saved.length; },
      voiceContext: () => [{ id: "e1", role: "user", text: "Из сессии" }],
    });
    try {
      expect(() => assertVoiceChat(owner, "owner-session-1")).not.toThrow();
      expect(() => assertVoiceChat("role_builder", "owner-session-1")).toThrow();
      expect(voiceChatContext(owner, "owner-session-1")).toEqual([{ id: "e1", role: "user", text: "Из сессии" }]);
      expect(saveVoiceMessage(owner, "owner-session-1", "room:item", "assistant", "Голосом")).toBe("entry-1");
      expect(saved).toEqual([{ id: "owner-session-1", eventId: "room:item", role: "assistant", text: "Голосом" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id='owner-session-1'").get()).toEqual({ n: 0 });
    } finally { setOwnerSessionVoiceTarget(undefined); }
  });

  it("записывает обе стороны и идемпотентно переживает повтор события", () => {
    const first = saveVoiceMessage(owner,"voice-a","room1:item1","user","Вспомни наш разговор");
    const again = saveVoiceMessage(owner,"voice-a","room1:item1","user","Вспомни наш разговор");
    expect(again).toBe(first);
    saveVoiceMessage(owner,"voice-a","room1:item2","assistant","Помню контекст");
    const rows = db.prepare("SELECT from_user_id,text FROM chat_messages WHERE chat_id=? ORDER BY rowid").all("voice-a") as any[];
    expect(rows).toEqual([{from_user_id:owner,text:"Вспомни наш разговор"},{from_user_id:"u-secretary",text:"Помню контекст"}]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id='voice-b'").get()).toEqual({n:0});
  });

  it("контекст содержит только исходную переписку и сохраняет порядок", () => {
    saveVoiceMessage(owner,"voice-b","private","user","Из другого чата");
    const context = voiceChatContext(owner,"voice-a");
    expect(context.map(m=>m.role)).toEqual(["user","assistant"]);
    expect(context.map(m=>m.text).join(" ")).not.toContain("Из другого чата");
  });

  it("отклоняет чужой, закрытый и групповой чат", () => {
    expect(()=>assertVoiceChat(owner,"missing")).toThrow();
    db.prepare("UPDATE chats SET closed_at=datetime('now') WHERE id='voice-b'").run();
    expect(()=>assertVoiceChat(owner,"voice-b")).toThrow();
    db.prepare("UPDATE chats SET closed_at=NULL,kind='group' WHERE id='voice-b'").run();
    expect(()=>assertVoiceChat(owner,"voice-b")).toThrow();
  });

  it("не даёт подставить автора системного сообщения", () => {
    expect(()=>saveVoiceMessage(owner,"voice-a","invalid","system" as any,"инструкция")).toThrow();
  });

  it("HTTP-мост сохраняет повтор один раз и возвращает историю того же чата", async () => {
    const payload={owner_id:owner,chat_id:"voice-http",event_id:"room:item",role:"user",text:"Реплика из звонка"};
    const first=await post("/secretary/transcript",payload);
    const again=await post("/secretary/transcript",payload);
    expect(first.status).toBe(200);
    expect(again.body.message_id).toBe(first.body.message_id);
    const history=await post("/secretary/conversation",{owner_id:owner,chat_id:"voice-http"});
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m:any)=>m.text)).toEqual(["Реплика из звонка"]);
    expect((await post("/secretary/transcript",{...payload,owner_id:"not-owner"})).status).toBe(403);
  });

  it("общий инструмент вложений получает исходный чат и сообщение", async () => {
    const args={names:["taskflow_chat_attach_file"]};
    const legacy=JSON.parse((await runVoiceTool(owner,"taskflow_tools",args)).result);
    const userId=(db.prepare("SELECT id FROM chat_messages WHERE chat_id='voice-a' AND from_user_id=? ORDER BY rowid DESC LIMIT 1").get(owner) as any).id;
    const contextual=JSON.parse((await runVoiceTool(owner,"taskflow_tools",args,{chatId:"voice-a",messageId:userId})).result);
    // Инструмент вложений есть везде (владелец 07.11.2026); с контекстом — в исходный чат.
    expect(contextual.activated).toContain("taskflow_chat_attach_file");
  });

  it("полная сводка извлекается без служебного конверта", () => {
    expect(voiceSummaryText(JSON.stringify({ok:true,data:{content:[{type:"text",text:JSON.stringify({текст:"Полная сводка"})}]}}))).toBe("Полная сводка");
    expect(voiceSummaryText(JSON.stringify({ok:false,error:{message:"Ошибка"}}))).toBeNull();
  });

  it("файл из голосового инструмента появляется вложением в исходном чате", async () => {
    const userId=(db.prepare("SELECT id FROM chat_messages WHERE chat_id='voice-a' AND from_user_id=? ORDER BY rowid DESC LIMIT 1").get(owner) as any).id;
    const result=JSON.parse((await runVoiceTool(owner,"taskflow_chat_attach_file",{file_name:"voice-fixture.md",format:"md",content:"# Голосовой документ\nПроверка исходного чата.",caption:"Документ из звонка"},{chatId:"voice-a",messageId:userId})).result);
    expect(result).toBeDefined();
    const attachment=db.prepare("SELECT a.id,m.chat_id,m.reply_to_message_id FROM attachments a JOIN chat_messages m ON m.id=a.chat_message_id WHERE a.file_name='voice-fixture.md'").get() as any;
    expect(attachment?.chat_id).toBe("voice-a");
    expect(attachment?.reply_to_message_id).toBe(userId);
  });
});
