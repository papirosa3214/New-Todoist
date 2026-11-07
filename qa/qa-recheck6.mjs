import { chromium } from "playwright";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:3112";
const URL = `${BASE}/static/app/index.html#/chat`;
const log = (...a) => console.log("[qa]", ...a);
const PICK = "button:has-text('minimax'), button:has-text('local-qwen'), button:has-text('MiniMax'), button:has-text('qwen')";

for (let i = 1; i <= 3; i++) {
  execSync("python3 -c \"import sqlite3;c=sqlite3.connect('/tmp/qa-cl/.state/agent.sqlite3');c.execute(\\\"delete from state where key='chat_selection'\\\");c.commit()\"");
  const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 912 } });
  const page = await ctx.newPage();
  let provReq = 0;
  page.on("request", (r) => { if (r.url().includes("/agent/providers")) provReq++; });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const h0 = (await page.locator(PICK).first().innerText()).replace(/\n/g, " | ");
  await page.locator(PICK).first().click();
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: "local-qwen" }).last().click();
  await page.waitForTimeout(1500);
  const h1 = (await page.locator(PICK).first().innerText()).replace(/\n/g, " | ");
  provReq = 0;
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  const h2 = (await page.locator(PICK).first().innerText()).replace(/\n/g, " | ");
  const cache = await page.evaluate(async () => {
    const c = await caches.open("pult110-v2");
    const r = await c.match("/x/panel/api/agent/providers");
    if (!r) return "нет в кэше";
    const j = await r.clone().json();
    return JSON.stringify(j.chat_selection);
  });
  log(`прогон ${i}: открытие=[${h0}] выбор=[${h1}] после перезагрузки=[${h2}] запросов к провайдерам после перезагрузке=${provReq} кэш_SW=${cache}`);
  await browser.close();
}
