import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
const errs=[]; p.on("console", m=>{if(m.type()==="error") errs.push(m.text())}); p.on("pageerror", e=>errs.push("pageerror: "+e.message));
const resp = [];
p.on("response", r=>{ if(r.status()>=400) resp.push(r.status()+" "+r.url()); });
try { await p.goto("https://192.168.1.110:5180/labels", { waitUntil: "domcontentloaded", timeout: 20000 }); } catch(e){ console.log("goto err", e.message); }
await p.waitForTimeout(4000);
console.log("text:", (await p.evaluate(()=>document.body.innerText)).slice(0,300));
console.log("bad responses:", resp.slice(0,5));
console.log("errors:", errs.slice(0,5));
await b.close();
