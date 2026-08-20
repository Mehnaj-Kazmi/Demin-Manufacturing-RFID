/**
 * Prints the HTML manuals to PDF using the Chrome that is already installed,
 * so a finished manual can be produced without a LaTeX toolchain.
 *
 *   node make-html.mjs && node make-pdf.mjs
 *
 * The LaTeX build (build.mjs) remains the reference output; this is the route
 * that works on a machine with no TeX distribution.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(dirname(fileURLToPath(import.meta.url)));

const HTML = 'html';
const OUT = 'pdf';

const CHROMES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome or Edge found. Set CHROME=/path/to/chrome and retry.');
  process.exit(1);
}

if (!existsSync(HTML)) {
  console.error('No html/ folder -- run "node make-html.mjs" first.');
  process.exit(1);
}

const pages = readdirSync(HTML).filter((f) => f.endsWith('.html')).sort();
if (!pages.length) {
  console.error('No HTML files in ' + HTML + '/ -- run "node make-html.mjs" first.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
console.log('Printing with ' + chrome + '\n');

let failed = 0;
for (const page of pages) {
  const src = resolve(HTML, page);
  const dest = resolve(OUT, page.replace(/\.html$/, '.pdf'));
  process.stdout.write('  ' + page.padEnd(28));

  const r = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--generate-pdf-document-outline',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=30000',
    '--print-to-pdf=' + dest,
    'file:///' + src.replace(/\\/g, '/'),
  ], { stdio: 'pipe', timeout: 180000 });

  if (!existsSync(dest)) {
    console.log('FAILED');
    const err = (r.stderr || '').toString().split('\n').filter(Boolean).slice(-3);
    for (const l of err) console.log('      ' + l.trim());
    failed++;
    continue;
  }
  console.log((statSync(dest).size / 1024 / 1024).toFixed(1) + ' MB');
}

console.log('');
if (failed) {
  console.log(failed + ' failed.');
  process.exit(1);
}
console.log('PDFs are in ' + OUT + '/');
