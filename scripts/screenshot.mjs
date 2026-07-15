// Exact-viewport screenshot helper (headless Chrome via CLI reports wrong
// viewport sizes on Windows; Playwright is pixel-exact).
// Usage: node scripts/screenshot.mjs <url> <out.png> [width] [height] [full|view] [clickSelector ...]
import { chromium } from 'playwright';

const [, , url, out, width = '414', height = '900', mode = 'full', ...clicks] = process.argv;
if (!url || !out) {
  console.error('Usage: node scripts/screenshot.mjs <url> <out.png> [width] [height] [full|view] [clickSelector ...]');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(3500);
for (const sel of clicks) {
  try {
    await page.click(sel);
    await page.waitForTimeout(400);
  } catch (err) {
    console.error('click failed:', sel, String(err).split('\n')[0]);
  }
}
await page.screenshot({ path: out, fullPage: mode === 'full' });
await browser.close();
console.log('saved', out);
