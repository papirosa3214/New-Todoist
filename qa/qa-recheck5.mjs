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
const PICK = "button:has-text('minimax'), button:has-text('local-qwen'), button:has-text('MiniMax'), button:has-text('qwen')";

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(2500);

// провайдер: local-qwen (локальная модель, ключи не нужны)
await page.locator(PICK).first().click();
await page.waitForTimeout(500);
await page.locator("button", { hasText: "local-qwen" }).last().click();
await page.waitForTimeout(1200);
log("header:", (await page.locator(PICK).first().innerText()).replace(/\n/g, " | "));

// 1) обычный вопрос: ждём ответ и проверяем, что расход записан
await page.locator("textarea").last().fill("Ответь одним словом: сколько будет два плюс два?");
await page.locator("textarea").last().press("Enter");
await page.waitForTimeout(20000);
let text = await page.evaluate(() => document.body.innerText);
log("1) ответ в чате:", text.slice(text.indexOf("два плюс два"), text.indexOf("два плюс два") + 300).replace(/\n+/g, " / "));
await page.screenshot({ path: `${OUT}/30-answer.png`, fullPage: true });
let st = await (await fetch(`${BASE}/api/agent/state`)).json();
log("   расход после вопроса:", JSON.stringify(st.limits ?? st.usage ?? st).slice(0, 300));

// 2) лимит исчерпан: ответ должен быть понятным, без обращения к модели
await fetch(`${BASE}/__none__`).catch(() => {});
const { execSync } = await import("node:child_process");
execSync(`python3 -c "
import sqlite3,json
c=sqlite3.connect('/tmp/qa-cl/.state/agent.sqlite3')
c.execute('update state set value=? where key=?', (json.dumps({'day':'2026-10-29','tokens':3000000,'calls':5,'spent_ms':10}),'model_usage'))
c.commit()"`);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2500);
await page.locator("textarea").last().fill("Ещё вопрос");
await page.locator("textarea").last().press("Enter");
await page.waitForTimeout(6000);
text = await page.evaluate(() => document.body.innerText);
const idx = text.lastIndexOf("Ещё вопрос");
log("2) чат при исчерпанном лимите:", text.slice(idx, idx + 300).replace(/\n+/g, " / "));
await page.screenshot({ path: `${OUT}/31-limit-exceeded.png`, fullPage: true });

await browser.close();
