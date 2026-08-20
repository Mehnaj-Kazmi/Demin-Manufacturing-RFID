/**
 * Builds the manuals to PDF.
 *
 * Finds whichever LaTeX engine is installed and runs it. Each document is
 * compiled twice so the table of contents, the figure numbers and the
 * cross-references are correct on the second pass.
 *
 *   node build.mjs              build all five documents
 *   node build.mjs admin qc     build only the ones whose name contains these
 *
 * If no LaTeX engine is installed, this explains the two ways to get one and
 * exits without pretending to have built anything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// LaTeX resolves img/ and style/ relative to the working directory, so build
// from the manual folder however we were invoked.
process.chdir(dirname(fileURLToPath(import.meta.url)));

const DOCS = [
  ['main.tex', 'Complete manual (all four portals)'],
  ['manual-operator.tex', 'Operator portal'],
  ['manual-qc.tex', 'Quality Inspector portal'],
  ['manual-supervisor.tex', 'Supervisor portal'],
  ['manual-admin.tex', 'Administrator portal'],
];

const OUT = 'build';
const PDF = 'pdf';

/* ------------------------------------------------------------ find engine */

const CANDIDATES = [
  { cmd: 'latexmk', args: (f) => ['-pdf', '-interaction=nonstopmode', '-halt-on-error',
    '-outdir=' + OUT, f], passes: 1 },
  { cmd: 'tectonic', args: (f) => ['--outdir', OUT, '--keep-logs', f], passes: 1 },
  { cmd: 'pdflatex', args: (f) => ['-interaction=nonstopmode', '-halt-on-error',
    '-output-directory=' + OUT, f], passes: 2 },
  { cmd: 'xelatex', args: (f) => ['-interaction=nonstopmode', '-halt-on-error',
    '-output-directory=' + OUT, f], passes: 2 },
  { cmd: 'lualatex', args: (f) => ['-interaction=nonstopmode', '-halt-on-error',
    '-output-directory=' + OUT, f], passes: 2 },
];

/**
 * Is this command on the PATH? Asking the operating system's own lookup is the
 * only reliable test -- running "<cmd> --version" cannot tell a tool that exits
 * non-zero apart from one that is not installed at all.
 */
function which(cmd) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'where' : 'command', win ? [cmd] : ['-v', cmd],
    { stdio: 'ignore', shell: !win });
  return r.status === 0;
}

const engine = CANDIDATES.find((c) => which(c.cmd));

if (!engine) {
  console.log(`
No LaTeX engine found on this machine, so the PDFs cannot be built here.
The manual sources are complete and verified -- you only need a compiler.

Three ways to get a PDF:

  1. Print with the browser you already have (no install at all)
     ---------------------------------------------------------------
     node make-html.mjs && node make-pdf.mjs

     Renders the same content files to HTML and prints them to PDF with
     the installed Chrome or Edge. Output lands in pdf/.

  2. Build the real LaTeX online
     ---------------------------------------------------------------
     node bundle.mjs

     That writes denim-manual-overleaf.zip. Go to https://overleaf.com,
     choose New Project -> Upload Project, and drop the zip in. Set the
     main document to whichever manual you want and press Recompile.

  3. Install a LaTeX distribution, then re-run this script
     ---------------------------------------------------------------
     Windows : winget install MiKTeX.MiKTeX
     macOS   : brew install --cask mactex-no-gui
     Linux   : sudo apt install texlive-full

     MiKTeX downloads the extra packages this manual needs (tcolorbox,
     tikz, booktabs, longtable) on first build. Allow it when it asks.

Either way, run "node check.mjs" first -- it catches the mistakes that
break a build, without needing a compiler.
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ build */

const filter = process.argv.slice(2);
const wanted = filter.length
  ? DOCS.filter(([f]) => filter.some((k) => f.includes(k)))
  : DOCS;

if (!wanted.length) {
  console.log('Nothing matched: ' + filter.join(', '));
  console.log('Available: ' + DOCS.map(([f]) => f).join(', '));
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(PDF, { recursive: true });

console.log('Engine: ' + engine.cmd + '\n');

let failed = 0;
for (const [file, title] of wanted) {
  if (!existsSync(file)) { console.log('MISSING  ' + file); failed++; continue; }

  process.stdout.write(title.padEnd(38) + ' ');
  let ok = true;
  for (let pass = 1; pass <= engine.passes; pass++) {
    const r = spawnSync(engine.cmd, engine.args(file), { stdio: 'pipe', shell: true });
    if (r.status !== 0) {
      ok = false;
      const log = join(OUT, file.replace(/\.tex$/, '.log'));
      console.log('FAILED (pass ' + pass + ')');
      if (existsSync(log)) console.log('         see ' + log);
      const out = (r.stdout || '').toString().split('\n')
        .filter((l) => l.startsWith('!') || l.includes('Error')).slice(0, 6);
      for (const l of out) console.log('         ' + l.trim());
      break;
    }
  }
  if (!ok) { failed++; continue; }

  const built = join(OUT, file.replace(/\.tex$/, '.pdf'));
  if (existsSync(built)) {
    copyFileSync(built, join(PDF, file.replace(/\.tex$/, '.pdf')));
    console.log('ok');
  } else {
    console.log('no PDF produced');
    failed++;
  }
}

console.log('');
if (failed) {
  console.log(failed + ' document(s) failed. Intermediate files are in ' + OUT + '/');
  process.exit(1);
}
const made = readdirSync(PDF).filter((f) => f.endsWith('.pdf'));
console.log('Built ' + made.length + ' PDF(s) in ' + PDF + '/:');
for (const f of made.sort()) console.log('  ' + f);
