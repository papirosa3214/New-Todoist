import {beforeAll,it,expect} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {
  openBudgetCase,
  updateBudgetCase,
  safelyCaptureBudgetCases,
  budgetContinuationPrompt,
} from "../src/runtime/chatBudgetCases.js";

beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});

it("карточка разбора открывается и считает расход",()=>{
  const id="case-"+Math.random().toString(36).slice(2);
  openBudgetCase({id,chatId:"chat-1",roleId:"role_builder",itemId:"item-1",title:"Первый пункт",used:100,base:100,total:150});
  const row=db.prepare("SELECT * FROM chat_budget_cases WHERE id=?").get(id) as any;
  expect(row.used).toBe(100);expect(row.base).toBe(100);expect(row.total).toBe(150);expect(row.materials).toBe(0);
  updateBudgetCase(id,101);
  expect((db.prepare("SELECT used FROM chat_budget_cases WHERE id=?").get(id) as any).used).toBe(101);
});

it("материалы хода ложатся в приватную карточку",()=>{
  const id="case-"+Math.random().toString(36).slice(2);
  openBudgetCase({id,chatId:"chat-2",roleId:"role_critic",itemId:"item-2",title:"Второй пункт",used:100,base:100,total:150});
  safelyCaptureBudgetCases("chat-2","role_critic",{sessionFile:"/tmp/session.jsonl",systemPrompt:"Ты критик",events:[{n:1}],error:{code:"CHAT_ACTION_BUDGET",message:"исчерпано"}});
  const row=db.prepare("SELECT * FROM chat_budget_cases WHERE id=?").get(id) as any;
  expect(row.materials).toBe(1);
  expect(row.session_file).toBe("/tmp/session.jsonl");
  expect(row.system_prompt).toBe("Ты критик");
  expect(JSON.parse(row.events)).toEqual([{n:1}]);
  expect(row.error).toContain("CHAT_ACTION_BUDGET");
});

it("продолжение собирает промпт из карточки разбора",()=>{
  const id="case-"+Math.random().toString(36).slice(2);
  openBudgetCase({id,chatId:"chat-3",roleId:"role_builder",itemId:"item-3",title:"Третий пункт",used:100,base:100,total:150});
  const prompt=budgetContinuationPrompt("chat-3","role_builder");
  expect(prompt).toContain("Третий пункт");
  expect(prompt).toContain(id);
});

it("продолжения без карточки разбора нет",()=>{
  expect(budgetContinuationPrompt("chat-none","role_none")).toBeNull();
});

it("сохранение материалов без карточки не бросает",()=>{
  expect(()=>safelyCaptureBudgetCases("chat-none","role_none",{events:[]})).not.toThrow();
});