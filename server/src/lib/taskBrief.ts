import fs from "node:fs";
import { registryTextOr } from "./roleRules.js";
const contract = JSON.parse(fs.readFileSync(new URL("../../shared/task-brief.json", import.meta.url), "utf8")) as {instructions:string};
export const TASK_BRIEF_INSTRUCTIONS = contract.instructions;
/** Контракт постановки: из реестра (R273), литерал из shared/task-brief.json — запасной путь. */
export const taskBriefText = (): string => registryTextOr("карточка: все шаги", "brief:TASK_BRIEF_INSTRUCTIONS", TASK_BRIEF_INSTRUCTIONS);
export function taskBriefInstruction(key:string, original:string):string {
  if (!["tool.mcp.taskflow_create_task", "tool.runtime.taskflow_create_task", "mcp.initialize"].includes(key) || original.includes(taskBriefText())) return original;
  return original + "\n\n" + taskBriefText();
}
