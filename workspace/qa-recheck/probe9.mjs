import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => {
  const badge = document.querySelector(".bg-red.text-white");
  const cell = badge?.closest("div");
  const rows = Array.from(document.querySelectorAll(".grid.shrink-0"));
  const rowWithBadge = badge?.closest(".grid.shrink-0");
  const idx = rows.indexOf(rowWithBadge);
  return {
    badgeText: badge?.textContent,
    cellHTML: cell?.outerHTML,
    rowIndex: idx,
    rowCount: rows.length,
    rowTexts: rows.map(r => Array.from(r.children).map(c => c.textContent).join("|")).slice(Math.max(0, idx-1), idx+2),
  };
}), null, 1));
await b.close();
