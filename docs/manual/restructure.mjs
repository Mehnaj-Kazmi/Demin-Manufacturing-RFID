/**
 * Moves the two universal procedures - receiving a batch and dispatching a batch -
 * out of the Operator chapter and into the shared basics chapter, so that every
 * standalone booklet can reference them without a broken cross-reference.
 *
 * Safe to run once. It reports and exits if the move has already happened.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OP = 'content/portal-operator.tex';
const BASICS = 'content/02-basics.tex';

let op = readFileSync(OP, 'utf8');
let basics = readFileSync(BASICS, 'utf8');

const START = '\\section{Receiving goods into your section}';
const END = '\\section{Fabric store: receiving denim rolls}';

if (!op.includes(START)) {
  console.log('Already restructured - nothing to do.');
  process.exit(0);
}

const s = op.indexOf(START);
const e = op.indexOf(END);
if (e < 0) throw new Error('Could not find the end marker in the operator chapter.');

let moved = op.slice(s, e).trimEnd();
const rest = op.slice(0, s) + op.slice(e);

// Relabel so every booklet resolves them, and drop the cross-portal reference.
moved = moved
  .replace('\\label{sec:op-receive}', '\\label{sec:receive}')
  .replace('\\label{sec:op-dispatch}', '\\label{sec:dispatch}')
  .replace('see Chapter~\\ref{ch:supervisor}', 'your supervisor has to close it');

// Give the moved block a short lead-in now that it lives in the shared chapter.
const preamble = [
  '\\section{Moving goods between departments}',
  '',
  'Every station does these two things, whatever else its job is. Read this once;',
  'the rest of the manual refers back to it.',
  '',
].join('\n');

basics = basics.trimEnd() + '\n\n' + preamble + '\n' + moved + '\n';

// The operator chapter now points at the shared procedures instead.
const pointer = [
  '\\section{Moving goods in and out}',
  '',
  'Receiving a batch into your section and sending one onward are the same at',
  'every station, and are described in Section~\\ref{sec:receive} and',
  'Section~\\ref{sec:dispatch}. The rest of this chapter covers the work that is',
  'particular to each station.',
  '',
].join('\n');

const out = rest.replace(END, pointer + '\n' + END);

writeFileSync(OP, out);
writeFileSync(BASICS, basics);
console.log('Moved ' + moved.length + ' characters into the shared basics chapter.');
