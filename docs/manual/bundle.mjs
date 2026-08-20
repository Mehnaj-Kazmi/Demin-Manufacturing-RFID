/**
 * Packs the manual sources into a zip that Overleaf can open directly, so the
 * PDFs can be produced without installing LaTeX on this machine.
 *
 *   node bundle.mjs
 *
 * Then: overleaf.com -> New Project -> Upload Project -> pick the zip.
 * Set the main document to whichever manual you want and press Recompile.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { platform } from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pack relative to the manual folder however we were invoked.
process.chdir(dirname(fileURLToPath(import.meta.url)));

const ZIP = 'denim-manual-overleaf.zip';
const PARTS = ['main.tex', 'manual-operator.tex', 'manual-qc.tex',
  'manual-supervisor.tex', 'manual-admin.tex', 'content', 'style', 'img',
  'README-overleaf.txt'];

for (const p of PARTS) {
  if (p !== 'README-overleaf.txt' && !existsSync(p)) {
    console.error('Missing: ' + p + ' -- run this from docs/manual/');
    process.exit(1);
  }
}

writeFileSync('README-overleaf.txt', `Denim RFID Track & Trace -- user manuals
========================================================================

Five documents are in this project. In Overleaf, use the Menu button at the
top left, then "Main document", to pick which one to build:

  main.tex               The complete manual, all four portals in one book
  manual-operator.tex    Operator portal only
  manual-qc.tex          Quality Inspector portal only
  manual-supervisor.tex  Supervisor portal only
  manual-admin.tex       Administrator portal only

Set the compiler to pdfLaTeX (Menu -> Compiler). Press Recompile twice on the
first build so the contents page and cross-references settle.

Folders:
  content/   the chapters
  style/     manualstyle.sty, the shared look and feel
  img/       ${readdirSync('img').filter((f) => f.endsWith('.png')).length} screenshots of the running system
`);

if (existsSync(ZIP)) rmSync(ZIP);

let r;
if (platform === 'win32') {
  const list = PARTS.map((p) => "'" + p + "'").join(',');
  r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path ${list} -DestinationPath '${ZIP}' -Force`],
    { stdio: 'inherit' });
} else {
  r = spawnSync('zip', ['-r', '-q', ZIP, ...PARTS], { stdio: 'inherit' });
}

if (r.status !== 0 || !existsSync(ZIP)) {
  console.error('\nCould not create the zip.');
  if (platform !== 'win32') console.error('Is the "zip" command installed?');
  process.exit(1);
}

const kb = Math.round(statSync(ZIP).size / 1024);
console.log('\nWrote ' + ZIP + ' (' + kb + ' KB)');
console.log('\nUpload it at https://overleaf.com -> New Project -> Upload Project.');
console.log('Then set the main document and press Recompile.');
