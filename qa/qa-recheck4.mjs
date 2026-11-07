import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:3112";
const URL = `${BASE}/static/app/index.html#/chat`;
const OUT = "qa-shots/dorabotka2";
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[qa]", ...a);

const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 912 } });
const page = await ctx.newPage();
const net = [];
page.on("request", (r) => { if (r.url().includes("/agent/providers")) net.push(r.url()); });

const PICK = "button:has-text('minimax'), button:has-text('local-qwen'), button:has-text('MiniMax'), button:has-text('qwen')";
const header = async () =>
  (await page.locator(PICK).first().innerText().catch(() => "")).replace(/\n/g, " | ");

// --- первый заход: как открывается чат
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(3000);
log("1) header при открытии:", await header());

// --- выбор провайдера
await page.locator(PICK).first().click();
await page.waitForTimeout(500);
await page.locator("button", { hasText: "local-qwen" }).last().click();
await page.waitForTimeout(1500);
log("2) header после выбора local-qwen:", await header());
await page.screenshot({ path: `${OUT}/20-picked-local-qwen.png`, fullPage: true });

// --- перезагрузка страницы
net.length = 0;
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(3000);
log("3) header после перезагрузки:", await header());
log("   запросов к /agent/providers после перезагрузки:", net.length, net.join(" , "));

// --- что лежит в офлайн-кэше сервис-воркера
const cached = await page.evaluate(async () => {
  const c = await caches.open("pult110-v2");
  const r = await c.match("/x/panel/api/agent/providers");
  if (!r) return { hit: false };
  const j = await r.clone().json();
  return { hit: true, chat_selection: j.chat_selection, default_id: j.default_id };
});
log("4) офлайн-кэш сервис-воркера:", JSON.stringify(cached));
await page.screenshot({ path: `${OUT}/21-after-reload.png`, fullPage: true });

// --- экран «Об агенте»: лимиты
await page.locator("button[aria-label='Об агенте']").click();
await page.waitForTimeout(1500);
const body = await page.evaluate(() => document.body.innerText);
const i = body.indexOf("ЛИМИТ");
log("5) блок лимитов в «Об агенте»:", i >= 0 ? body.slice(i - 120, i + 400) : "НЕ НАЙДЕН\n" + body.slice(0, 800));
await page.screenshot({ path: `${OUT}/22-about-agent.png`, fullPage: true });

await browser.close();
