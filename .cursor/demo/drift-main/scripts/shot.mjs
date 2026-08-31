// Headless screenshot + console-error capture for visual iteration.
// Usage: node scripts/shot.mjs [outfile] [waitMs] [actions]
// actions: comma-separated, e.g. "lookup", "forward", "dive"
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'shot.png';
const waitMs = Number(process.argv[3] ?? 5000);
const query = process.argv[4] ?? '';
const actions = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto('http://localhost:8123/' + (query ? '?' + query : ''), { waitUntil: 'networkidle' });
await page.waitForTimeout(waitMs);

for (const a of actions) {
  if (a === 'forward') await page.keyboard.down('w');
  if (a === 'up') {
    await page.evaluate(() => { /* placeholder */ });
  }
}
if (actions.length) await page.waitForTimeout(2500);

await page.screenshot({ path: out });
await browser.close();

if (errors.length) {
  console.log('CONSOLE ERRORS:');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
console.log('clean — no console errors');
