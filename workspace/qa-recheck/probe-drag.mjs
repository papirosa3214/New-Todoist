import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4104";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
const errs = [];
p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", e => errs.push("pageerror: " + e.message));
await p.goto(base + "/today", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);

const chip = p.locator("text=QA-проверка").first();
const count = await p.locator("text=QA-проверка").count();
console.log("элементов с названием задачи:", count);
const before = await p.locator("text=QA-проверка").count();
console.log("до перетаскивания элементов:", before);
const box = await chip.boundingBox();
console.log("bbox:", JSON.stringify(box));
if (box) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await p.mouse.move(x, y + i * 12, { steps: 2 });
    await p.waitForTimeout(60);
  }
  await p.waitForTimeout(400);
  const ghost = await p.evaluate(() => {
    const t = document.body.innerText;
    return { hasGhost: t.includes("QA-проверка"), len: t.length,
      overlays: Array.from(document.querySelectorAll("[data-dnd-overlay], body > div:last-child")).length,
      fixed: Array.from(document.querySelectorAll("div")).filter(d => getComputedStyle(d).position === "fixed" && d.textContent.includes("QA-проверка")).length };
  });
  console.log("во время перетаскивания:", JSON.stringify(ghost));
  await p.mouse.up();
  await p.waitForTimeout(1500);
}
await p.screenshot({ path: "workspace/qa-recheck/out-probe/drag-today.png" });
console.log("текст после перетаскивания содержит QA-проверка:",
  (await p.evaluate(() => document.body.innerText)).includes("QA-проверка"));
console.log("errors:", JSON.stringify(errs.filter(e => !e.includes("404")).slice(0, 6)));
console.log("404/прочее:", JSON.stringify(errs.filter(e => e.includes("404")).length));
await b.close();
