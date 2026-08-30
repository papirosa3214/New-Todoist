import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8765/index.html?v=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.hover('[data-label="Фильтры"]');
await page.waitForTimeout(1200);

await page.evaluate(() => {
  document.querySelectorAll('.sidebar__nav').forEach(el => el.style.outline = '2px solid lime');
  document.querySelectorAll('.sidebar').forEach(el => el.style.outline = '2px solid magenta');
  const ind = document.getElementById('navIndicator');
  ind.style.outline = '3px solid red';
});

const layout = await page.evaluate(() => {
  const nav = document.querySelector('.sidebar__nav');
  const ind = document.getElementById('navIndicator');
  const r1 = nav.getBoundingClientRect();
  const r2 = ind.getBoundingClientRect();
  return {
    nav: { top: r1.top, bottom: r1.bottom, left: r1.left, height: r1.height },
    indicator: { top: r2.top, bottom: r2.bottom, left: r2.left, height: r2.height },
    navOffsetParent: nav.offsetParent && nav.offsetParent.tagName,
    indOffsetParent: ind.offsetParent && ind.offsetParent.tagName,
  };
});
console.log(JSON.stringify(layout, null, 2));

await page.screenshot({ path: '/home/maksim/Проекты/New-Todoist/mockup-reference/nav-artifact/_shots/_debug-2.png', clip: { x: 0, y: 0, width: 280, height: 500 } });
await browser.close();
