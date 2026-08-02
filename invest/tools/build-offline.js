// tools/build-offline.js
// Produces dist/KidsPortfolio-Offline.html — a single self-contained file
// that runs the entire Kids Portfolio SPA from disk via file://, with no
// install, no server, and NO external CDN dependency.
//
// Pipeline:
//   1. Tailwind CSS pre-compiled against index.html + src/**.
//   2. Google Fonts (Assistant, Hanken Grotesk) CSS fetched and every
//      woff2 inlined as a data: URL.
//   3. Material Symbols Outlined subset (only the ~18 icons we actually
//      use), also inlined.
//   4. App JS bundled with esbuild (IIFE, minified).
//   5. Brand icon (icon-192.png) inlined as data:image/png.
//   6. index.html cache-busting bootstrap, PWA manifest links, and all
//      external <script>/<link> tags to CDNs are replaced by inline
//      equivalents.
//
//   node tools/build-offline.js
//
// Run by hand or via .github/workflows/build-offline.yml.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TEXT_FONTS_URL =
  'https://fonts.googleapis.com/css2?' +
  'family=Assistant:wght@400;500;600;700;800' +
  '&family=Hanken+Grotesk:wght@400;500;600;700;800;900' +
  '&display=swap';

// Material Symbols supports a `&icon_names=` parameter that returns a
// font subset containing only the named glyph ligatures.
// Every glyph src/ui-v2.js renders. An icon missing from this subset does not
// fall back to anything — it simply never paints in the offline build.
// Google Fonts rejects the request with HTTP 400 unless icon_names is sorted.
const ICON_NAMES = [
  'account_balance', 'account_balance_wallet', 'add', 'add_shopping_cart',
  'chevron_left', 'chevron_right', 'close', 'content_copy', 'dashboard', 'delete',
  'download', 'edit', 'expand_more', 'history', 'info', 'person', 'receipt_long',
  'savings', 'sell', 'settings', 'sync', 'upload', 'warning',
];
const ICONS_FONT_URL =
  'https://fonts.googleapis.com/css2?' +
  'family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0' +
  '&icon_names=' + ICON_NAMES.join(',') +
  '&display=block';

// Modern UA so Google returns woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchInlinedFontCss(cssUrl, label) {
  console.log(`  ↓ ${label}`);
  const res = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`fetch ${cssUrl} → HTTP ${res.status}`);
  let css = await res.text();

  // Google Fonts returns either …/.woff2 URLs (regular fonts) or
  // …/l/font?kit=… URLs (subset endpoint, used by Material Symbols when
  // icon_names= is set). Match anything inside url(...).
  const urls = [...new Set(
    [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1])
  )];
  console.log(`    ${urls.length} woff2 files`);
  for (const url of urls) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const dataUrl = `url(data:font/woff2;base64,${buf.toString('base64')})`;
    css = css.split(`url(${url})`).join(dataUrl);
  }
  return css;
}

function sh(cmd) { return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }).toString(); }

async function main() {
  console.log('• Building Tailwind...');
  sh('npx tailwindcss -i tools/tailwind.input.css -o tools/.tailwind.css --minify');
  const tailwindCss = fs.readFileSync(path.join(ROOT, 'tools/.tailwind.css'), 'utf8');
  console.log(`  ${(tailwindCss.length / 1024).toFixed(1)} KB`);

  console.log('• Bundling JS...');
  sh('npx esbuild app-v2.js --bundle --format=iife --minify --target=es2020 --outfile=tools/.bundle.js');
  const bundle = fs.readFileSync(path.join(ROOT, 'tools/.bundle.js'), 'utf8');
  console.log(`  ${(bundle.length / 1024).toFixed(1)} KB`);

  console.log('• Fetching + inlining fonts...');
  const textFontsCss = await fetchInlinedFontCss(TEXT_FONTS_URL, 'Assistant + Hanken Grotesk');
  const iconsFontCss = await fetchInlinedFontCss(ICONS_FONT_URL, `Material Symbols (${ICON_NAMES.length} icons)`);

  console.log('• Inlining brand icon...');
  const iconB64 = fs.readFileSync(path.join(ROOT, 'icons/icon-192.png')).toString('base64');
  const iconDataUrl = `data:image/png;base64,${iconB64}`;

  console.log('• Assembling HTML...');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Strip the runtime bootstrap; the bundle is injected inline below. Leaving
  // the module import in place would 404 over file:// and its catch handler
  // would then paint an error over the app the bundle had already booted.
  html = html.replace(/<script>\s*\/\/\s*Tear down any service worker[\s\S]*?<\/script>\s*/g, '');
  html = html.replace(/<script>\s*\/\/\s*Cache-busting bootstrap[\s\S]*?<\/script>\s*/g, '');

  // Drop PWA manifest + favicons (we're file:// now; brand icon is inlined separately).
  html = html.replace(/<link rel="manifest"[^>]*>\s*/g, '');
  html = html.replace(/<link rel="icon"[^>]*>\s*/g, '');
  html = html.replace(/<link rel="shortcut icon"[^>]*>\s*/g, '');
  html = html.replace(/<link rel="apple-touch-icon"[^>]*>\s*/g, '');

  // Replace Tailwind CDN <script> + inline config with the pre-compiled CSS.
  html = html.replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^"]*"><\/script>\s*/g, '');
  html = html.replace(/<script id="tailwind-config">[\s\S]*?<\/script>\s*/g, '');

  // Replace the two Google Fonts <link> tags with our inlined CSS.
  html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Assistant[^"]*" rel="stylesheet"[^>]*>\s*/g, '');
  html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Material\+Symbols[^"]*" rel="stylesheet"[^>]*>\s*/g, '');

  // Inline the brand-icon references.
  html = html.replace(/\.\/icons\/icon-192\.png/g, iconDataUrl);

  // Inject everything we just gathered into <head>: tailwind first
  // (so user <style> overrides it), then the fonts, then a version-tag
  // bootstrap, then the bundled app.
  const headInject = `
<style id="tw">${tailwindCss}</style>
<style id="fonts-text">${textFontsCss}</style>
<style id="fonts-icons">${iconsFontCss}</style>
`;
  html = html.replace('</head>', `${headInject}</head>`);

  const bodyInject = `
<script>window.JI_APP_VERSION = ${JSON.stringify(version)};</script>
<script>${bundle}</script>
`;
  html = html.replace('</body>', `${bodyInject}</body>`);

  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'KidsPortfolio-Offline.html');
  fs.writeFileSync(outPath, html);

  const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`\n✓ ${outPath} (${sizeKb} KB) — v${version}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
