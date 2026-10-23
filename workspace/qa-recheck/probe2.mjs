import { chromium } from "playwright";
const base = "http://127.0.0.1:4104";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, deviceScaleFactor: 2, locale: "ru-RU", timezoneId: "Europe/Moscow" });
const reqs = [];
p.on("response", async r => { if (r.url().includes("/api/tasks")) reqs.push(r.url() + " " + r.status()); });
await p.goto(base + "/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
console.log("api calls:", reqs);
const info = await p.evaluate(() => {
  const grid = document.querySelector(".grid.shrink-0");
  const cells = document.querySelectorAll(".grid.shrink-0 > div");
  const chips = Array.from(document.querySelectorAll("button")).filter(b => b.className.includes("tf-meta") || b.className.includes("shrink-0"));
  return {
    gridRows: document.querySelectorAll(".grid.shrink-0").length,
    chipLike: chips.slice(0, 20).map(b => b.textContent.slice(0, 60)),
    todayBadge: document.body.innerText.includes("23"),
    ls: Object.fromEntries(Object.entries(localStorage)),
  };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
