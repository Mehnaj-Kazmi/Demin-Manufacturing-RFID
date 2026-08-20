/**
 * Static checks on the manual sources.
 *
 * There is no LaTeX compiler on this machine, so this verifies the things that
 * most commonly break a build: unbalanced environments and braces, references to
 * labels that do not exist, screenshots that are missing, \input files that are
 * not there, and control sequences nobody has defined. It checks each document
 * separately, because a label defined in a chapter that a particular booklet
 * does not include is still a broken reference in that booklet.
 *
 *   node check.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every path below is relative to the manual, so work from there however we
// were invoked -- "npm run manual:check" starts in the project root.
process.chdir(dirname(fileURLToPath(import.meta.url)));

const DOCS = ['main.tex', 'manual-operator.tex', 'manual-qc.tex',
  'manual-supervisor.tex', 'manual-admin.tex'];

let problems = 0;
const note = (doc, msg) => { console.log('  [' + doc + '] ' + msg); problems++; };

/** Strip comments so a % in prose does not confuse the scanners. */
function strip(src) {
  return src.split('\n')
    .map((line) => {
      let out = '';
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) break;
        out += line[i];
      }
      return out;
    })
    .join('\n');
}

/**
 * Read `count` consecutive brace groups starting at `from`, respecting nesting,
 * so a caption containing \btn{Receive} does not truncate the scan. Returns the
 * group contents, or null if they are not all there.
 */
function braceArgs(src, from, count) {
  const args = [];
  let i = from;
  for (let n = 0; n < count; n++) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    let depth = 0;
    const start = ++i;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        if (depth === 0) break;
        depth--;
      }
    }
    args.push(src.slice(start, i));
    i++;
  }
  return args;
}

/** Every \shot / \shotsmall in the source, as {file, label}. */
function figures(src) {
  const out = [];
  const re = /\\shot(?:small)?(?=\s*\{)/g;
  let m;
  while ((m = re.exec(src))) {
    const args = braceArgs(src, m.index + m[0].length, 3);
    if (args) out.push({ file: args[0].trim(), label: args[2].trim() });
  }
  return out;
}

/* --------------------------------------------------------------- commands */
/* Commands this manual defines for itself, plus the standard ones it uses.  */

const defined = new Set();
if (existsSync('style/manualstyle.sty')) {
  const sty = readFileSync('style/manualstyle.sty', 'utf8');
  for (const m of sty.matchAll(/\\(?:new|renew|provide)command\s*\{?\\(\w+)/g)) defined.add(m[1]);
  for (const m of sty.matchAll(/\\(?:newtcolorbox|newenvironment|definecolor)\s*\{(\w+)\}/g)) defined.add(m[1]);
}

const STANDARD = new Set(`
documentclass usepackage NeedsTeXFormat ProvidesPackage RequirePackage
begin end item chapter section subsection subsubsection part paragraph
label ref autoref pageref cite caption captionsetup input include clearpage newpage
textbf textit texttt textsc textrm emph underline text color textcolor
tableofcontents listoffigures listoftables appendix bibliography
centering raggedright raggedleft small footnotesize scriptsize tiny
large Large LARGE huge Huge normalsize normalfont bfseries itshape ttfamily
vspace hspace quad qquad hfill vfill smallskip medskip bigskip
setlength renewcommand newcommand providecommand def let
toprule midrule bottomrule cmidrule multicolumn multirow
endfirsthead endhead endfoot endlastfoot
includegraphics fbox framebox mbox parbox rule
tikz usetikzlibrary node draw fill path foreach
hypersetup href url nouppercase
pagestyle thepage leftmargin leftmark rightmark fancyhf fancyhead fancyfoot
fancypagestyle headrulewidth footrulewidth titleformat titlespacing
arraystretch parindent parskip linewidth textheight textwidth
chaptertitlename thechapter thesection MakeUppercase fontsize selectfont
Rightarrow Leftarrow leftarrow rightarrow equiv times cdot ldots dots
textbullet textendash textemdash
maketitle titlepage today thanks author title date
protect relax noindent par newline linebreak
alph arabic roman value the ifthenelse
sffamily rmfamily upshape mdseries scshape slshape em
`.trim().split(/\s+/));

const known = new Set([...defined, ...STANDARD]);

/**
 * Flags \Foo where Foo is not a command anyone defined. This is nearly always a
 * "\\" line break that lost one of its backslashes -- {Fabric\Warehouse} instead
 * of {Fabric\\Warehouse} -- which LaTeX rejects as an undefined control sequence.
 * A genuine "\\" followed by a word is fine and is not reported.
 */
function unknownCommands(file, doc) {
  const raw = strip(readFileSync(file, 'utf8'));
  raw.split('\n').forEach((line, n) => {
    for (const m of line.matchAll(/\\([A-Za-z]+)/g)) {
      if (known.has(m[1])) continue;
      let j = m.index - 1, slashes = 0;
      while (j >= 0 && line[j] === '\\') { slashes++; j--; }
      if (slashes % 2 === 1) continue;      // part of a legal \\ line break
      note(doc, file + ':' + (n + 1) + ' undefined command \\' + m[1]
        + '  (a "\\\\" line break that lost a backslash?)');
    }
  });
}

/** Expand \input{...} recursively, returning the combined source. */
function expand(file, doc, seen = new Set(), files = []) {
  if (!existsSync(file)) { note(doc, 'missing file: ' + file); return ''; }
  if (seen.has(file)) return '';
  seen.add(file);
  files.push(file);
  const src = strip(readFileSync(file, 'utf8'));
  return src.replace(/\\input\{([^}]+)\}/g, (_, name) => {
    const path = name.endsWith('.tex') ? name : name + '.tex';
    return '\n' + expand(path, doc, seen, files) + '\n';
  });
}

const allImages = new Set(existsSync('img') ? readdirSync('img') : []);
const usedImages = new Set();
const scanned = new Set();

for (const doc of DOCS) {
  const files = [];
  const src = expand(doc, doc, new Set(), files);
  if (!src) continue;

  /* ---- undefined commands (checked once per file, not once per booklet) ---- */
  for (const f of files) {
    if (scanned.has(f)) continue;
    scanned.add(f);
    unknownCommands(f, doc);
  }

  /* ---- environments balance ---- */
  const stack = [];
  for (const m of src.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else {
      const top = stack.pop();
      if (top !== m[2]) note(doc, 'environment mismatch: \\end{' + m[2] + '} closes \\begin{' + (top || 'nothing') + '}');
    }
  }
  for (const left of stack) note(doc, 'environment never closed: \\begin{' + left + '}');

  /* ---- braces balance ---- */
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }          // skip escaped char
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < 0) { note(doc, 'a closing brace appears before its opening brace'); break; }
  }
  if (depth > 0) note(doc, depth + ' unclosed brace(s)');

  /* ---- labels and references ---- */
  const figs = figures(src);
  const labelList = [...src.matchAll(/\\label\{([^}]+)\}/g)].map((x) => x[1])
    .concat(figs.map((f) => f.label).filter(Boolean));
  const labels = new Set(labelList);

  const refs = [...src.matchAll(/\\(?:ref|autoref|pageref)\{([^}]+)\}/g)].map((x) => x[1]);
  for (const r of new Set(refs)) {
    if (!labels.has(r)) note(doc, 'reference to a label that this document does not define: ' + r);
  }

  /* ---- duplicate labels ---- */
  const seenLabel = new Set();
  for (const l of labelList) {
    if (seenLabel.has(l)) note(doc, 'duplicate label: ' + l);
    seenLabel.add(l);
  }

  /* ---- screenshots exist ---- */
  for (const f of figs) {
    const file = f.file + '.png';
    usedImages.add(file);
    if (!allImages.has(file)) note(doc, 'screenshot not found: img/' + file);
  }

  console.log(doc.padEnd(26) + labels.size + ' labels, ' + new Set(refs).size
    + ' references, ' + figs.length + ' figures');
}

/* ---- screenshots captured but never used ---- */
for (const img of [...allImages].sort()) {
  if (img.endsWith('.png') && !usedImages.has(img)) {
    note('unused', 'img/' + img + ' is captured but not placed in any document');
  }
}

console.log('');
console.log(problems ? problems + ' problem(s) found.' : 'No problems found.');
process.exit(problems ? 1 : 0);
