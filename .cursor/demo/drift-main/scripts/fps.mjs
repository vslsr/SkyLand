import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.goto('http://localhost:8123/?x=-20&y=18&z=20&yaw=-0.7&pitch=0.15', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
const fps = await page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res((n / 3).toFixed(1)); };
  requestAnimationFrame(tick);
}));
console.log('FPS:', fps);
await page.screenshot({ path: 'shot_mid.png' });
await browser.close();
