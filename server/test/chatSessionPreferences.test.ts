import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {piRuntime} from "../src/runtime/PiRuntimeAdapter.js";
import {supportedThinkingLevels, validateChatThinking, thinkingLevelLabels} from "../src/runtime/thinkingLevels.js";
import {readChatPreferences, snapshotChatPreferences, messageThinkingLevel} from "../src/lib/chatSessionPreferences.js";

describe("assistant session preferences",()=>{
 let app:Awaited<ReturnType<typeof buildApp>>;
 const catalog=[{id:"flex",provider:"test",available:true,thinking:true,thinkingLevels:["off","low","high"]},
 {id:"always",provider:"test",available:true,thinking:true,thinkingLevels:["medium","high"]}];
 const auth=()=>({authorization:"Bearer "+app.jwt.sign({id:"u1"})});
 beforeAll(async()=>{
  app=await buildApp();
  vi.spyOn(piRuntime,"listModels").mockResolvedValue(catalog as any);
  for(const id of ["session-a","session-b"]){
   db.prepare("INSERT INTO chats(id,kind,created_by) VALUES (?,'direct','u1')").run(id);
   for(const member of ["u1","u-secretary"])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?)").run(id,member);
  }
 });
 afterAll(async()=>{vi.restoreAllMocks();await app.close();});
 const put=(id:string,payload:any)=>app.inject({method:"PUT",url:"/api/chats/"+id+"/session-preferences",headers:auth(),payload});
 it("uses the installed provider capability map, including absence of off",async()=>{
  expect(await supportedThinkingLevels({reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:null,medium:"medium",high:"high",xhigh:null,max:null}})).toEqual(["medium","high"]);
  expect(await supportedThinkingLevels({reasoning:false})).toEqual(["off"]);
 });
 it("never clamps a user choice to a more expensive level",async()=>{
  await expect(validateChatThinking({reasoning:true,thinkingLevelMap:{off:null}},"off")).rejects.toThrow();
  expect(await validateChatThinking({reasoning:true},"low")).toBe("low");
 });
 it("persists settings only in the intended session",async()=>{
  const response=await put("session-a",{model:"test/flex",thinkingLevel:"off"});
  expect(response.statusCode).toBe(200);
  expect(readChatPreferences("session-a")).toMatchObject({model:"test/flex",thinkingLevel:"off",configured:true});
  expect(readChatPreferences("session-b")).toMatchObject({model:null,thinkingLevel:null,configured:false});
 });
 it("rejects unsupported levels instead of pretending to disable thinking",async()=>{
  expect((await put("session-a",{model:"test/always",thinkingLevel:"off"})).statusCode).toBe(400);
  expect(readChatPreferences("session-a").model).toBe("test/flex");
 });
 it("snapshots the accepted message independently of later settings",async()=>{
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES ('session-message','session-a','u1','hello','chat')").run();
  snapshotChatPreferences("session-message","session-a",null);
  await put("session-a",{model:"test/flex",thinkingLevel:"high"});
  expect(messageThinkingLevel("session-message")).toBe("off");
  expect((db.prepare("SELECT model FROM chat_messages WHERE id='session-message'").get() as any).model).toBe("test/flex");
 });
 it("switching the model clears an incompatible previous effort",async()=>{
  await put("session-a",{model:"test/flex",thinkingLevel:"low"});
  expect((await put("session-a",{model:"test/always"})).statusCode).toBe(200);
  expect(readChatPreferences("session-a").thinkingLevel).toBeNull();
 });
 it("the assistant itself cannot change the owner session budget settings",async()=>{
  const response=await app.inject({method:"PUT",url:"/api/chats/session-a/session-preferences",headers:{authorization:"Bearer "+app.jwt.sign({id:"u-secretary"})},payload:{model:null}});
  expect(response.statusCode).toBe(403);
 });
 it("checks membership and requires the owner",async()=>{
  const r=await app.inject({method:"PUT",url:"/api/chats/session-a/session-preferences",headers:{authorization:"Bearer "+app.jwt.sign({id:"role_builder"})},payload:{model:null}});
  expect(r.statusCode).toBe(403);
 });

 it("does not advertise false off for Ollama; provider none remains selectable",async()=>{
  const levels=await supportedThinkingLevels({api:"openai-completions",provider:"ollama",reasoning:true,thinkingLevelMap:{minimal:"none"},compat:{thinkingFormat:"qwen",supportsReasoningEffort:true}});
  expect(levels).not.toContain("off");
  expect(levels).toContain("minimal");
  expect(thinkingLevelLabels({thinkingLevelMap:{minimal:"none"}})).toEqual({minimal:"Выключены"});
 });
 it("retains a compatible level when switching models",async()=>{
  await put("session-a",{model:"test/flex",thinkingLevel:"high"});
  await put("session-a",{model:"test/always"});
  expect(readChatPreferences("session-a").thinkingLevel).toBe("high");
 });
 it("HTTP acceptance records the session settings before later changes",async()=>{
  await put("session-b",{model:"test/flex",thinkingLevel:"off"});
  const response=await app.inject({method:"POST",url:"/api/chats/session-b/messages",headers:auth(),payload:{text:"Snapshot request"}});
  expect(response.statusCode).toBe(200);
  const id=response.json().message.id;
  await put("session-b",{model:"test/flex",thinkingLevel:"high"});
  expect(messageThinkingLevel(id)).toBe("off");
  expect((db.prepare("SELECT model FROM chat_messages WHERE id=?").get(id) as any).model).toBe("test/flex");
 });
 it("compaction uses the selected session model and thinking level",async()=>{
  await put("session-b",{model:"test/flex",thinkingLevel:"low"});
  db.prepare("INSERT OR REPLACE INTO chat_sessions(chat_id,role_id,pi_session_id) VALUES ('session-b','u-secretary','saved-session')").run();
  const runtime=await import("../src/runtime/PiRuntimeAdapter.js");
  const spy=vi.spyOn(runtime,"startChatRun").mockResolvedValue({sessionId:"saved-session",text:""} as any);
  try{
   const response=await app.inject({method:"POST",url:"/api/chats/session-b/compact",headers:auth(),payload:{role_id:"u-secretary"}});
   expect(response.statusCode).toBe(200);
   expect(spy).toHaveBeenCalledWith(expect.objectContaining({model:"test/flex",thinkingLevel:"low",compactOnly:true}));
  }finally{spy.mockRestore();}
 });
});
