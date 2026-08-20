import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, 'denim_rfid.db');

export const db = new DatabaseSync(DB_PATH);

// Throughput tuning for 125k articles/day.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
`);

export function migrate() {
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(sql);
}

/* ------------------------------------------------------------------ */
/* Statement cache + tiny query helpers                                */
/* ------------------------------------------------------------------ */
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

export const all = (sql, ...p) => prep(sql).all(...p);
export const get = (sql, ...p) => prep(sql).get(...p) ?? null;
export const run = (sql, ...p) => prep(sql).run(...p);
export const pluck = (sql, ...p) => {
  const r = prep(sql).get(...p);
  return r ? Object.values(r)[0] : null;
};

/** Run fn inside an IMMEDIATE transaction; nested calls join the outer one. */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  } finally {
    txDepth--;
  }
}

/* ------------------------------------------------------------------ */
/* Document numbering: PREFIX-YYMMDD-NNNN                              */
/* ------------------------------------------------------------------ */
export function nextNumber(prefix, { daily = true, width = 4 } = {}) {
  const now = new Date();
  const period = daily
    ? `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    : String(now.getFullYear());
  const row = prep('SELECT period, value FROM counters WHERE name = ?').get(prefix);
  let value;
  if (!row || row.period !== period) {
    value = 1;
    prep('INSERT INTO counters(name, period, value) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET period=excluded.period, value=excluded.value')
      .run(prefix, period, value);
  } else {
    value = row.value + 1;
    prep('UPDATE counters SET value = ? WHERE name = ?').run(value, prefix);
  }
  return `${prefix}-${period}-${String(value).padStart(width, '0')}`;
}

/**
 * Format a Date as SQLite's `YYYY-MM-DD HH:MM:SS` in *plant-local* time.
 * All stored timestamps are local so shift boundaries and WIP ageing line up
 * with the clock on the factory floor.
 */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Julian day number for "now" in plant-local time, matching how SQLite reads the
 * local-time strings we store.
 *
 * Ageing arithmetic uses this as an inlined constant rather than calling
 * julianday('now','localtime') inside the query: that function is not
 * deterministic, so SQLite re-evaluates it for every row of every scan. On a
 * table of 125,000 garments that alone costs seconds.
 */
export function nowJulian(d = new Date()) {
  const asIfUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return asIfUtc / 86400000 + 2440587.5;
}

/**
 * Assemble a FROM clause with only the joins the query actually references.
 *
 * `joins` are declared in dependency order as { alias, sql, needs }. Any join
 * whose alias appears in the supplied expressions is included, along with
 * whatever it depends on. Reports that select two columns then stop paying for
 * six unused joins.
 */
export function buildFrom(base, joins, expressions) {
  const text = expressions.filter(Boolean).join(' \n ');
  const needed = new Set();
  const add = (alias) => {
    if (needed.has(alias)) return;
    const j = joins.find((x) => x.alias === alias);
    if (!j) return;
    needed.add(alias);
    for (const dep of j.needs || []) add(dep);
  };
  for (const j of joins) {
    if (new RegExp(`\\b${j.alias}\\.`).test(text)) add(j.alias);
  }
  const used = joins.filter((j) => needed.has(j.alias)).map((j) => j.sql);
  return used.length ? `${base}\n${used.join('\n')}` : base;
}

/** Build a `(?,?,?)` placeholder list. */
export const holders = (n) => new Array(n).fill('?').join(',');

/** SQLite caps host parameters (default 32766); chunk large IN () lists. */
export const CHUNK = 800;
export function chunked(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
