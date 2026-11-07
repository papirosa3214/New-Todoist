import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3112";
const URL = `${BASE}/static/app/index.html#/chat`;
const OUT = process.env.OUT || "qa-shots/dorabotka2";
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[qa]", ...a);
const errors = [];

const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 912 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log("shot", name);
};
const header = async () => {
  const btn = page.locator("button:has(svg.lucide-cpu)").first();
  return (await btn.innerText()).replace(/\s+/g, " ").trim();
};

// 1. открыть чат
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(2500);
log("header after open:", await header());
await shot("01-chat-open");

// 2. открыть список провайдеров, выбрать local-qwen
await page.locator("button:has(svg.lucide-cpu)").first().click();
await page.waitForTimeout(600);
await shot("02-provider-list");
const opt = page.locator("button", { hasText: "local-qwen" }).first();
await opt.click();
await page.waitForTimeout(1200);
log("header after pick:", await header());
await shot("03-picked-local-qwen");

// 3. перезагрузка страницы — выбор должен сохраниться
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2500);
log("header after reload:", await header());
await shot("04-after-reload");

// 4. живой вопрос выбранному провайдеру
const ta = page.locator("textarea").last();
await ta.click();
await ta.fill("Ответь одним словом: работает?");
await ta.press("Enter");
await page.waitForTimeout(12000);
await shot("05-answer");
const chatText = await page.locator("body").innerText();
log("has limit text in chat:", chatText.includes("дневной лимит"));

// 5. «Об агенте» — расход
await page.locator('button[aria-label="Об агенте"]').first().click();
await page.waitForTimeout(1500);
await shot("06-about-agent");
const about = await page.locator("body").innerText();
fs.writeFileSync(`${OUT}/about-agent.txt`, about);
const m = about.match(/Токены[\s\S]{0,80}/);
log("about agent tokens block:", m && m[0].replace(/\s+/g, " "));

fs.writeFileSync(`${OUT}/console.txt`, errors.join("\n") || "нет ошибок");
log("errors:", errors.length ? errors.slice(0, 5) : "нет");
await browser.close();
