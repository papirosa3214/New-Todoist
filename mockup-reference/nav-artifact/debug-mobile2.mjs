import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
page.on('pageerror', err => console.log('[pageerror]', err.message));
await page.goto('http://127.0.0.1:8765/index.html?v=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Hover at a specific coordinate that should hit Календарь (around x=125, y=794)
console.log('hovering via force on Календарь');
await page.hover('.bottom-nav [data-label="Календарь"]', { force: true });
await page.waitForTimeout(900);

const after = await page.evaluate(() => {
  const el = document.getElementById('bottomIndicator');
  const r = el.getBoundingClientRect();
  // What is at the cursor position?
  const top = document.elementFromPoint(125, 794);
  return {
    transform: el.style.transform,
    indicator: { top: r.top, left: r.left, width: r.width },
    elementAtCursor: top && (top.tagName + '.' + top.className),
    activeLabel: document.querySelector('.bottom-nav__item.is-active')?.dataset.label,
  };
});
console.log('after:', JSON.stringify(after, null, 2));

await browser.close();
