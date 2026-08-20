/**
 * Parses every server and browser module. The browser modules cannot simply be
 * imported here (they touch the DOM), so each is copied to a .mjs file and run
 * through `node --check`, which parses without executing.
 *
 *   node tools/syntaxcheck.js
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const roots = ['server', 'public/js', 'tools'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) files.push(p);
  }
}
for (const r of roots) walk(r);

const tmp = mkdtempSync(join(tmpdir(), 'drfid-syntax-'));
let bad = 0;

for (const f of files) {
  const flat = f.split(sep).join('__').split('/').join('__') + '.mjs';
  const dest = join(tmp, flat);
  writeFileSync(dest, readFileSync(f));
  try {
    execFileSync(process.execPath, ['--check', dest], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    const msg = String(e.stderr || '').split('\n').filter((l) => l.trim()).slice(0, 5).join('\n    ');
    console.log(`SYNTAX ERROR  ${f}\n    ${msg}\n`);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`Checked ${files.length} modules - ${bad ? `${bad} with syntax errors` : 'all parse cleanly'}.`);
process.exit(bad ? 1 : 0);
