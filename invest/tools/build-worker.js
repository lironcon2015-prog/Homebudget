// Bundles worker/src/quote-proxy.js into worker/quote-proxy.js — one
// self-contained file to paste into the Cloudflare dashboard.
//
// The worker and the browser price securities from the same sources, and the
// markup patterns for those sources are fiddly enough that two hand-written
// copies drift. So both import src/io/quoteSources.js and the deployable
// worker is generated. The output is committed so it can be copied straight
// out of GitHub without a checkout; CI re-runs this and fails if the committed
// file does not match its source.
//
//   node tools/build-worker.js         # write worker/quote-proxy.js
//   node tools/build-worker.js --check # fail if it is out of date

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'worker/quote-proxy.js');
const BANNER = `// GENERATED FILE — do not edit.
// Built from worker/src/quote-proxy.js + src/io/quoteSources.js by
// tools/build-worker.js. Edit those and rebuild; edits here are overwritten.
//
// Paste this whole file into the Cloudflare dashboard as the worker code.
`;

// Not minified on purpose: this file's job is to be read and pasted by a
// person, and a stack trace from Cloudflare's log tail has to mean something.
const built = execFileSync('npx', [
  'esbuild', 'worker/src/quote-proxy.js',
  '--bundle', '--format=esm', '--target=es2022', '--platform=neutral',
], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const content = BANNER + '\n' + built;
const check = process.argv.includes('--check');
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (check) {
  if (current !== content) {
    console.error('worker/quote-proxy.js is out of date — run: node tools/build-worker.js');
    process.exit(1);
  }
  console.log('worker/quote-proxy.js is up to date');
} else {
  fs.writeFileSync(OUT, content);
  console.log(`• worker/quote-proxy.js — ${(content.length / 1024).toFixed(1)} KB`);
}
