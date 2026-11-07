// Mark the indicator with a red border to find it on the screenshot
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8765/index.html?v=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.hover('[data-label="Фильтры"]');
await page.waitForTimeout(900);

// Outline the indicator with red
await page.evaluate(() => {
  const el = document.getElementById('navIndicator');
  el.style.outline = '3px solid red';
  el.style.outlineOffset = '2px';
});

const pos = await page.evaluate(() => {
  const el = document.getElementById('navIndicator');
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log('indicator bbox:', pos);

await page.screenshot({ path: '/home/maksim/Проекты/New-Todoist/mockup-reference/nav-artifact/_shots/_debug-indicator.png', clip: { x: 0, y: 0, width: 280, height: 500 } });
console.log('saved debug shot');

await browser.close();
