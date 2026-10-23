import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4104";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
const errs = [];
p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", e => errs.push("pageerror: " + e.message));
await p.goto(base + "/today", { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
await p.click('button[aria-label="Ещё"]');
await p.waitForTimeout(600);
await p.click('text="Один день"');
await p.waitForTimeout(2500);
await p.screenshot({ path: "workspace/qa-recheck/out-probe/today-hours.png" });
const txt = await p.evaluate(() => document.body.innerText);
console.log("вид «Один день»: есть название задачи:", txt.includes("QA-проверка"));

const chip = p.locator("text=QA-проверка").first();
const before = await p.locator("text=QA-проверка").count();
console.log("элементов до перетаскивания:", before);
const box = await chip.boundingBox();
console.log("bbox:", JSON.stringify(box));
if (box) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.waitForTimeout(150);
  for (let i = 1; i <= 14; i++) {
    await p.mouse.move(x, y + i * 10, { steps: 2 });
    await p.waitForTimeout(70);
  }
  await p.waitForTimeout(500);
  const during = await p.locator("text=QA-проверка").count();
  const overlay = await p.evaluate(() => Array.from(document.querySelectorAll("div"))
    .filter(d => getComputedStyle(d).position === "fixed" && d.textContent.includes("QA-проверка")).length);
  console.log("во время перетаскивания элементов:", during, "fixed-слоёв с названием:", overlay);
  await p.screenshot({ path: "workspace/qa-recheck/out-probe/today-drag.png" });
  await p.mouse.up();
  await p.waitForTimeout(1200);
}
console.log("errors (кроме 404):", JSON.stringify(errs.filter(e => !e.includes("404")).slice(0, 6)));
await b.close();
