import {
  todayStr, tomorrowStr, daysUntil, formatDueLabel, formatDaysLeft, partitionOverdueToday,
} from "/home/maksim/.local/state/taskflow-runs/worktrees/fb47c9e0-4a0b-41da-9cb9-0313fcba1bdd/src/lib/date.ts";
import {
  hoursOverdue, localClock, selectSteps, defaultSteps, type EscalationRule,
} from "/home/maksim/.local/state/taskflow-runs/worktrees/fb47c9e0-4a0b-41da-9cb9-0313fcba1bdd/server/src/lib/escalationEvaluator.ts";

const TZ = "Europe/Moscow";
const rule: EscalationRule = {
  enabled: true, quiet_from: "22:00", quiet_to: "08:00",
  weekdays: [1,2,3,4,5,6,7], steps: defaultSteps(),
};
const at = (iso: string) => new Date(iso);

console.log("== 1. Календарный срок по Москве ==");
for (const tz of ["Europe/Moscow","Asia/Tokyo","America/New_York","Europe/Kaliningrad"]) {
  process.env.TZ = tz;
  console.log(`TZ=${tz.padEnd(18)} today=${todayStr()} tomorrow=${tomorrowStr()}`);
}
process.env.TZ = "Europe/Moscow";
console.log("todayStr() =", todayStr(), "| tomorrowStr() =", tomorrowStr());
console.log("daysUntil(2026-10-24) =", daysUntil("2026-10-24"));
console.log("formatDueLabel(2026-10-24) =", formatDueLabel("2026-10-24"));
console.log("formatDaysLeft(2026-10-24) =", formatDaysLeft("2026-10-24"));
console.log("formatDueLabel(2026-10-22) =", formatDueLabel("2026-10-22"), "| daysUntil =", daysUntil("2026-10-22"));
console.log("formatDueLabel(2026-10-25) =", formatDueLabel("2026-10-25"), "| daysUntil =", daysUntil("2026-10-25"));

console.log("\n== 2. Число в названии как метка времени ==");
for (const n of [1792708606, 1792706699]) {
  const d = new Date(n*1000);
  console.log(n, "→ UTC", d.toISOString(), "| МСК", d.toLocaleString("ru-RU",{timeZone:TZ}),
    "| от 2026-10-23T00:23:18Z:", ((d.getTime()-Date.parse("2026-10-23T00:23:18Z"))/60000).toFixed(1), "мин");
}
console.log("карточка QA создана 2026-10-22T22:37:01Z → разница с меткой:",
  ((Date.parse("2026-10-22T22:37:01Z")-1792708606*1000)/1000).toFixed(0), "с");

console.log("\n== 3. Когда задача считается просроченной (сервер, эскалация) ==");
for (const m of ["2026-10-23T21:00:00Z","2026-10-23T22:00:00Z","2026-10-23T07:00:00Z","2026-10-24T21:00:00Z"]) {
  const now = at(m); const clock = localClock(now, TZ);
  const od = hoursOverdue("2026-10-24", clock);
  const p3 = selectSteps(rule, {id:"t",title:"t",priority:3,due_date:"2026-10-24",status:"active"}, now, TZ);
  const p1 = selectSteps(rule, {id:"t",title:"t",priority:1,due_date:"2026-10-24",status:"active"}, now, TZ);
  console.log(m, "→ МСК", now.toLocaleString("ru-RU",{timeZone:TZ}), "| просрочка, ч:", od.toFixed(2),
    "| шаги P3:", p3.map(s=>s.after_hours+"ч").join(",") || "—", "| шаги P1:", p1.map(s=>s.after_hours+"ч").join(",") || "—");
}

console.log("\n== 4. Разделение «просрочено / сегодня» на экране «Сегодня» ==");
const fake = (id:string,due:string)=>({id,title:id,due_date:due} as any);
const part = partitionOverdueToday([fake("просроченная-23","2026-10-23"),fake("сегодня-23","2026-10-23"),fake("срок-24","2026-10-24")], "2026-10-23");
console.log("просрочено:", part.overdue.map((t:any)=>t.due_date), "| сегодня:", part.todayTasks.map((t:any)=>t.due_date));

console.log("\n== 5. Сводка: просроченные/будущие (дата срока < сегодня) ==");
const today = "2026-10-23";
for (const due of ["2026-10-22","2026-10-23","2026-10-24"]) {
  console.log(due, "→", due < today ? "просрочена" : due > today ? "будущий срок" : "сегодня");
}
