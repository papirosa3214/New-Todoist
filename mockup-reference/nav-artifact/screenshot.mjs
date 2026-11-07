// One-shot preview screenshots via Playwright (already installed in the project)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const URL = 'http://127.0.0.1:8765/index.html';

const sizes = [
  { name: 'desktop',     w: 1440, h: 900 },
  { name: 'tablet',      w: 900,  h: 1100 },
  { name: 'mobile',      w: 390,  h: 844 },
];

for (const s of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2,
    bypassCSP: true,
  });
  await ctx.route('**/*', (route) => {
    const headers = { ...route.request().headers(), 'cache-control': 'no-cache' };
    route.continue({ headers });
  });
  const page = await ctx.newPage();
  await page.goto(URL + '?v=' + Date.now(), { waitUntil: 'networkidle' });
  // Wait for the magnetic indicator to be ready (JS has bound handlers)
  await page.waitForFunction(() => {
    const el = document.getElementById('navIndicator') || document.getElementById('bottomIndicator');
    return el && el.classList.contains('is-ready');
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);

  // Shot 1 — initial state
  await page.screenshot({ path: `${OUT}/${s.name}-initial.png`, fullPage: false });

  // Shot 2 — after hovering a far nav item so the indicator's travel is obvious
  // Breakpoint is 960px — use sidebar on desktop only. On mobile, pick "Календарь"
  // (index 1) so the central FAB doesn't intercept the cursor.
  const target = s.w > 960 ? '[data-label="Фильтры"]' : '.bottom-nav [data-label="Календарь"]';
  await page.waitForSelector(target, { state: 'visible' });
  await page.hover(target);
  await page.waitForTimeout(900); // let the magnetic indicator glide into place
  await page.screenshot({ path: `${OUT}/${s.name}-hover.png`, fullPage: false });

  // Shot 3 — after click (active state with pulse on count badge)
  await page.click(target);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${s.name}-clicked.png`, fullPage: false });

  await ctx.close();
  console.log('captured', s.name);
}

await browser.close();
console.log('done');
