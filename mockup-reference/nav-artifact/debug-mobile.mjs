import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
await page.goto('http://127.0.0.1:8765/index.html?v=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const init = await page.evaluate(() => {
  const el = document.getElementById('bottomIndicator');
  return { transform: el && el.style.transform };
});
console.log('init:', JSON.stringify(init));

// Find the Календарь button bbox first
const before = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.bottom-nav__item'));
  const nav = document.getElementById('bottomNav');
  return {
    items: items.map(i => ({label: i.dataset.label, rect: i.getBoundingClientRect()})),
    navDisplay: getComputedStyle(nav).display,
    navVisibility: getComputedStyle(nav).visibility,
    pointerOnItem: items[1] ? getComputedStyle(items[1]).pointerEvents : 'n/a',
    itemCount: items.length,
  };
});
console.log('before:', JSON.stringify(before, null, 2));

await page.hover('.bottom-nav [data-label="Календарь"]');
await page.waitForTimeout(900);

const after = await page.evaluate(() => {
  const el = document.getElementById('bottomIndicator');
  const indRect = el.getBoundingClientRect();
  return {
    transform: el && el.style.transform,
    indicator: { top: indRect.top, left: indRect.left, width: indRect.width, height: indRect.height },
    activeLabel: document.querySelector('.bottom-nav__item.is-active')?.dataset.label,
  };
});
console.log('after hover Календарь:', JSON.stringify(after, null, 2));

await browser.close();
