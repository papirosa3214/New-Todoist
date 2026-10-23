import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log(await p.evaluate(() => ({
  todayStr: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" }),
  now: new Date().toString(),
})));
await b.close();
