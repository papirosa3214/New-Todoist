import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
p.on("response", async r => {
  if (r.url().endsWith("/api/tasks")) {
    try { const j = await r.json(); const t = Array.isArray(j) ? j : (j.tasks||[]);
      console.log("tasks in response:", t.length, "mine:", t.filter(x=>(x.title||"").includes("QA-проверка")).map(x=>[x.title,x.due_date,x.status,x.project_id]));
    } catch(e){ console.log("parse err", e.message); }
  }
});
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
await b.close();
