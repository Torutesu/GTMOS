/**
 * Generates the OGP images (1200×630 PNG) for both locales.
 *
 *   node tools/make-og.mjs
 *
 * Uses Playwright + the Chromium already present in the environment.
 * Output: site/assets/og-en.png, site/assets/og-ja.png
 *
 * Note: the Japanese card renders with whatever CJK font the generating
 * machine has. Regenerate on a box with Noto Sans JP installed for the
 * best result.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Works whether playwright is a local dependency or only installed globally.
async function loadChromium() {
  // CJS interop: a dynamically imported CJS module puts exports on `.default`.
  const pick = (m) => m.chromium ?? m.default?.chromium;
  try {
    return pick(await import('playwright'));
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const entry = pathToFileURL(resolve(globalRoot, 'playwright/index.js')).href;
    return pick(await import(entry));
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'site/assets');

const CARDS = [
  {
    file: 'og-en.png',
    lang: 'en',
    title: 'The <em>Go-To-Market</em> OS.',
    sub: 'Strategy, demand, brand, and launch film — one full-stack team, driven by global playbooks and AI.',
    meta: ['AI-native', 'Global playbooks', 'Full-stack'],
  },
  {
    file: 'og-ja.png',
    lang: 'ja',
    title: '市場を獲るための、<em>Go-To-Market OS</em>。',
    sub: '戦略・獲得・ブランド・ローンチ動画まで。フルスタックの GTM を、グローバル知見と AI でドライブする。',
    meta: ['AI ネイティブ', 'グローバル知見', 'フルスタック'],
  },
];

const page = (c) => `<!DOCTYPE html><html lang="${c.lang}"><head><meta charset="UTF-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#08090A;color:#F4F6F7;overflow:hidden;position:relative;
       font-family:${c.lang === 'ja'
         ? /* Latin first, CJK as fallback, so the two scripts don't clash */
           '-apple-system,"Helvetica Neue","Liberation Sans",Arial,"Noto Sans JP","Hiragino Kaku Gothic ProN",IPAPGothic,sans-serif'
         : '-apple-system,"Helvetica Neue","Liberation Sans",Arial,sans-serif'};}
  .grid{position:absolute;inset:0;
    background-image:linear-gradient(to right,rgba(255,255,255,.05) 1px,transparent 1px),
                     linear-gradient(to bottom,rgba(255,255,255,.05) 1px,transparent 1px);
    background-size:60px 60px;
    -webkit-mask-image:radial-gradient(110% 90% at 22% 15%,#000,transparent 70%)}
  .glow{position:absolute;top:-260px;left:-140px;width:900px;height:700px;
    background:radial-gradient(50% 50% at 50% 50%,rgba(255,90,54,.20),transparent 70%)}
  .in{position:relative;height:100%;padding:78px 84px;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:14px;font:700 26px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em}
  .brand svg{width:38px;height:38px}
  h1{margin-top:auto;font-size:${c.lang === 'ja' ? '58px' : '78px'};line-height:1.18;
     letter-spacing:-.035em;font-weight:700;max-width:${c.lang === 'ja' ? '18em' : '16em'}}
  h1 em{font-style:normal;color:#FF5A36}
  p{margin-top:26px;font-size:25px;line-height:1.55;color:#9BA3AB;max-width:${c.lang === 'ja' ? '30em' : '34em'}}
  ul{margin-top:auto;padding:30px 0 0;border-top:1px solid #1A1E22;list-style:none;
     display:flex;gap:34px;font:600 19px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;
     text-transform:uppercase;color:#9BA3AB}
  li{display:flex;align-items:center;gap:11px}
  li::before{content:"";width:7px;height:7px;border-radius:50%;background:#FF5A36}
  .bar{position:absolute;left:0;right:0;bottom:0;height:7px;background:#FF5A36}
</style></head><body>
  <div class="grid"></div><div class="glow"></div>
  <div class="in">
    <div class="brand">
      <svg viewBox="0 0 32 32">
        <rect x="1" y="1" width="30" height="30" rx="7.5" fill="none" stroke="#FF5A36" stroke-width="1.6"/>
        <path d="M10 11l5 5-5 5" fill="none" stroke="#FF5A36" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M17.5 21.5h5" fill="none" stroke="#F4F6F7" stroke-width="2.4" stroke-linecap="round"/>
      </svg>GTMOS
    </div>
    <h1>${c.title}</h1>
    <p>${c.sub}</p>
    <ul>${c.meta.map((m) => `<li>${m}</li>`).join('')}</ul>
  </div>
  <div class="bar"></div>
</body></html>`;

const chromium = await loadChromium();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await mkdir(outDir, { recursive: true });

for (const card of CARDS) {
  const p = await ctx.newPage();
  await p.setContent(page(card), { waitUntil: 'load' });
  await writeFile(resolve(outDir, card.file), await p.screenshot({ type: 'png' }));
  console.log('wrote', card.file);
  await p.close();
}

await browser.close();
