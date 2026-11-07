import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3141";
const URL = `${BASE}/static/app/index.html#/chat`;
const OUT = process.env.OUT || "qa-shots/dorabotka3";
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[qa]", ...a);
const errors = [];
const answers = [];

const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 912 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("response", async (r) => {
  if (r.url().includes("/api/agent/chat/send")) {
    try { answers.push({ status: r.status(), body: (await r.text()).slice(0, 400) }); }
    catch { answers.push({ status: r.status(), body: "не прочитан" }); }
  }
});

const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); log("shot", n); };
const header = async () => {
  const btn = page.locator("button:has(svg.lucide-cpu)").first();
  return (await btn.innerText()).replace(/\s+/g, " ").trim();
};

// 1. чат открывается на провайдере по умолчанию из базы
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(3000);
log("header after open:", await header());
await shot("01-chat-open");

// 2. список провайдеров, выбор local-qwen
await page.locator("button:has(svg.lucide-cpu)").first().click();
await page.waitForTimeout(800);
await shot("02-provider-list");
await page.locator("button", { hasText: "local-qwen" }).first().click();
await page.waitForTimeout(1500);
log("header after pick:", await header());
await shot("03-picked-local-qwen");

// 3. перезагрузка — выбор должен сохраниться
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(3000);
log("header after reload:", await header());
await shot("04-after-reload");

// 4. живой вопрос выбранному провайдеру
const ta = page.locator("textarea").last();
await ta.click();
await ta.fill("Ответь одним словом: работает?");
await ta.press("Enter");
await page.waitForTimeout(25000);
await shot("05-answer");
const chatText = await page.locator("body").innerText();
log("chat has answer text:", chatText.includes("Да") || chatText.includes("работает"));
log("chat/send responses:", JSON.stringify(answers));

// 5. «Об агенте» — расход после чата
await page.locator('button[aria-label="Об агенте"]').first().click();
await page.waitForTimeout(2500);
await shot("06-about-agent");
const about = await page.locator("body").innerText();
fs.writeFileSync(`${OUT}/about-agent.txt`, about);
const tok = about.match(/ТОКЕНЫ\s*([\d\s]+)/);
const cal = about.match(/ОБРАЩЕНИ[АЯ]\s*([\d\s]+)/);
log("about tokens:", tok && tok[1].replace(/\s+/g, " "));
log("about calls:", cal && cal[1].replace(/\s+/g, " "));

fs.writeFileSync(`${OUT}/console.txt`, errors.join("\n") || "нет ошибок");
log("errors:", errors.length ? errors.slice(0, 6) : "нет");
await browser.close();
