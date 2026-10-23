import { chromium } from "playwright";
const b = await chromium.launch();
for (const path of ["/today", "/upcoming", "/labels"]) {
  const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow", ignoreHTTPSErrors: true });
  const errs = []; const bad = [];
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("response", r => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });
  await p.goto("https://192.168.1.110:5180" + path, { waitUntil: "networkidle", timeout: 30000 }).catch(e => console.log(path, "goto:", e.message));
  await p.waitForTimeout(2500);
  const t = await p.evaluate(() => document.body.innerText);
  console.log(path, "| текст:", JSON.stringify(t.replace(/\n+/g, " | ").slice(0, 160)));
  console.log(path, "| ошибки:", JSON.stringify(errs.slice(0, 3)), "| >=400:", JSON.stringify(bad.slice(0, 3)));
  await p.close();
}
await b.close();
