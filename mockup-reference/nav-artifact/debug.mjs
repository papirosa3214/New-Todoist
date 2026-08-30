// Debug script — print indicator transform
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
page.on('pageerror', err => console.log('[pageerror]', err.message));

await page.goto('http://127.0.0.1:8765/index.html?v=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const init = await page.evaluate(() => {
  const el = document.getElementById('navIndicator');
  return { transform: el && el.style.transform, height: el && el.style.height };
});
console.log('initial:', JSON.stringify(init));

await page.hover('[data-label="Фильтры"]');
await page.waitForTimeout(1200);

// Inspect which item is hovered
const target = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('[data-label="Фильтры"]'));
  return all.map(el => ({
    tag: el.tagName,
    classes: el.className,
    rect: el.getBoundingClientRect(),
    isInSidebar: !!el.closest('.sidebar'),
    isInBottom: !!el.closest('.bottom-nav'),
  }));
});
console.log('Фильтры elements:', JSON.stringify(target, null, 2));

const afterHover = await page.evaluate(() => {
  const el = document.getElementById('navIndicator');
  const items = Array.from(document.querySelectorAll('.nav-item'));
  const nav = document.querySelector('.sidebar__nav');
  const sidebar = document.querySelector('.sidebar');
  const indRect = el && el.getBoundingClientRect();
  return {
    transform: el && el.style.transform,
    height: el && el.style.height,
    itemTops: items.map(i => ({label: i.dataset.label, top: i.getBoundingClientRect().top, h: i.getBoundingClientRect().height})),
    navTop: nav.getBoundingClientRect().top,
    sidebarTop: sidebar.getBoundingClientRect().top,
    indicatorTop: indRect && indRect.top,
    indicatorLeft: indRect && indRect.left,
    indicatorWidth: indRect && indRect.width,
    navOffsetTop: nav.offsetTop,
    indicatorComputedTransform: el && getComputedStyle(el).transform,
  };
});
console.log('after hover Фильтры:', JSON.stringify(afterHover, null, 2));

await browser.close();
