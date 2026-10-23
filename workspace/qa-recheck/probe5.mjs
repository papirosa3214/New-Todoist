import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => ({
  textContentHasQA: document.body.textContent.includes("QA-проверка"),
  bgCard2: document.querySelectorAll(".bg-card2").length,
  gridRows: document.querySelectorAll(".grid.shrink-0").length,
  firstRowHTML: document.querySelector(".grid.shrink-0")?.outerHTML.slice(0, 1200),
})), null, 1));
await b.close();
