import fs from "node:fs";
const contract = JSON.parse(fs.readFileSync(new URL("../../shared/task-brief.json", import.meta.url), "utf8")) as {instructions:string};
export const TASK_BRIEF_INSTRUCTIONS = contract.instructions;
export function taskBriefInstruction(key:string, original:string):string {
  if (!["tool.mcp.taskflow_create_task", "mcp.initialize"].includes(key) || original.includes(TASK_BRIEF_INSTRUCTIONS)) return original;
  return original + "\n\n" + TASK_BRIEF_INSTRUCTIONS;
}
