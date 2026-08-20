/**
 * Renders the manuals to printable HTML, so a PDF can be produced with a
 * browser on a machine that has no LaTeX installed.
 *
 *   node make-html.mjs
 *
 * The LaTeX sources stay the master copy; this reads the very same content
 * files, so the two outputs cannot drift apart. Anything it does not recognise
 * is reported rather than dropped, so a silent hole in the manual is not
 * possible.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svgFor } from './diagrams.mjs';

process.chdir(dirname(fileURLToPath(import.meta.url)));

const OUT = 'html';

const DOCS = [
  { file: 'main.tex', name: 'Complete Manual', sub: 'All four portals', colour: '#1D4ED8' },
  { file: 'manual-operator.tex', name: 'Operator Portal', sub: 'For staff working at a station on the factory floor', colour: '#3D7EC2' },
  { file: 'manual-qc.tex', name: 'Quality Inspector Portal', sub: 'For staff at the inspection benches', colour: '#C0392B' },
  { file: 'manual-supervisor.tex', name: 'Supervisor Portal', sub: 'For the person in charge of a department', colour: '#5B53C9' },
  { file: 'manual-admin.tex', name: 'Administrator Portal', sub: 'For plant management and the system administrator', colour: '#2D8A4E' },
];

const warnings = [];
const warn = (doc, msg) => warnings.push('[' + doc + '] ' + msg);

/* ------------------------------------------------------------------ source */

function strip(src) {
  return src.split('\n').map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) break;
      out += line[i];
    }
    return out;
  }).join('\n');
}

function expand(file, seen = new Set()) {
  if (!existsSync(file) || seen.has(file)) return '';
  seen.add(file);
  return strip(readFileSync(file, 'utf8')).replace(/\\input\{([^}]+)\}/g, (_, n) => {
    const p = n.endsWith('.tex') ? n : n + '.tex';
    return '\n' + expand(p, seen) + '\n';
  });
}

/** The body between \begin{document} and \end{document}, minus the title page. */
function body(src) {
  const b = src.indexOf('\\begin{document}');
  let s = b < 0 ? src : src.slice(b + '\\begin{document}'.length);
  const e = s.indexOf('\\end{document}');
  if (e >= 0) s = s.slice(0, e);
  return s.replace(/\\begin\{titlepage\}[\s\S]*?\\end\{titlepage\}/g, '');
}

/* ---------------------------------------------------------------- brace args */

function args(src, from, count) {
  const out = [];
  let i = from;
  for (let n = 0; n < count; n++) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    let depth = 0;
    const start = ++i;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { if (depth === 0) break; depth--; }
    }
    out.push(src.slice(start, i));
    i++;
  }
  out.end = i;
  return out;
}

/**
 * Splits a list body on \item, but only at the top level -- a \begin{bullets}
 * nested inside a step must stay in one piece rather than being torn across
 * two list items.
 */
function splitItems(src) {
  const re = /\\(begin|end)\{[a-zA-Z*]+\}|\\item\b/g;
  const marks = [];
  let depth = 0, m;
  while ((m = re.exec(src))) {
    if (m[1] === 'begin') depth++;
    else if (m[1] === 'end') depth--;
    else if (depth === 0) marks.push({ start: m.index, after: re.lastIndex });
  }
  return marks.map((mk, k) =>
    src.slice(mk.after, k + 1 < marks.length ? marks[k + 1].start : src.length));
}

/** Finds the \end{name} that matches the \begin{name} starting at `from`. */
function matchEnd(src, name, from) {
  const re = new RegExp('\\\\(begin|end)\\{' + name + '\\}', 'g');
  re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(src))) {
    if (m[1] === 'begin') depth++;
    else if (--depth === 0) return { start: m.index, after: re.lastIndex };
  }
  return null;
}

/* ------------------------------------------------------------------ inline */

const esc = (s) => s.replace(/&(?![a-z]+;|#\d+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const INLINE = [
  [/\\btn\{([^{}]*)\}/g, '<span class="btn">$1</span>'],
  [/\\menu\{([^{}]*)\}/g, '<span class="menu">$1</span>'],
  [/\\field\{([^{}]*)\}/g, '<em class="field">$1</em>'],
  [/\\typed\{([^{}]*)\}/g, '<code>$1</code>'],
  [/\\texttt\{([^{}]*)\}/g, '<code>$1</code>'],
  [/\\textbf\{([^{}]*)\}/g, '<strong>$1</strong>'],
  [/\\textit\{([^{}]*)\}/g, '<em>$1</em>'],
  [/\\emph\{([^{}]*)\}/g, '<em>$1</em>'],
  [/\\textcolor\{[^{}]*\}\{([^{}]*)\}/g, '$1'],
  [/\\text\{([^{}]*)\}/g, '$1'],
];

function inline(sIn, doc) {
  let s = sIn;

  // maths fragments actually used by this manual
  s = s.replace(/\$\\Rightarrow\$/g, '&#8658;').replace(/\$\\equiv\$/g, '&#8801;')
    .replace(/\$\\cdot\$/g, '&#183;').replace(/\$\\times\$/g, '&#215;');

  s = s.replace(/\\%/g, 'PC').replace(/\\&/g, 'AMP')
    .replace(/\\_/g, '_').replace(/\\#/g, '#').replace(/\\\$/g, '$');

  s = esc(s);

  // commands innermost-first, until nothing changes
  for (let pass = 0; pass < 8; pass++) {
    const before = s;
    for (const [re, to] of INLINE) s = s.replace(re, to);
    if (s === before) break;
  }

  s = s.replace(/\\ldots/g, '&hellip;').replace(/\\textbullet/g, '&bull;')
    .replace(/\\newline\b/g, '<br>').replace(/\\\\(\[[^\]]*\])?/g, '<br>')
    .replace(/\\,/g, ' ').replace(/\\ /g, ' ').replace(/~/g, '&nbsp;');

  s = s.replace(/``([^']*)''/g, '&ldquo;$1&rdquo;').replace(/`([^']*)'/g, '&lsquo;$1&rsquo;')
    .replace(/---/g, '&mdash;').replace(/(\s)--(\s)/g, '$1&ndash;$2');

  s = s.replace(/PC/g, '%').replace(/AMP/g, '&amp;');

  const left = s.match(/\\[a-zA-Z]+/g);
  if (left) for (const c of new Set(left)) warn(doc, 'unhandled command in text: ' + c);

  return s.replace(/\{|\}/g, '').trim();
}

/* ------------------------------------------------------------------ tables */

function table(bodySrc, doc) {
  let s = bodySrc.replace(/\\(?:endfirsthead|endhead|endlastfoot)\b/g, 'HDR')
    .replace(/\\endfoot\b/g, 'FOOT');

  // A longtable repeats its header; keep only what comes after the last marker.
  const lastMarker = Math.max(s.lastIndexOf('HDR'), s.lastIndexOf('FOOT'));
  let head = '', rest = s;
  if (lastMarker >= 0) {
    head = s.slice(0, s.indexOf('HDR') < 0 ? 0 : s.indexOf('HDR'));
    rest = s.slice(lastMarker + 7);
  }

  const cut = (t) => t.replace(/\\(?:toprule|midrule|bottomrule)\b/g, 'RULE');
  let headerCells = null;

  if (head) {
    const hRows = cut(head).split('RULE').map((x) => x.trim()).filter(Boolean);
    if (hRows.length) headerCells = hRows[0].replace(/\\\\\s*$/, '').split('&');
  }

  const parts = cut(rest).split('RULE');
  let bodyText = rest;
  if (!headerCells && parts.length >= 2) {
    const first = parts[0].trim().replace(/\\\\\s*$/, '');
    if (first) headerCells = first.split('&');
    bodyText = parts.slice(1).join('\n');
  } else {
    bodyText = parts.join('\n');
  }

  const rows = bodyText.split(/\\\\/).map((r) => r.trim())
    .filter((r) => r && r !== 'RULE')
    .map((r) => r.replace(/RULE/g, '').trim()).filter(Boolean);

  let out = '<table>';
  if (headerCells) {
    out += '<thead><tr>' + headerCells.map((c) => '<th>' + inline(c, doc) + '</th>').join('') + '</tr></thead>';
  }
  out += '<tbody>';
  for (const r of rows) {
    out += '<tr>' + r.split('&').map((c) => '<td>' + inline(c, doc) + '</td>').join('') + '</tr>';
  }
  return out + '</tbody></table>';
}

/* --------------------------------------------------------------- rendering */

const CALLOUTS = {
  tipbox: ['tip', 'Helpful to know'],
  warnbox: ['warn', 'Take care'],
  stopbox: ['stop', 'Important'],
  plainwords: ['words', 'In plain words'],
  plainbox: ['plain', null],
};

function render(src, ctx) {
  let out = '';
  let i = 0;
  let text = '';

  const flush = () => {
    const t = text; text = '';
    if (!t.trim()) return;
    for (const para of t.split(/\n\s*\n/)) {
      const h = inline(para, ctx.doc);
      if (h) out += '<p>' + h + '</p>';
    }
  };

  while (i < src.length) {
    const nb = src.indexOf('\\begin{', i);
    const cmd = src.slice(i).search(/\\(chapter|section|subsection|part|shot|shotsmall|label|portalcover|tableofcontents|clearpage|newpage|caption|centering|small|scriptsize|bfseries|itshape|noindent)\b/);
    const nextCmd = cmd < 0 ? -1 : i + cmd;

    if (nb < 0 && nextCmd < 0) { text += src.slice(i); break; }

    const next = nb < 0 ? nextCmd : (nextCmd < 0 ? nb : Math.min(nb, nextCmd));
    text += src.slice(i, next);

    if (next === nb) {
      /* ---- environment ---- */
      const m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(next));
      const name = m[1];
      const end = matchEnd(src, name, next);
      if (!end) { warn(ctx.doc, 'never closed: ' + name); text += src.slice(next); break; }
      let inner = src.slice(next + m[0].length, end.start);
      i = end.after;

      if (name === 'steps' || name === 'bullets') {
        flush();
        const tag = name === 'steps' ? 'ol' : 'ul';
        const items = splitItems(inner);
        out += '<' + tag + '>' + items.map((it) =>
          '<li>' + render(it, ctx) + '</li>').join('') + '</' + tag + '>';
      } else if (CALLOUTS[name]) {
        flush();
        const [cls, title] = CALLOUTS[name];
        inner = inner.replace(/^\s*\[[^\]]*\]/, '');
        out += '<div class="callout ' + cls + '">'
          + (title ? '<div class="ct">' + title + '</div>' : '')
          + render(inner, ctx) + '</div>';
      } else if (name === 'tabular' || name === 'longtable') {
        flush();
        const spec = args(inner, inner.search(/\S/), 1);
        const afterSpec = spec ? spec.end : 0;
        out += table(inner.slice(afterSpec), ctx.doc);
      } else if (name === 'table' || name === 'figure') {
        flush();
        inner = inner.replace(/^\s*\[[^\]]*\]/, '');   // drop the [H] placement option
        const capM = /\\caption\{/.exec(inner);
        let caption = '';
        if (capM) {
          const a = args(inner, capM.index + capM[0].length - 1, 1);
          if (a) { caption = a[0]; inner = inner.slice(0, capM.index) + inner.slice(a.end); }
        }
        const labM = /\\label\{([^}]*)\}/.exec(inner);
        const id = labM ? labM[1] : null;
        if (labM) inner = inner.replace(labM[0], '');
        const num = id && ctx.numbers[id] ? ctx.numbers[id] : (name === 'figure' ? ++ctx.fig : ++ctx.tab);
        const kind = name === 'figure' ? 'Figure' : 'Table';
        out += '<figure class="' + name + '"' + (id ? ' id="' + id + '"' : '') + '>'
          + render(inner, ctx)
          + (caption ? '<figcaption><b>' + kind + ' ' + num + '.</b> '
            + inline(caption, ctx.doc) + '</figcaption>' : '')
          + '</figure>';
      } else if (name === 'tikzpicture') {
        flush();
        const d = svgFor(inner);
        if (d) out += '<div class="diagram">' + d.svg + '</div>';
        else warn(ctx.doc, 'no SVG for a tikzpicture -- diagram omitted');
      } else if (name === 'center') {
        flush();
        out += '<div class="center">' + render(inner, ctx) + '</div>';
      } else {
        warn(ctx.doc, 'unknown environment: ' + name);
        text += inner;
      }
      continue;
    }

    /* ---- command ---- */
    const rest = src.slice(next);
    let m;

    if ((m = /^\\(chapter|section|subsection|part)\b\*?/.exec(rest))) {
      flush();
      const a = args(rest, m[0].length, 1);
      if (!a) { i = next + m[0].length; continue; }
      const title = inline(a[0], ctx.doc);
      const kind = m[1];
      i = next + a.end;

      // a \label immediately after the heading belongs to it
      const after = src.slice(i, i + 120);
      const lm = /^\s*\\label\{([^}]*)\}/.exec(after);
      let id = null;
      if (lm) { id = lm[1]; i += lm[0].length; }

      if (kind === 'part') {
        out += '<h1 class="part">' + title + '</h1>';
      } else if (kind === 'chapter') {
        ctx.chapter++; ctx.section = 0; ctx.fig = 0; ctx.tab = 0;
        out += '<h1 class="chapter"' + (id ? ' id="' + id + '"' : '')
          + '><span class="cn">Chapter ' + ctx.chapter + '</span>' + title + '</h1>';
        ctx.toc.push({ level: 1, n: String(ctx.chapter), title, id });
      } else if (kind === 'section') {
        ctx.section++; ctx.sub = 0;
        const n = ctx.chapter + '.' + ctx.section;
        out += '<h2' + (id ? ' id="' + id + '"' : '') + '><span class="sn">' + n + '</span>' + title + '</h2>';
        ctx.toc.push({ level: 2, n, title, id });
      } else {
        ctx.sub++;
        const n = ctx.chapter + '.' + ctx.section + '.' + ctx.sub;
        out += '<h3' + (id ? ' id="' + id + '"' : '') + '><span class="sn">' + n + '</span>' + title + '</h3>';
      }
      continue;
    }

    if ((m = /^\\(shot|shotsmall)\b/.exec(rest))) {
      flush();
      const a = args(rest, m[0].length, 3);
      if (!a) { warn(ctx.doc, 'malformed ' + m[1]); i = next + m[0].length; continue; }
      const [file, caption, id] = a;
      i = next + a.end;
      if (!existsSync(join('img', file.trim() + '.png'))) {
        warn(ctx.doc, 'screenshot missing from disk: img/' + file.trim() + '.png');
      }
      const num = ctx.numbers[id] || (++ctx.fig, ctx.chapter + '.' + ctx.fig);
      // the pages live in html/, the screenshots one level up in img/
      out += '<figure class="shot ' + m[1] + '" id="' + id + '">'
        + '<img src="../img/' + file.trim() + '.png" alt="' + esc(caption).replace(/"/g, '') + '">'
        + '<figcaption><b>Figure ' + num + '.</b> ' + inline(caption, ctx.doc) + '</figcaption>'
        + '</figure>';
      continue;
    }

    if ((m = /^\\portalcover\b/.exec(rest))) {
      const a = args(rest, m[0].length, 3);
      i = a ? next + a.end : next + m[0].length;
      continue;
    }

    if ((m = /^\\label\{([^}]*)\}/.exec(rest))) { i = next + m[0].length; continue; }
    if ((m = /^\\caption\b/.exec(rest))) {
      const a = args(rest, m[0].length, 1);
      i = a ? next + a.end : next + m[0].length;
      continue;
    }
    if ((m = /^\\(tableofcontents|clearpage|newpage|centering|small|scriptsize|bfseries|itshape|noindent)\b/.exec(rest))) {
      i = next + m[0].length;
      continue;
    }

    text += src[next];
    i = next + 1;
  }

  flush();
  return out;
}

/* ------------------------------------------------- numbering pass for \ref */

function numberPass(src, doc) {
  const numbers = {};
  let chapter = 0, section = 0, sub = 0, fig = 0, tab = 0;
  const re = /\\(chapter|section|subsection|shot|shotsmall)\b\*?|\\begin\{(figure|table)\}/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2]) {
      // A float carrying its own \label -- number it and skip past its body.
      const end = matchEnd(src, m[2], m.index);
      const inner = src.slice(m.index, end ? end.start : src.length);
      const lm = /\\label\{([^}]*)\}/.exec(inner);
      // \shot inside a float would double-count; these floats never contain one
      const n = m[2] === 'figure' ? ++fig : ++tab;
      if (lm) numbers[lm[1]] = chapter + '.' + n;
      if (end) re.lastIndex = end.after;
      continue;
    }
    if (m[1] === 'chapter' || m[1] === 'section' || m[1] === 'subsection') {
      const a = args(src, m.index + m[0].length, 1);
      if (!a) continue;
      if (m[1] === 'chapter') { chapter++; section = 0; fig = 0; tab = 0; }
      else if (m[1] === 'section') { section++; sub = 0; }
      else sub++;
      const lm = /^\s*\\label\{([^}]*)\}/.exec(src.slice(a.end, a.end + 120));
      if (lm) {
        numbers[lm[1]] = m[1] === 'chapter' ? String(chapter)
          : m[1] === 'section' ? chapter + '.' + section
            : chapter + '.' + section + '.' + sub;
      }
      re.lastIndex = a.end;
    } else if (m[1] === 'shot' || m[1] === 'shotsmall') {
      const a = args(src, m.index + m[0].length, 3);
      if (!a) continue;
      fig++;
      if (a[2]) numbers[a[2].trim()] = chapter + '.' + fig;
      re.lastIndex = a.end;
    }
  }
  return numbers;
}

/* --------------------------------------------------------------------- CSS */

const CSS = `
:root{--blue:#1D4ED8;--ink:#16202E;--grey:#5A6B80;--line:#DDE3EC;--soft:#E7EDFE;
--green:#17794A;--gsoft:#DCF3E7;--amber:#A86200;--asoft:#FDF0D5;--red:#B3261E;
--rsoft:#FCE8E6;--teal:#0E6F8F;--tsoft:#DCF0F7}
*{box-sizing:border-box}
body{font:11pt/1.55 "Segoe UI",Helvetica,Arial,sans-serif;color:var(--ink);margin:0}
.page{max-width:170mm;margin:0 auto;padding:0 4mm}
h1.chapter{color:var(--blue);font-size:26pt;line-height:1.15;margin:0 0 18pt;
padding-top:6pt;break-before:page;page-break-before:always}
h1.chapter:first-of-type{break-before:avoid;page-break-before:avoid}
h1.chapter .cn{display:block;font-size:10pt;color:var(--grey);font-weight:600;
text-transform:uppercase;letter-spacing:.09em;margin-bottom:5pt}
h1.part{color:#fff;background:var(--blue);font-size:22pt;padding:14pt 16pt;
border-radius:5pt;margin:0 0 18pt;break-before:page;page-break-before:always}
h2{font-size:15pt;margin:20pt 0 7pt;break-after:avoid;page-break-after:avoid}
h3{font-size:12.5pt;margin:14pt 0 5pt;break-after:avoid;page-break-after:avoid}
h2 .sn,h3 .sn{color:var(--grey);font-weight:600;margin-right:7pt}
p{margin:0 0 8pt;orphans:3;widows:3}
ol,ul{margin:0 0 10pt;padding-left:20pt}
li{margin-bottom:4pt}
li p{margin:0 0 4pt}
code{background:#F3F5F9;border:1px solid var(--line);border-radius:3px;
padding:0 4px;font:10pt "Consolas",monospace}
.btn{display:inline-block;border:1px solid var(--line);background:#fff;
border-radius:3px;padding:0 5px;font-weight:700;font-size:9.6pt;
box-shadow:0 1px 0 rgba(0,0,0,.06);white-space:nowrap}
.menu{color:var(--blue);font-weight:700}
.field{font-style:italic}
table{border-collapse:collapse;width:100%;margin:0 0 12pt;font-size:10pt;
break-inside:auto}
th{text-align:left;border-bottom:1.6px solid var(--ink);padding:5pt 7pt 5pt 0;
vertical-align:bottom}
td{border-bottom:1px solid var(--line);padding:5pt 7pt 5pt 0;vertical-align:top}
tr{break-inside:avoid;page-break-inside:avoid}
figure{margin:0 0 14pt;break-inside:avoid;page-break-inside:avoid}
figure.shot img{width:100%;border:1px solid var(--line);border-radius:3px;display:block}
figure.shotsmall img{width:86%;margin:0 auto}
figcaption{font-size:9.4pt;color:var(--grey);margin-top:5pt;text-align:left}
figcaption b{color:var(--blue)}
.diagram{margin:6pt 0}
.diagram svg{width:100%;height:auto}
.callout{border-left:3.5px solid;border-radius:3px;padding:9pt 11pt;margin:0 0 12pt;
break-inside:avoid;page-break-inside:avoid}
.callout .ct{font-weight:700;font-size:9.4pt;margin-bottom:4pt;
text-transform:uppercase;letter-spacing:.045em}
.callout p:last-child{margin-bottom:0}
.tip{background:var(--gsoft);border-color:var(--green)}.tip .ct{color:var(--green)}
.warn{background:var(--asoft);border-color:var(--amber)}.warn .ct{color:var(--amber)}
.stop{background:var(--rsoft);border-color:var(--red)}.stop .ct{color:var(--red)}
.words{background:var(--tsoft);border-color:var(--teal)}.words .ct{color:var(--teal)}
.plain{background:var(--soft);border-color:var(--blue)}
.cover{height:247mm;display:flex;flex-direction:column;justify-content:space-between;
break-after:page;page-break-after:always}
.cover .band{background:var(--cv);color:#fff;margin:-0 -4mm 0;padding:26mm 12mm 18mm;
border-radius:0 0 6pt 6pt}
.cover .band h1{font-size:34pt;margin:0;line-height:1.12}
.cover .band .s{font-size:15pt;margin-top:10mm;opacity:.93}
.cover .mid{padding:0 4mm}
.cover .lead{font-size:14pt;font-weight:700;margin-bottom:6pt}
.cover .note{color:var(--grey);font-size:11.5pt}
.cover .box{background:var(--soft);border-left:3.5px solid var(--blue);
border-radius:3px;padding:11pt 13pt;font-size:11pt}
.cover .foot{color:var(--grey);font-size:9.5pt;padding:0 4mm 4mm}
.toc{break-after:page;page-break-after:always}
.toc h1{color:var(--blue);font-size:22pt;margin:0 0 14pt}
.toc a{color:var(--ink);text-decoration:none;display:flex;gap:8pt;
padding:2.5pt 0;border-bottom:1px dotted var(--line)}
.toc .l1{font-weight:700;margin-top:7pt}
.toc .l2{padding-left:16pt;font-size:10pt;color:var(--grey)}
.toc .n{color:var(--grey);min-width:34pt;font-variant-numeric:tabular-nums}
@page{size:A4;margin:18mm 20mm}
@media print{.page{max-width:none;padding:0}.cover .band{margin:0;padding:26mm 14mm 18mm}}
`;

/* ------------------------------------------------------------------- build */

mkdirSync(OUT, { recursive: true });
console.log('Rendering HTML\n');

for (const d of DOCS) {
  if (!existsSync(d.file)) { console.log('  missing ' + d.file); continue; }
  const src = body(expand(d.file));
  const numbers = numberPass(src, d.file);
  const ctx = { doc: d.file, chapter: 0, section: 0, sub: 0, fig: 0, tab: 0, numbers, toc: [] };

  // \ref resolves from the numbering pass; anything unresolved is reported
  const resolved = src.replace(/\\(?:ref|autoref|pageref)\{([^}]*)\}/g, (_, id) => {
    if (!numbers[id]) { warn(d.file, 'unresolved reference: ' + id); return '?'; }
    return numbers[id];
  });

  const html = render(resolved, ctx);

  const toc = ctx.toc.map((t) =>
    '<a class="' + (t.level === 1 ? 'l1' : 'l2') + '"'
    + (t.id ? ' href="#' + t.id + '"' : '')
    + '><span class="n">' + t.n + '</span><span>' + t.title + '</span></a>').join('');

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Denim RFID Track &amp; Trace &mdash; ${d.name}</title>
<style>${CSS}</style></head><body><div class="page">
<section class="cover" style="--cv:${d.colour}">
  <div class="band"><h1>Denim RFID<br>Track &amp; Trace</h1><div class="s">${d.name}</div></div>
  <div class="mid">
    <div class="lead">${d.sub}</div>
    <p class="note">This manual assumes no computer experience. Every screen you will
    meet is pictured, every button you need to press is named, and every word that
    might be unfamiliar is explained in plain language.</p>
    <div class="box"><b>What this software does, in one sentence.</b><br>
    Every pair of jeans gets a small electronic tag when it is stitched, and from
    that moment the computer always knows where that garment is, how long it has
    been there, and who last handled it &mdash; right up to the moment it is packed
    for the customer.</div>
  </div>
  <div class="foot">Generated from the LaTeX sources in docs/manual &middot;
  ${new Date().toISOString().slice(0, 10)}</div>
</section>
<section class="toc"><h1>Contents</h1>${toc}</section>
${html}
</div></body></html>`;

  const path = join(OUT, d.file.replace(/\.tex$/, '.html'));
  writeFileSync(path, page);
  const figs = (html.match(/<figure/g) || []).length;
  console.log('  ' + d.name.padEnd(26) + ctx.toc.filter((t) => t.level === 1).length
    + ' chapters, ' + figs + ' figures  -> ' + path);
}

console.log('');
if (warnings.length) {
  const seen = new Set();
  for (const w of warnings) if (!seen.has(w)) { seen.add(w); console.log('  ' + w); }
  console.log('\n' + seen.size + ' warning(s).');
} else {
  console.log('No warnings.');
}
