/**
 * Dev helper: screenshots both locales at desktop + mobile widths.
 *
 *   node tools/shots.mjs [baseUrl] [outDir]
 *
 * Defaults to http://localhost:4173 and ./.shots (git-ignored).
 * Start the server first:  cd site && python3 -m http.server 4173
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

async function loadChromium() {
  const pick = (m) => m.chromium ?? m.default?.chromium;
  try {
    return pick(await import('playwright'));
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return pick(await import(pathToFileURL(resolve(globalRoot, 'playwright/index.js')).href));
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:4173';
const outDir = resolve(root, process.argv[3] ?? '.shots');

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];
const PAGES = [
  { name: 'en', path: '/' },
  { name: 'ja', path: '/ja/' },
];

const chromium = await loadChromium();
const browser = await chromium.launch();
await mkdir(outDir, { recursive: true });

for (const view of VIEWS) {
  const ctx = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    await page.goto(base + p.path, { waitUntil: 'networkidle' });
    const file = resolve(outDir, `${p.name}-${view.name}.png`);
    await writeFile(file, await page.screenshot({ fullPage: true }));
    console.log('wrote', file);
    await page.close();
  }
  await ctx.close();
}

await browser.close();
