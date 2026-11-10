import fs from "node:fs";
import { registryText } from "./roleRules.js";
const contract = JSON.parse(fs.readFileSync(new URL("../../shared/task-brief.json", import.meta.url), "utf8")) as {instructions:string};
export const TASK_BRIEF_INSTRUCTIONS = contract.instructions;
/** Текст для роли — из реестра. Файл shared/task-brief.json остаётся контрактом постановки. */
export const taskBriefText = (): string => registryText("карточка: все шаги", undefined, "brief:TASK_BRIEF_INSTRUCTIONS");
export function taskBriefInstruction(key:string, original:string):string {
  if (!["tool.mcp.taskflow_create_task", "tool.runtime.taskflow_create_task", "mcp.initialize"].includes(key) || original.includes(taskBriefText())) return original;
  return original + "\n\n" + taskBriefText();
}
