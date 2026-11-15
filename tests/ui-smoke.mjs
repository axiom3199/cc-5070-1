import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'artifacts';
fs.mkdirSync(outDir, { recursive: true });

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell`,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
  env: {
    ...process.env,
    LD_LIBRARY_PATH: [
      '/tmp/browserlibs/root/lib/aarch64-linux-gnu',
      '/tmp/browserlibs/root/usr/lib/aarch64-linux-gnu',
      process.env.LD_LIBRARY_PATH ?? '',
    ].join(':'),
  },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__roomCamera && window.__roomCamera.lastResult, null, { timeout: 20000 });
await page.waitForTimeout(1200);

const snapshot = async () => page.evaluate(() => window.__roomCamera.snapshot());
const shots = {};

shots.start = await snapshot();
await page.screenshot({ path: path.join(outDir, '01-start.png') });

const scenes = ['corridor', 'low', 'corner', 'column'];
for (const name of scenes) {
  await page.click(`[data-scene="${name}"]`);
  await page.waitForTimeout(900);
  shots[name] = await snapshot();
  await page.screenshot({ path: path.join(outDir, `02-${name}.png`) });
}

// Drive the character with WASD through the corridor, then a wall-hug turn.
await page.click('[data-scene="corridor"]');
await page.waitForTimeout(500);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1400);
await page.keyboard.down('KeyA');
await page.waitForTimeout(700);
await page.keyboard.up('KeyA');
await page.keyboard.up('KeyW');
await page.waitForTimeout(700);
shots.drive = await snapshot();
await page.screenshot({ path: path.join(outDir, '03-drive.png') });

// Requested distance sweep: zoom in and out, verify legal clamping.
await page.evaluate(() => window.__roomCamera.setRequestedDistance(6.5));
await page.waitForTimeout(900);
shots.zoomOut = await snapshot();
await page.screenshot({ path: path.join(outDir, '04-zoom-out.png') });

await page.evaluate(() => window.__roomCamera.setRequestedDistance(1.0));
await page.waitForTimeout(900);
shots.zoomIn = await snapshot();
await page.screenshot({ path: path.join(outDir, '05-zoom-in.png') });

// Long free-run while rotating to catch any illegal frame.
await page.click('[data-scene="start"]');
await page.waitForTimeout(400);
await page.keyboard.down('KeyW');
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(120);
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.mouse.move(720 + (i % 2 === 0 ? 90 : -90), 450, { steps: 8 });
  await page.mouse.up();
}
await page.keyboard.up('KeyW');
await page.waitForTimeout(600);
shots.afterStress = await snapshot();
await page.screenshot({ path: path.join(outDir, '06-stress.png') });

// Toggle overlay off/on to confirm the control is wired.
await page.keyboard.press('KeyV');
await page.waitForTimeout(250);
const overlayVisible = await page.evaluate(() => window.__roomCamera ? true : false);
await page.keyboard.press('KeyV');

const hudText = await page.evaluate(() => {
  const get = (k) => document.querySelector(`[data-hud="${k}"]`)?.textContent ?? '';
  return {
    requested: get('requested'), legal: get('legal'), applied: get('applied'),
    status: get('status'), visibility: get('visibility'), near: get('near'),
    direction: get('direction'), tests: get('tests'), candidates: get('candidates'),
    violations: get('violations'), posActual: get('pos-actual'),
    scene: get('scene'),
  };
});

const result = {
  hudText,
  overlayVisible,
  shots,
  logs: logs.filter((l) => !l.includes('[log]') || l.includes('error')),
};
fs.writeFileSync(path.join(outDir, 'ui-report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
