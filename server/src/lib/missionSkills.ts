/**
 * Навыки миссии (владелец 01.11.2026).
 *
 * Роль уже умеет писать себе навыки: `roleHome.ts` прямо велит создавать
 * `~/taskflow/roles/<роль>/skills/<имя>/SKILL.md`. И навык, **упомянутый в
 * инструкции этапа**, JEV не выкидывает — `instructionResources.ts` собирает
 * такие имена в `requiredNames` для `selectSkillsByJev`.
 *
 * Чего не хватало: навык, написанный под одну задачу, навсегда оставался в
 * папке роли и влиял на все её будущие задачи. Здесь — реестр навыков миссии
 * и его жизненный цикл: запись → привязка к работе → снятие при закрытии
 * миссии (в архив, не в корзину).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import db from "../db.js";
import { roleHome } from "../runtime/roleHome.js";
import { appendMissionEvent } from "./missionContract.js";

export type MissionSkill = {
  id: string;
  task_id: string;
  role: string;
  name: string;
  description: string;
  body: string | null;
  source_slot: string | null;
  skill_path: string | null;
  created_at: string;
  released_at: string | null;
};

/** Имя навыка: латиница через дефис, как требует SKILL-FORMAT.md. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Куда убираются навыки после закрытия миссии — вне skills/, чтобы Pi их не подхватил. */
const ARCHIVE_ROOT = path.join(os.homedir(), "taskflow", "mission-skills-archive");

export function missionSkills(taskId: string, includeReleased = false): MissionSkill[] {
  const sql = includeReleased
    ? "SELECT * FROM mission_skills WHERE task_id = ? ORDER BY created_at"
    : "SELECT * FROM mission_skills WHERE task_id = ? AND released_at IS NULL ORDER BY created_at";
  return db.prepare(sql).all(taskId) as MissionSkill[];
}

/** Куда физически лег навык. */
export function missionSkillPath(role: string, name: string): string {
  return path.join(roleHome(role).skills, name, "SKILL.md");
}

/** Шапка SKILL.md — JEV читает только её. */
function renderSkill(name: string, description: string, body: string | null): string {
  const descriptionLines = description
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `  ${line}`)
    .join("\n");
  return [
    "---",
    `name: ${name}`,
    "description: >-",
    descriptionLines,
    "---",
    "",
    (body ?? "").trim(),
    "",
  ].join("\n");
}

/**
 * Записать навык миссии: файл в папке роли + запись в реестре миссии.
 * Файл нужен, чтобы Pi SDK подхватил навык; реестр — чтобы знать, чей он
 * и когда его снять.
 */
export function registerMissionSkill(
  taskId: string,
  input: { role: string; name: string; description: string; body?: string | null; sourceSlot?: string | null },
): MissionSkill {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!SKILL_NAME.test(name)) {
    throw new Error(`некорректное имя навыка «${name}» — латиница через дефис, 2–63 символа`);
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("у навыка миссии должно быть описание — JEV выбирает навык только по нему");
  const role = String(input.role ?? "").trim();
  if (!role) throw new Error("не указана роль, которой принадлежит навык");

  const file = missionSkillPath(role, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderSkill(name, description, input.body ?? null), "utf8");

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO mission_skills (id, task_id, role, name, description, body, source_slot, skill_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, role, name) DO UPDATE SET
       description = excluded.description, body = excluded.body,
       source_slot = excluded.source_slot, skill_path = excluded.skill_path,
       released_at = NULL, created_at = datetime('now')`,
  ).run(
    id,
    taskId,
    role,
    name,
    description,
    input.body ?? null,
    input.sourceSlot ?? null,
    file,
  );
  appendMissionEvent(taskId, { kind: "mission_skill_registered", payload: { role, name, path: file } });
  const row = db.prepare("SELECT * FROM mission_skills WHERE task_id = ? AND role = ? AND name = ?").get(taskId, role, name) as MissionSkill;
  return row;
}

/**
 * Снять навык миссии: файл уходит в архив (вне skills/, чтобы Pi его не
 * подхватил), запись помечается снятой. Файл восстановим — архив рядом.
 */
export function releaseMissionSkill(taskId: string, role: string, name: string): boolean {
  const row = db.prepare("SELECT * FROM mission_skills WHERE task_id = ? AND role = ? AND name = ? AND released_at IS NULL").get(taskId, role, name) as MissionSkill | undefined;
  if (!row) return false;
  const file = row.skill_path ?? missionSkillPath(role, name);
  try {
    if (fs.existsSync(file)) {
      const target = path.join(ARCHIVE_ROOT, taskId, role, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(path.dirname(file), target);
    }
  } catch (error) {
    // Файл не убрался — навык останется в папке роли. Помечаем снятым
    // только если файл действительно ушёл; иначе — заметка в журнал.
    appendMissionEvent(taskId, {
      kind: "mission_skill_release_failed",
      payload: { role, name, error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
  db.prepare("UPDATE mission_skills SET released_at = datetime('now') WHERE id = ?").run(row.id);
  appendMissionEvent(taskId, { kind: "mission_skill_released", payload: { role, name } });
  return true;
}

/** Снять все навыки миссии — вызывается при закрытии миссии. */
export function releaseMissionSkills(taskId: string): string[] {
  const released: string[] = [];
  for (const skill of missionSkills(taskId)) {
    if (releaseMissionSkill(taskId, skill.role, skill.name)) released.push(`${skill.role}/${skill.name}`);
  }
  return released;
}
