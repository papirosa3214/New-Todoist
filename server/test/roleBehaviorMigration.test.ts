import crypto from "node:crypto";
import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {splitRoleBehavior,migrateRoleBehavior} from "../scripts/split-role-behavior.js";
import {builtInBehaviorTemplates} from "../src/runtime/roleBehaviorCatalog.js";
describe("разделение без потери правил",()=>{
 it("у секретаря характер отделён от выполнения работы",()=>{
 const source="# Среда\nПути\n\n## Роль\nХарактер\n\n### 5. ИНТЕЛЛЕКТ И КОМПЕТЕНТНОСТЬ\nНе выдумывай.\n\n### 6. ИНИЦИАТИВНОСТЬ\nПроверяй действие.\n\n### 7. ЭМОЦИОНАЛЬНЫЕ РЕАКЦИИ\nШутки.\n\n## Работа с владельцем\nЖди receipt.\n";
 const result=splitRoleBehavior("secretary",source);
 expect(result.persona).toContain("Характер");expect(result.persona).toContain("Шутки.");
 expect(result.agents).not.toContain("Шутки.");expect(result.agents).toContain("Не выдумывай.");expect(result.agents).toContain("Проверяй действие.");expect(result.agents).toContain("Жди receipt.");expect(result.persona).not.toContain("Жди receipt.");
 });
 it("технические инструкции QA остаются независимо от выбранной личности",()=>{
 const source="# QA\n\n## Роль\n\nТы проверяешь продукт ТОЛЬКО живьём.\nКод не правишь.\n";
 const result=splitRoleBehavior("qa",source);
 expect(result.agents).toContain("ТОЛЬКО живьём");expect(result.agents).toContain("Код не правишь.");expect(result.persona).not.toContain("Код не правишь.");
 });
 it.each(["secretary","analyst","architect","builder","critic_verifier","designer","infra_engineer","qa","researcher","code_orchestrator","claude_code","custom_role"])("%s: три разных поведения, стабильные id",role=>{
 const rows=builtInBehaviorTemplates(role);expect(rows).toHaveLength(3);expect(new Set(rows.map(r=>r.text)).size).toBe(3);expect(new Set(rows.map(r=>r.id)).size).toBe(3);expect(rows.every(r=>r.builtin&&r.name&&r.text.length>90)).toBe(true);
 });
});

describe("перенос на диске",()=>{
 it("сохраняет исходник до записи и повторно не меняет документы",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"behavior-migration-"));
  try {
   const dir=path.join(root,"analyst");fs.mkdirSync(dir);
   const source="# Среда\n\n## Роль\nТы аналитик, проверяешь цифры инструментами.\n";
   fs.writeFileSync(path.join(dir,"AGENTS.md"),source);
   expect(migrateRoleBehavior(root,false)[0].status).toBe("preview");
   expect(fs.existsSync(path.join(dir,"ROLE.md"))).toBe(false);
   migrateRoleBehavior(root,true);
   const marker=JSON.parse(fs.readFileSync(path.join(dir,".behavior-split.json"),"utf8"));
   expect(fs.readFileSync(path.join(dir,marker.backup),"utf8")).toBe(source);
   const after=fs.readFileSync(path.join(dir,"AGENTS.md"),"utf8");
   expect(migrateRoleBehavior(root,true)[0].status).toBe("already_split");
   expect(fs.readFileSync(path.join(dir,"AGENTS.md"),"utf8")).toBe(after);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
 });
 it("существующая личность не перезаписывается",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"behavior-preserve-"));
 try {
  const dir=path.join(root,"builder");fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"AGENTS.md"),"Инструкции");fs.writeFileSync(path.join(dir,"ROLE.md"),"Мой характер");
  expect(()=>migrateRoleBehavior(root,true)).toThrow("уже существует");
  expect(fs.readFileSync(path.join(dir,"ROLE.md"),"utf8")).toBe("Мой характер");
  expect(fs.readFileSync(path.join(dir,"AGENTS.md"),"utf8")).toBe("Инструкции");
 } finally {fs.rmSync(root,{recursive:true,force:true});}
 });
});


it("продолжает перенос после записи ROLE до AGENTS",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"behavior-resume-"));
 try {
  const dir=path.join(root,"builder");fs.mkdirSync(dir);
  const source="# Среда\n\n## Роль\nТы реализуешь согласованное изменение в коде проекта.\nПравило.\n";
  const result=splitRoleBehavior("builder",source);
  const hash=crypto.createHash("sha256").update(source).digest("hex");
  fs.writeFileSync(path.join(dir,"AGENTS.md"),source);
  fs.writeFileSync(path.join(dir,"ROLE.md"),result.persona);
  fs.writeFileSync(path.join(dir,".behavior-split.pending.json"),JSON.stringify({source,...result,hash}));
  expect(migrateRoleBehavior(root,true)[0].status).toBe("split");
  expect(fs.readFileSync(path.join(dir,"AGENTS.md"),"utf8")).toBe(result.agents);
  expect(fs.existsSync(path.join(dir,".behavior-split.pending.json"))).toBe(false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

