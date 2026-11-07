// Каналы правил: card-only не попадает в чат, chat-only — в карточку; канал чата = chatExecutionMode.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { rulesFor, loadRoleRules } from "../src/lib/roleRules.js";
import { chatSystemPrompt } from "../src/runtime/instructionResources.js";
import { roleInstructionText, roleHome, ensureRoleHome } from "../src/runtime/roleHome.js";

migrate(); runMigrations();
let dir: string, rulesPath: string; const prev = { r: process.env.TASKFLOW_ROLES_DIR, f: process.env.TASKFLOW_ROLE_RULES };
const rule = (id: string, text: string, channels: string[]) => ({ id, text, kind: "rule", category: "общий шаблон", roles: "all", where: "", channels, sources: [{ file: "x", line: 1, section: "Тест > Раздел" }] });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "regch-"));
  process.env.TASKFLOW_ROLES_DIR = dir;
  rulesPath = path.join(dir, "rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify([
    rule("T1", "ТОЛЬКО-КАРТОЧКА-777", ["card"]), rule("T2", "ТОЛЬКО-ЧАТ-888", ["chat"]), rule("T3", "ВСЕГДА-999", ["chat", "card", "voice"]), rule("T4", "ТОЛЬКО-ГОЛОС-555", ["voice"]),
  ]));
  process.env.TASKFLOW_ROLE_RULES = rulesPath;
  ensureRoleHome("builder");
});
afterEach(() => {
  for (const [k, v] of [["TASKFLOW_ROLES_DIR", prev.r], ["TASKFLOW_ROLE_RULES", prev.f]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(dir, { recursive: true, force: true });
});
const texts = (ch: any) => rulesFor("builder", ch).map((r) => r.text);

it("rulesFor: правило только card не идёт в чат, только chat — в карточку", () => {
  expect(texts("chat")).toEqual(["ТОЛЬКО-ЧАТ-888", "ВСЕГДА-999"]);
  expect(texts("card")).toEqual(["ТОЛЬКО-КАРТОЧКА-777", "ВСЕГДА-999"]);
  expect(texts("voice")).toEqual(["ВСЕГДА-999", "ТОЛЬКО-ГОЛОС-555"].sort((a, b) => texts("voice").indexOf(a) - texts("voice").indexOf(b)));
});
it("старое имя канала text читается как chat", () => {
  fs.writeFileSync(rulesPath, JSON.stringify([rule("T9", "СТАРЫЙ-КАНАЛ", ["text"])]));
  expect(texts("chat")).toEqual(["СТАРЫЙ-КАНАЛ"]);
});
it("чат без задачи собирается на канале chat, чат с задачей — на card; карточка — card", async () => {
  const plain = crypto.randomUUID(), tasked = crypto.randomUUID();
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(plain);
  db.prepare("INSERT INTO chats(id,kind,created_by,task_id) VALUES(?,'group','u1','task-x')").run(tasked);
  const cwd = roleHome("builder").workspace;
  const chatText = await chatSystemPrompt("builder", "work", cwd, plain);
  expect(chatText).toContain("ТОЛЬКО-ЧАТ-888"); expect(chatText).not.toContain("ТОЛЬКО-КАРТОЧКА-777");
  const cardChat = await chatSystemPrompt("builder", "work", cwd, tasked);
  expect(cardChat).toContain("ТОЛЬКО-КАРТОЧКА-777"); expect(cardChat).not.toContain("ТОЛЬКО-ЧАТ-888");
  const card = roleInstructionText("builder");
  expect(card).toContain("ТОЛЬКО-КАРТОЧКА-777"); expect(card).not.toContain("ТОЛЬКО-ЧАТ-888");
  const voice = roleInstructionText("builder", { channel: "voice" });
  expect(voice).toContain("ТОЛЬКО-ГОЛОС-555"); expect(voice).not.toContain("ТОЛЬКО-КАРТОЧКА-777");
  db.pragma("foreign_keys = ON");
});
it("боевой реестр: каналы вписаны, правил только card и только chat достаточно", () => {
  delete process.env.TASKFLOW_ROLE_RULES;
  const rules = loadRoleRules();
  const cardOnly = rules.filter((r) => r.channels!.length === 1 && r.channels![0] === "card");
  const chatOnly = rules.filter((r) => r.channels!.length === 1 && r.channels![0] === "chat");
  expect(cardOnly.length).toBeGreaterThanOrEqual(50); expect(chatOnly.length).toBeGreaterThanOrEqual(30);
  const id = cardOnly.find((r) => r.category === "общий шаблон")!.id;
  expect(rulesFor("builder", "chat").some((r) => r.id === id)).toBe(false);
  expect(rules.every((r) => !(r.channels as string[]).includes("text"))).toBe(true);
});

it("голос secretary: без правил про git/тесты/код/карточки, есть делегирование; характер secretary — в голосе", () => {
  delete process.env.TASKFLOW_ROLE_RULES;
  const voice = rulesFor("secretary", "voice");
  const joined = voice.map((r) => r.text).join("\n");
  expect(joined).not.toMatch(/\bgit\b|коммит|vitest|\bтест|push|pull request|чек-лист|taskflow_subtask|taskflow_claim/i);
  expect(voice.some((r) => /звать|делег/.test(r.text))).toBe(true);
  expect(voice.some((r) => r.category === "характер")).toBe(true);
  // из «all» в голос попало немного: основной объём — chat+card
  expect(voice.length).toBeLessThan(70);
  // Делегирование — общий шаблон v2 (07.11.2026).
  expect(voice.map((r) => r.id)).toEqual(expect.arrayContaining(["C18", "R523"]));
  const chat = rulesFor("secretary", "chat").length;
  expect(chat).toBeGreaterThan(voice.length);
});

it("R321 и R396 (раньше только voice) попадают и в голос, и в чат/карточку своих ролей", () => {
  delete process.env.TASKFLOW_ROLE_RULES;
  for (const [id, role] of [["R321", "builder"], ["R396", "infra_engineer"]]) {
    for (const ch of ["voice", "chat", "card"] as const) expect(rulesFor(role, ch).some((r) => r.id === id), id + "/" + ch).toBe(true);
  }
});
