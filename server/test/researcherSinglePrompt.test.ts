// Исследователь (владелец 05.11.2026): в текстовом чате — только сжатая
// инструкция из scripts/researcher-chat-system.md, как у Помощника.
import {it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {chatSystemPrompt,createTaskResourceLoader} from "../src/runtime/instructionResources.js";
import {ensureRoleHome} from "../src/runtime/roleHome.js";
import {chatTurnSystemText,projectSecretarySystem,installSecretarySystem} from "../src/runtime/secretaryChatPrompt.js";
const expected=fs.readFileSync(new URL("../scripts/researcher-chat-system.md",import.meta.url),"utf8");
it("researcher text chat uses only its compressed file, without AGENTS.md, canon or skills",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"researcher-single-"));const old=process.env.TASKFLOW_ROLES_DIR;process.env.TASKFLOW_ROLES_DIR=root;
 try{
  const home=ensureRoleHome("researcher");fs.writeFileSync(home.agents,"OLD_AGENTS_SENTINEL");
  const prompt=await chatSystemPrompt("researcher","work",home.workspace);
  expect(prompt).toBe(expected);
  expect(chatTurnSystemText("researcher",prompt,["SERVER_RULES"])).toBe(expected);
  const loader=await createTaskResourceLoader("researcher",home.workspace,prompt,undefined,true);
  try{expect(loader.getSystemPrompt()).toBe(expected);expect(loader.getAgentsFiles().agentsFiles).toHaveLength(0);expect(loader.getSkills().skills).toHaveLength(0);}
  finally{loader.disposeResources?.();}
 }finally{if(old===undefined)delete process.env.TASKFLOW_ROLES_DIR;else process.env.TASKFLOW_ROLES_DIR=old;fs.rmSync(root,{recursive:true,force:true});}
});
it("old system messages of a resumed researcher session are replaced by the file",async()=>{
 const session:any={agent:{}};
 installSecretarySystem(session,"researcher",expected);
 const projected=await session.agent.transformContext([{role:"system",content:"OLD_CANON"},{role:"user",content:"q"}]);
 expect(projected.filter((m:any)=>m.role==="system").map((m:any)=>m.content)).toEqual([expected]);
 expect(projectSecretarySystem([{role:"user",content:"q"}],expected)[0].content).toBe(expected);
});
it("other roles keep their assembled instruction",()=>{
 expect(chatTurnSystemText("builder","BASE",["RULES"])).toBe("BASE\n\nRULES");
});
