/**
 * SVG versions of the three TikZ diagrams, for the HTML/PDF build.
 *
 * The LaTeX build draws these with TikZ; a browser cannot. Each function here
 * reproduces the same picture in SVG so both outputs say the same thing. They
 * are picked by looking for a distinctive string in the tikzpicture source, so
 * editing the LaTeX layout does not silently swap the wrong drawing in.
 */

const C = {
  fabric: '#8B6F47', cut: '#C2703D', stitch: '#3D7EC2', sort: '#5B53C9',
  wash: '#2F9E8F', finish: '#D29B1E', qc: '#C0392B', retro: '#E07B39',
  disp: '#2D8A4E', grey: '#5A6B80', blue: '#1D4ED8', soft: '#E7EDFE',
  ink: '#16202E', green: '#17794A', red: '#B3261E',
};

const defs = `<defs>
  <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"
          markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.grey}"/>
  </marker>
  <marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"
          markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.blue}"/>
  </marker>
</defs>`;

/** A rounded box with one or two lines of centred white text. */
function box(x, y, w, h, fill, lines, size = 12) {
  const ls = [].concat(lines);
  const first = y + h / 2 - (ls.length - 1) * (size * 0.62);
  const text = ls.map((l, i) =>
    `<text x="${x + w / 2}" y="${first + i * size * 1.25}" fill="#fff"
       font-size="${size}" font-weight="700" text-anchor="middle"
       dominant-baseline="middle">${l}</text>`).join('');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}"/>${text}`;
}

function arrow(x1, y1, x2, y2, dashed = false, colour = C.grey) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colour}"
    stroke-width="1.8" marker-end="url(#${colour === C.blue ? 'ahb' : 'ah'})"
    ${dashed ? 'stroke-dasharray="5 4"' : ''}/>`;
}

function lbl(x, y, t, anchor = 'middle') {
  return `<text x="${x}" y="${y}" fill="${C.grey}" font-size="9.5"
    font-style="italic" text-anchor="${anchor}">${t}</text>`;
}

/* ------------------------------------------------- 1. the production route */

function routeDiagram() {
  const W = 132, H = 46, GAP = 28;
  const xs = [10, 10 + W + GAP, 10 + 2 * (W + GAP), 10 + 3 * (W + GAP)];
  const r1 = 14, r2 = 118, r3 = 222;
  let s = '';

  s += box(xs[0], r1, W, H, C.fabric, ['Fabric', 'Warehouse']);
  s += box(xs[1], r1, W, H, C.cut, 'Cutting');
  s += box(xs[2], r1, W, H, C.stitch, 'Stitching');
  s += box(xs[3], r1, W, H, C.sort, 'Sorting');

  s += box(xs[0], r2, W, H, C.retro, 'Retrofitting');
  s += box(xs[1], r2, W, H, C.qc, ['Quality', 'Control']);
  s += box(xs[2], r2, W, H, C.finish, 'Finishing');
  s += box(xs[3], r2, W, H, C.wash, ['Washing &amp;', 'Treatment']);

  s += box(xs[0], r3, W, H, C.disp, ['Dispatch &amp;', 'Packing']);
  s += box(xs[1], r3, W, H, C.grey, 'Shipped');

  // top row, left to right
  for (let i = 0; i < 3; i++) s += arrow(xs[i] + W, r1 + H / 2, xs[i + 1] - 4, r1 + H / 2);
  s += lbl(xs[0] + W + GAP / 2, r1 + H / 2 - 7, 'rolls');
  s += lbl(xs[1] + W + GAP / 2, r1 + H / 2 - 7, 'hand count');
  s += lbl(xs[2] + W + GAP / 2, r1 + H / 2 - 7, 'tag added');

  // down the right-hand side
  s += arrow(xs[3] + W / 2, r1 + H, xs[3] + W / 2, r2 - 4);

  // second row, right to left
  for (let i = 3; i > 0; i--) s += arrow(xs[i], r2 + H / 2, xs[i - 1] + W + 4, r2 + H / 2);
  s += lbl(xs[0] + W + GAP / 2, r2 + H / 2 - 7, 'failed');

  // down the left-hand side into dispatch
  s += arrow(xs[0] + W / 2, r2 + H, xs[0] + W / 2, r3 - 4);
  s += arrow(xs[0] + W, r3 + H / 2, xs[1] - 4, r3 + H / 2);
  s += lbl(xs[0] + W + GAP / 2, r3 + H / 2 - 7, 'new tag');

  // corrected work goes back to QC; passed work skips to dispatch
  s += `<path d="M ${xs[0] + W * 0.72} ${r2} C ${xs[0] + W * 0.9} ${r2 - 26},
      ${xs[1] + W * 0.1} ${r2 - 26}, ${xs[1] + W * 0.28} ${r2 - 4}"
      fill="none" stroke="${C.grey}" stroke-width="1.6" stroke-dasharray="5 4"
      marker-end="url(#ah)"/>`;
  s += lbl((xs[0] + xs[1]) / 2 + W * 0.5, r2 - 30, 'corrected, back to QC');

  s += `<path d="M ${xs[1] + W * 0.5} ${r2 + H} C ${xs[1] + W * 0.5} ${r2 + H + 30},
      ${xs[1] + W * 0.5} ${r3 - 10}, ${xs[1] + W * 0.5} ${r3 - 4}"
      fill="none" stroke="${C.grey}" stroke-width="1.6" stroke-dasharray="5 4"
      marker-end="url(#ah)"/>`;
  s += lbl(xs[1] + W * 0.5 + 30, r2 + H + 26, 'passed', 'start');

  return `<svg viewBox="0 0 660 296" xmlns="http://www.w3.org/2000/svg"
    font-family="Helvetica, Arial, sans-serif">${defs}${s}</svg>`;
}

/* ------------------------------------------------------ 2. the two-sided count */

function tallyDiagram() {
  const W = 150, H = 62, y = 12;
  const x1 = 8, x2 = 255, x3 = 502;
  let s = '';

  s += `<rect x="${x1}" y="${y}" width="${W}" height="${H}" rx="4"
     fill="${C.soft}" stroke="${C.blue}" stroke-width="1.4"/>
   <text x="${x1 + W / 2}" y="${y + H / 2}" fill="${C.ink}" font-size="13"
     font-weight="700" text-anchor="middle" dominant-baseline="middle">Sending</text>
   <text x="${x1 + W / 2}" y="${y + H / 2 + 16}" fill="${C.ink}" font-size="13"
     font-weight="700" text-anchor="middle" dominant-baseline="middle">department</text>`;

  s += `<rect x="${x2}" y="${y + 6}" width="${W}" height="${H - 12}" rx="3"
     fill="#fff" stroke="${C.grey}" stroke-width="1.2"/>
   <text x="${x2 + W / 2}" y="${y + H / 2 - 7}" fill="${C.ink}" font-size="11"
     text-anchor="middle" dominant-baseline="middle">Transfer note</text>
   <text x="${x2 + W / 2}" y="${y + H / 2 + 10}" fill="${C.ink}" font-size="12"
     font-weight="700" text-anchor="middle" dominant-baseline="middle">240 pieces</text>`;

  s += `<rect x="${x3}" y="${y}" width="${W}" height="${H}" rx="4"
     fill="${C.soft}" stroke="${C.blue}" stroke-width="1.4"/>
   <text x="${x3 + W / 2}" y="${y + H / 2}" fill="${C.ink}" font-size="13"
     font-weight="700" text-anchor="middle" dominant-baseline="middle">Receiving</text>
   <text x="${x3 + W / 2}" y="${y + H / 2 + 16}" fill="${C.ink}" font-size="13"
     font-weight="700" text-anchor="middle" dominant-baseline="middle">department</text>`;

  s += arrow(x1 + W + 4, y + H / 2, x2 - 4, y + H / 2, false, C.blue);
  s += arrow(x2 + W + 4, y + H / 2, x3 - 4, y + H / 2, false, C.blue);

  const mid1 = (x1 + W + x2) / 2, mid2 = (x2 + W + x3) / 2;
  s += `<text x="${mid1}" y="${y + H / 2 - 16}" fill="${C.ink}" font-size="9.5"
      text-anchor="middle">scans what</text>
    <text x="${mid1}" y="${y + H / 2 - 5}" fill="${C.ink}" font-size="9.5"
      text-anchor="middle">is leaving</text>
    <text x="${mid2}" y="${y + H / 2 - 16}" fill="${C.ink}" font-size="9.5"
      text-anchor="middle">scans what</text>
    <text x="${mid2}" y="${y + H / 2 - 5}" fill="${C.ink}" font-size="9.5"
      text-anchor="middle">arrived</text>`;

  s += `<text x="330" y="${y + H + 28}" fill="${C.ink}" font-size="12"
      text-anchor="middle">The computer compares the two numbers</text>
    <text x="330" y="${y + H + 52}" font-size="12.5" font-weight="700"
      text-anchor="middle"><tspan fill="${C.green}">Same &#8658; MATCHED</tspan>
      <tspan fill="${C.ink}">    </tspan>
      <tspan fill="${C.red}">Different &#8658; VARIANCE</tspan></text>`;

  return `<svg viewBox="0 0 660 152" xmlns="http://www.w3.org/2000/svg"
    font-family="Helvetica, Arial, sans-serif">${defs}${s}</svg>`;
}

/* ------------------------------------------------- 3. the operator's day */

function routineDiagram() {
  const W = 142, H = 52, GAP = 22;
  const xs = [8, 8 + W + GAP, 8 + 2 * (W + GAP), 8 + 3 * (W + GAP)];
  const r1 = 12, r2 = 104;
  const steps1 = [['1.', 'Sign in'], ['2.', 'Check what', 'is waiting'],
    ['3.', 'Receive it', 'and count'], ['4.', 'Do your work']];
  const steps2 = [['7.', 'Sign out'], ['6.', 'Print the note'], ['5.', 'Send it onward']];
  let s = '';

  const cell = (x, y, parts) => {
    const body = parts.slice(1);
    const first = y + H / 2 - (body.length - 1) * 7;
    return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="4"
      fill="${C.soft}" stroke="${C.blue}" stroke-width="1.3"/>
      <text x="${x + W / 2}" y="${first - 14}" fill="${C.blue}" font-size="11"
        font-weight="700" text-anchor="middle">${parts[0]}</text>` +
      body.map((t, i) => `<text x="${x + W / 2}" y="${first + i * 14}" fill="${C.ink}"
        font-size="11.5" text-anchor="middle">${t}</text>`).join('');
  };

  steps1.forEach((p, i) => { s += cell(xs[i], r1, p); });
  steps2.forEach((p, i) => { s += cell(xs[i], r2, p); });

  for (let i = 0; i < 3; i++) s += arrow(xs[i] + W, r1 + H / 2, xs[i + 1] - 4, r1 + H / 2, false, C.blue);
  s += arrow(xs[3] + W / 2, r1 + H, xs[3] + W / 2, r2 - 4, false, C.blue);
  for (let i = 3; i > 0; i--) s += arrow(xs[i], r2 + H / 2, xs[i - 1] + W + 4, r2 + H / 2, false, C.blue);

  return `<svg viewBox="0 0 660 172" xmlns="http://www.w3.org/2000/svg"
    font-family="Helvetica, Arial, sans-serif">${defs}${s}</svg>`;
}

/* ------------------------------------------------------------------ lookup */

const DIAGRAMS = [
  { match: 'secFabric', draw: routeDiagram, what: 'production route' },
  { match: 'Transfer note', draw: tallyDiagram, what: 'two-sided count' },
  { match: 'Sign in', draw: routineDiagram, what: "operator's day" },
];

/**
 * Returns the SVG for a tikzpicture body, or null if this drawing has no SVG
 * counterpart yet -- the caller reports that rather than dropping it silently.
 */
export function svgFor(tikzSource) {
  const hit = DIAGRAMS.find((d) => tikzSource.includes(d.match));
  return hit ? { svg: hit.draw(), what: hit.what } : null;
}
