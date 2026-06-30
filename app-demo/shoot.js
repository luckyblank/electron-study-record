// 逐帧截图验证：用 __seekRender 冻结时钟，seek 到各分镜代表帧截图
const path = require('path');
const { chromium } = require('playwright');

const HTML = path.resolve(__dirname, 'study-record-demo.html');
const OUT = path.resolve(__dirname, 'shots');
const fs = require('fs');
fs.mkdirSync(OUT, { recursive: true });

// 代表帧：覆盖 8 个分镜
const FRAMES = [
  { t: 1.6, name: '01-intro' },
  { t: 5.2, name: '02-start' },
  { t: 8.4, name: '03-pause' },
  { t: 12.0, name: '04-end-celebrate' },
  { t: 16.6, name: '05-stats' },
  { t: 20.4, name: '06-share' },
  { t: 23.5, name: '07-theme-dark' },
  { t: 24.6, name: '07b-theme-eyecare' },
  { t: 27.0, name: '08-outro' }
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  // 冻结自驱时钟，启用 seek 模式
  await ctx.addInitScript(() => { window.__seekRender = true; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file://' + HTML, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 8000 });
  await page.waitForTimeout(400); // fonts settle

  for (const f of FRAMES) {
    await page.evaluate(t => window.__seek(t), f.t);
    await page.waitForTimeout(250);
    const file = path.join(OUT, f.name + '.png');
    await page.screenshot({ path: file });
    console.log('  ✓ ' + f.name + ' @ t=' + f.t + ' → ' + path.basename(file));
  }

  await browser.close();
  if (errors.length) {
    console.log('\n⚠️ ERRORS:');
    errors.forEach(e => console.log('  ' + e));
    process.exit(1);
  } else {
    console.log('\n✓ All frames captured, no console/page errors.');
  }
})().catch(e => { console.error(e); process.exit(1); });
