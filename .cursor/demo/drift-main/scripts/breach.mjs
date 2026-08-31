import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('http://localhost:8123/?x=0&y=24&z=40&yaw=3.4&oyaw=0.9', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await page.keyboard.down(' ');
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(900);
  const y = await page.evaluate(() => window.__dbg.sub.position.y.toFixed(1));
  await page.screenshot({ path: `i3_breach_${i}.png` });
  console.log(`frame ${i}: sub y=${y}`);
}
console.log(errs.length ? 'ERRORS: ' + errs.join('; ') : 'no errors');
await browser.close();
