import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext({ viewport: { width: 420, height: 912 } })).newPage();
await p.goto("http://127.0.0.1:3112/static/app/index.html#/chat", { waitUntil: "load" });
await p.waitForTimeout(3000);
console.log("TEXT:", (await p.evaluate(() => document.body.innerText)).slice(0, 600));
const btns = await p.evaluate(() => [...document.querySelectorAll("button")].map((x) => x.innerText.replace(/\n/g, "|") + " :: " + x.getAttribute("aria-label")).slice(0, 40));
console.log(btns.join("\n"));
await b.close();
