import {afterAll,beforeAll,describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {ROLE_NAMES} from "../src/roleRouting.js";
import {ensureRoleHome,renderPromptAddendum} from "../src/runtime/roleHome.js";
import {chatSystemPrompt,discoverChatResources} from "../src/runtime/instructionResources.js";
import {validateStructuredRoleContractV1} from "../src/lib/roleContractV1.js";

const previous=process.env.TASKFLOW_ROLES_DIR;
const root=fs.mkdtempSync(path.join(os.tmpdir(),"taskflow-shared-report-"));
beforeAll(()=>{migrate();runMigrations();process.env.TASKFLOW_ROLES_DIR=root;});
afterAll(()=>{if(previous===undefined)delete process.env.TASKFLOW_ROLES_DIR;else process.env.TASKFLOW_ROLES_DIR=previous;fs.rmSync(root,{recursive:true,force:true});});

describe("общий отчёт о выполненной работе в чате",()=>{
 it("подаёт правило всем ролям в системной инструкции, независимо от первого сообщения",async()=>{
  for(const role of ROLE_NAMES){
   const home=ensureRoleHome(role);
   const prompt=await chatSystemPrompt(role,"work",home.workspace);
   expect(prompt,role).toContain("Итог выполненной работы в чате");
   expect(prompt,role).toContain("report_kind");
   expect(prompt,role).toContain("materials");
   expect(prompt,role).toContain("note://");
   // Ordinary conversation must not be forced into a completion report.
   expect(prompt,role).toContain("Обычный ответ на вопрос");
  }
 });
 it("обнаруживает один общий навык у каждой роли без копирования в её папку",async()=>{
  for(const role of ROLE_NAMES){
   const home=ensureRoleHome(role);
   expect(fs.existsSync(path.join(home.skills,"chat-report-format","SKILL.md"))).toBe(false);
   const found=(await discoverChatResources(role,true)).skills.filter(s=>s.name==="chat-report-format");
   expect(found,role).toHaveLength(1);
   expect(found[0].filePath).toContain("shared-skills");
  }
 });
 it("пример из общего навыка проходит настоящий валидатор ответа",async()=>{
  const skill=(await discoverChatResources("builder",true)).skills.find(s=>s.name==="chat-report-format");
  expect(skill).toBeDefined();
  const body=fs.readFileSync(skill!.filePath,"utf8");
  const example=JSON.parse(/\`\`\`json\n([\s\S]*?)\n\`\`\`/.exec(body)![1]);
  expect(validateStructuredRoleContractV1({schema_version:1,ok:true,output:[example],artifacts:[],plan_artifact:null,error:null,next_hint:null}).valid).toBe(true);
 });
 it("не навязывает чатовый отчёт карточному канону",()=>{
  const home=ensureRoleHome("builder");
  expect(renderPromptAddendum("task","builder",home)).not.toContain("Итог выполненной работы в чате");
 });
});

import {normalizeRoleReplyV1} from "../src/lib/roleContractV1.js";
import {formatChatMessage} from "../src/lib/chatMessages.js";

function reportEnvelope(extra=false){
 const material={kind:"document",title:"Отчёт",ref:"note://eefd13a2-c809-4840-a4c3-17f8051b818d"};
 return {schema_version:1,ok:true,output:[{type:"report",report_kind:"final",sections:{
  result:[{type:"text",text:"Сделано"}],work:[],checks:[],limitations:[],materials:[material],
 }}],artifacts:[{...material,title:"Тот же документ под другим названием"},...(extra?[{kind:"log",title:"Уникальный журнал",ref:"https://example.test/log"}]:[])],plan_artifact:null,error:null,next_hint:null,needs_human:false};
}
it("готовый чатовый отчёт не повторяет свои материалы под отчётом",()=>{
 const source=reportEnvelope();
 const result=normalizeRoleReplyV1(JSON.stringify(source));
 expect(result.envelope.artifacts).toEqual([]);
 expect((result.envelope.output[0].sections as any).materials).toEqual(source.output[0].sections.materials);
 expect(source.artifacts).toHaveLength(1);
});
it("история и WebSocket выдают тот же отчёт без повторной секции материалов",()=>{
 const source=reportEnvelope(true);
 const message=formatChatMessage({id:"report-duplicate-fixture",text:"Сделано",role_envelope_json:JSON.stringify(source)});
 expect(message.role_envelope.artifacts).toEqual([]);
 expect(message.role_envelope.output[0].sections.materials).toEqual([...source.output[0].sections.materials,{kind:"log",title:"Уникальный журнал",ref:"https://example.test/log"}]);
});

import {externalAgentBoost} from "../src/runtime/externalAgentActions.js";
it("внешний агент тоже получает общий формат итога в чате",()=>{
 const prompt=externalAgentBoost("Внешний агент",[],"chat");
 expect(prompt).toContain("Итог выполненной работы в чате");
 expect(prompt).toContain("schema_version");
 expect(externalAgentBoost("Внешний агент",[],"card")).not.toContain("Итог выполненной работы в чате");
});
