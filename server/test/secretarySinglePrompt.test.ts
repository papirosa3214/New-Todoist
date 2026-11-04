import {it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {chatSystemPrompt,createTaskResourceLoader} from "../src/runtime/instructionResources.js";
import {ensureRoleHome} from "../src/runtime/roleHome.js";
const expected=fs.readFileSync(new URL("../scripts/secretary-chat-system.md",import.meta.url),"utf8");
it("secretary text chat uses only the owner selected file, with no role or SDK resources appended",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"secretary-single-"));const old=process.env.TASKFLOW_ROLES_DIR;process.env.TASKFLOW_ROLES_DIR=root;
 try{
  const home=ensureRoleHome("secretary");fs.writeFileSync(home.agents,"OLD_AGENTS_SENTINEL");fs.writeFileSync(home.role,"OLD_PERSONA_SENTINEL");
  const prompt=await chatSystemPrompt("secretary","work",home.workspace);
  expect(prompt).toBe(expected);
  const loader=await createTaskResourceLoader("secretary",home.workspace,prompt,undefined,true);
  try{expect(loader.getSystemPrompt()).toBe(expected);expect(loader.getSkills().skills).toHaveLength(0);expect(loader.getAgentsFiles().agentsFiles).toHaveLength(0);expect(loader.getAppendSystemPrompt()).toHaveLength(0);}finally{loader.disposeResources();}
 }finally{if(old===undefined)delete process.env.TASKFLOW_ROLES_DIR;else process.env.TASKFLOW_ROLES_DIR=old;fs.rmSync(root,{recursive:true,force:true});}
});


it("removes resumed and incremental system instructions while preserving tool changes and conversation",async()=>{
 const {projectSecretarySystem,chatTurnSystemText,secretaryChatInput}=await import("../src/runtime/secretaryChatPrompt.js");
 const history=[{role:"system",content:"OLD_CANON",toolsAdded:[{name:"read"},{name:"old"}]},
  {role:"user",content:"question"},
  {role:"system",sections:{addendum:"SERVER_RULES"},toolsRemoved:["old"],toolsAdded:[{name:"new"}]},
  {role:"assistant",content:"answer"}];
 const projected=projectSecretarySystem(history,expected);
 expect(projected.filter(m=>m.role==="system")).toHaveLength(1);
 expect(projected[0].content).toBe(expected);
 expect(projected[0].toolsAdded.map((t:any)=>t.name)).toEqual(["read","new"]);
 expect(projected.slice(1)).toEqual([history[1],history[3]]);
 expect(chatTurnSystemText("secretary",expected,["SERVER_RULES"])).toBe(expected);
 expect(chatTurnSystemText("builder","BASE",["RULES"])).toBe("BASE\n\nRULES");
 expect(JSON.parse(secretaryChatInput({history:"old messages",userText:"new message",roleInstruction:"OLD_SERVER_RULES"}))).toEqual({participants:"",history:"old messages",message:"new message"});
});
it("actual SDK sends exactly the selected prompt on first and next request, including an old resumed system",async()=>{
 const {createAgentSession,ModelRuntime,SessionManager,SettingsManager,createReadToolDefinition}=await import("@earendil-works/pi-coding-agent");
 const {installSecretarySystem}=await import("../src/runtime/secretaryChatPrompt.js");
 const rt=await ModelRuntime.create({refreshOnCreate:false,modelsPath:null});
 const model=rt.getModels()[0];
 rt.hasConfiguredAuth=()=>true;
 rt.getAuth=async()=>({auth:{apiKey:"offline-test"},env:{}}) as any;
 const cwd=os.tmpdir();
 const loader=await createTaskResourceLoader("secretary",cwd,expected,undefined,true);
 const {session}=await createAgentSession({cwd,model,modelRuntime:rt,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),tools:["read"],customTools:[createReadToolDefinition(cwd)],settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})});
 const captures:any[]=[];
 installSecretarySystem(session,"secretary",expected);
 session.agent.streamFunction=(_model,context)=>{captures.push(context);throw new Error("offline boundary");};
 try{
  session.agent.state.messages=[{role:"system",content:"OLD_RESUMED_CANON",timestamp:0,toolsAdded:[]} as any];
  await session.prompt("first");
  await session.prompt("second");
  expect(captures).toHaveLength(2);
  for(const capture of captures){
   const systems=capture.messages.filter((m:any)=>m.role==="system");
   expect(systems).toHaveLength(1);
   expect(systems[0].content).toBe(expected);
   expect(JSON.stringify(capture)).not.toContain("OLD_RESUMED_CANON");
   expect(systems[0].toolsAdded.some((t:any)=>t.name==="read")).toBe(true);
  }
 }finally{session.dispose();loader.disposeResources();}
});
it("project enrichment in data-only mode cannot append the old role and memory policy",async()=>{
 const {roleProjectContext}=await import("../src/runtime/roleProjectContext.js");
 const {vi}=await import("vitest");const memory=await import("../src/lib/memory.js");
 const recall=vi.spyOn(memory,"recall").mockResolvedValue([]);
 try{
  const data=await roleProjectContext({role:"secretary",query:"irrelevant",dataOnly:true});
  expect(data).not.toContain("Память этой роли");
  expect(data).not.toContain("Новая сессия восстанавливает");
  expect(data).not.toContain("не назначай себя");
  expect(data).not.toContain("Читай их через");
 }finally{recall.mockRestore();}
});


it("does not reintroduce secretary instructions through user prefixes or automatic steering",async()=>{
 const {chatUserTurnText,chatRuntimeGuidanceEnabled}=await import("../src/runtime/secretaryChatPrompt.js");
 expect(chatUserTurnText("secretary","OLD_MODE_DIRECTIVE","owner question")).toBe("owner question");
 expect(chatRuntimeGuidanceEnabled("secretary")).toBe(false);
 expect(chatUserTurnText("builder","MODE","question")).toBe("MODE\n\nquestion");
 expect(chatRuntimeGuidanceEnabled("builder")).toBe(true);
});
