import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

/** Thrown by route handlers; carries an HTTP status. */
export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
export const forbidden = (m = 'Not permitted') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m, d) => new HttpError(409, m, d);

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export class Router {
  constructor() { this.routes = []; this.middleware = []; }

  use(fn) { this.middleware.push(fn); return this; }

  add(method, pattern, ...handlers) {
    const keys = [];
    const rx = new RegExp(
      '^' + pattern.replace(/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'
    );
    this.routes.push({ method, rx, keys, handlers });
    return this;
  }
  get(p, ...h)  { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h)  { return this.add('PUT', p, ...h); }
  patch(p, ...h){ return this.add('PATCH', p, ...h); }
  del(p, ...h)  { return this.add('DELETE', p, ...h); }

  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Request/response helpers                                            */
/* ------------------------------------------------------------------ */
const MAX_BODY = 32 * 1024 * 1024;   // bulk RFID reads can be large

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(badRequest('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw badRequest('Malformed JSON body'); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

export function sendCsv(res, filename, csv) {
  sendText(res, 200, '﻿' + csv, 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serve a file from `root`, refusing anything that escapes it. */
export function serveStatic(root, urlPath, res) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  if (rel.split(/[\\/]/).includes('..')) return false;
  const full = join(root, rel);
  if (!full.startsWith(root + sep) && full !== root) return false;
  let st;
  try { st = statSync(full); } catch { return false; }
  if (st.isDirectory()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(full).pipe(res);
  return true;
}

/* ------------------------------------------------------------------ */
/* Input coercion                                                      */
/* ------------------------------------------------------------------ */
export function str(v, field, { required = false, max = 4000, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  let s = String(v);
  if (trim) s = s.trim();
  if (!s && required) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} exceeds ${max} characters`);
  return s || null;
}

export function int(v, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

export function num(v, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

export function oneOf(v, field, allowed, { required = false } = {}) {
  const s = str(v, field, { required });
  if (s === null) return null;
  if (!allowed.includes(s)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return s;
}

export function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/** Normalise a list of EPCs from a bulk read: upper-case hex, de-duplicated. */
export function epcList(v, field = 'epcs', { required = true, max = 200000 } = {}) {
  let arr = v;
  if (typeof arr === 'string') arr = arr.split(/[\s,;]+/);
  if (!Array.isArray(arr)) {
    if (required) throw badRequest(`${field} must be an array of EPCs`);
    return [];
  }
  const seen = new Set();
  for (const raw of arr) {
    if (raw === null || raw === undefined) continue;
    const e = String(raw).trim().toUpperCase();
    if (!e) continue;
    if (!/^[0-9A-F]{8,96}$/.test(e)) throw badRequest(`Invalid EPC "${e}" - expected 8-96 hex characters`);
    seen.add(e);
  }
  if (required && seen.size === 0) throw badRequest(`${field} is empty - nothing was scanned`);
  if (seen.size > max) throw badRequest(`${field} exceeds ${max} tags in one call`);
  return [...seen];
}

/** CSV encoding that survives Excel. */
export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label ?? c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')).join('\r\n');
  return head + '\r\n' + body;
}
