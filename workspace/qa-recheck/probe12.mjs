import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log(JSON.stringify(await p.evaluate(async () => {
  const res = await fetch("/api/tasks");
  const j = await res.json();
  const ts = Array.isArray(j) ? j : j.tasks;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
  const withDue = ts.filter(t => t.due_date);
  const future = ts.filter(t => t.due_date && t.due_date >= today);
  const mine = ts.filter(t => (t.title||"").includes("QA-проверка"));
  return { total: ts.length, today, withDue: withDue.length, future: future.length,
    mine: mine.map(t => [t.title, t.due_date, t.status, t.assignee_id, t.project_id]) };
}), null, 1));
await b.close();
