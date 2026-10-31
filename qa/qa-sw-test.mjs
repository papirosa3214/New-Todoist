import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3112";
const PICK = "button:has-text('minimax'), button:has-text('local-qwen'), button:has-text('MiniMax'), button:has-text('qwen')";
const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext({ viewport: { width: 420, height: 912 } })).newPage();
await p.goto(`${BASE}/static/app/index.html#/chat`, { waitUntil: "load" });
await p.waitForTimeout(3000);
console.log("1) с сервис-воркером, до выбора:", (await p.locator(PICK).first().innerText()).replace(/\n/g," | "));
// снимаем сервис-воркер и перезагружаем
await p.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); await caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))); });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(3000);
console.log("2) без сервис-воркера:", (await p.locator(PICK).first().innerText()).replace(/\n/g," | "));
await b.close();
