import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
const errs=[]; p.on("console", m=>{if(m.type()==="error") errs.push(m.text())}); p.on("pageerror", e=>errs.push("pageerror: "+e.message));
await p.goto("http://127.0.0.1:4104/upcoming", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
// открыть меню «…»
await p.click("button:has(svg) >> nth=-1").catch(()=>{});
const btns = await p.$$("button");
console.log("buttons:", (await p.$$eval("button", bs=>bs.map(b=>b.getAttribute("aria-label")||b.textContent.slice(0,20)))).slice(0,20));
await b.close();
