import { partitionOverdueToday, todayStr } from "/home/maksim/.local/state/taskflow-runs/worktrees/fb47c9e0-4a0b-41da-9cb9-0313fcba1bdd/src/lib/date.ts";
const fake = (id:string,due:string)=>({id,title:id,due_date:due} as any);
const p = partitionOverdueToday([fake("просрочена-22","2026-10-22"),fake("сегодня-23","2026-10-23"),fake("срок-24","2026-10-24")], todayStr());
console.log("today =", todayStr());
console.log("просрочено:", p.overdue.map((t:any)=>t.due_date));
console.log("сегодня:", p.todayTasks.map((t:any)=>t.due_date));
