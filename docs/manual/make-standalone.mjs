/**
 * Generates the four standalone portal manuals. Each one is a complete booklet:
 * the shared introduction, the chapter for that portal, and the reference
 * material, so a department can be handed just its own book.
 *
 *   node make-standalone.mjs
 */
import { writeFileSync } from 'node:fs';

const PORTALS = [
  {
    file: 'manual-operator.tex', chapter: 'portal-operator',
    name: 'Operator Portal', colour: 'secStitch',
    who: 'For staff working at a station on the factory floor',
    blurb: 'Fabric store \\textbullet\\ Cutting \\textbullet\\ Stitching \\textbullet\\ Sorting\\\\'
         + 'Wash \\textbullet\\ Finishing \\textbullet\\ Retrofit \\textbullet\\ Dispatch',
  },
  {
    file: 'manual-qc.tex', chapter: 'portal-qc',
    name: 'Quality Inspector Portal', colour: 'secQC',
    who: 'For staff at the inspection benches',
    blurb: 'Inspecting garments \\textbullet\\ Marking faults on the design\\\\'
         + 'Passing and failing \\textbullet\\ Defect analysis',
  },
  {
    file: 'manual-supervisor.tex', chapter: 'portal-supervisor',
    name: 'Supervisor Portal', colour: 'secSort',
    who: 'For the person in charge of a department',
    blurb: 'Section workload \\textbullet\\ Settling count differences\\\\'
         + 'Cancelling handovers \\textbullet\\ Building reports',
    extra: ['content/03-reports'],
  },
  {
    file: 'manual-admin.tex', chapter: 'portal-admin',
    name: 'Administrator Portal', colour: 'secDisp',
    who: 'For plant management and the system administrator',
    blurb: 'Dashboards \\textbullet\\ Orders \\textbullet\\ Reports\\\\'
         + 'Users \\textbullet\\ Readers \\textbullet\\ Audit trail',
    extra: ['content/03-reports'],
  },
];

const template = (p) => `% ===========================================================================
%  ${p.name} - standalone manual
%  Build:  pdflatex ${p.file}      (run it twice so the contents page is right)
% ===========================================================================
\\documentclass[11pt,a4paper,oneside]{report}
\\usepackage{style/manualstyle}

\\hypersetup{pdftitle={Denim RFID Track and Trace - ${p.name}}}

\\begin{document}

\\begin{titlepage}
\\begin{tikzpicture}[remember picture,overlay]
  \\fill[${p.colour}] (current page.north west) rectangle ([yshift=-95mm]current page.north east);
  \\node[anchor=north west,text=white,font=\\fontsize{30}{36}\\bfseries,align=left]
    at ([xshift=25mm,yshift=-26mm]current page.north west)
    {Denim RFID\\\\Track \\& Trace};
  \\node[anchor=north west,text=white,font=\\LARGE,align=left]
    at ([xshift=25mm,yshift=-66mm]current page.north west) {${p.name}};
  \\node[anchor=south east,text=brandgrey,font=\\small,align=right]
    at ([xshift=-25mm,yshift=25mm]current page.south east) {${p.blurb}};
\\end{tikzpicture}

\\vspace*{110mm}

{\\Large\\bfseries ${p.who}}

\\vspace{6mm}

{\\large\\color{brandgrey}
This booklet assumes no computer experience. Every screen you will meet is
pictured, and every button you need to press is named.}

\\vspace{14mm}

\\begin{plainbox}
\\textbf{What this software does, in one sentence.}\\\\[4pt]
Every pair of jeans gets a small electronic tag when it is stitched, and from
that moment the computer always knows where that garment is, how long it has
been there, and who last handled it.
\\end{plainbox}

\\end{titlepage}

\\tableofcontents
\\clearpage

\\input{content/00-about}
\\input{content/01-getting-started}
\\input{content/02-basics}
\\input{content/${p.chapter}}
${(p.extra ?? []).map((c) => '\\input{' + c + '}').join('\n')}
\\input{content/90-glossary}
\\input{content/91-troubleshooting}

\\end{document}
`;

for (const p of PORTALS) {
  writeFileSync(p.file, template(p));
  console.log('wrote ' + p.file);
}
