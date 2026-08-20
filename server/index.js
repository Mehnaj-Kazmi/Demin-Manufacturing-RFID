import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { migrate, ROOT, db } from './lib/db.js';
import { HttpError, sendJson, sendText, serveStatic, notFound } from './lib/http.js';
import { userFromToken, tokenFrom, readerFromKey, seedAdminIfEmpty } from './lib/auth.js';
import { SHIFT_DEFS } from './lib/process.js';
import { refreshRollup } from './services/kpi.js';
import { api } from './routes.js';

// node:sqlite is still flagged experimental; the warning adds nothing for operators.
const origEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, warning, ...rest);
};

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = join(ROOT, 'public');

migrate();
for (const s of SHIFT_DEFS) {
  db.prepare(`INSERT INTO shifts(code, name, start_time, end_time) VALUES(?,?,?,?)
              ON CONFLICT(code) DO UPDATE SET name=excluded.name, start_time=excluded.start_time, end_time=excluded.end_time`)
    .run(s.code, s.name, s.start, s.end);
}
const bootstrap = seedAdminIfEmpty();

// Bring the hourly event rollup up to date at start-up so the first dashboard
// request does not pay for the backfill.
const rollupStart = Date.now();
const rollup = refreshRollup();
if (rollup.added) {
  console.log(`Event rollup: folded in ${rollup.added.toLocaleString()} event(s) in ${Date.now() - rollupStart} ms.`);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || null;
}

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'Malformed URL' });
  }
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      const match = api.match(req.method, path);
      if (!match) throw notFound(`No such endpoint: ${req.method} ${path}`);

      const token = tokenFrom(req);
      const ctx = {
        req, res, token,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        ip: clientIp(req),
        user: userFromToken(token),
        reader: readerFromKey(req.headers['x-reader-key']),
      };
      // A reader key alone authenticates the device; it acts as its own service user.
      if (!ctx.user && ctx.reader) {
        ctx.user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get('reader-service') || null;
      }

      for (const handler of match.route.handlers) {
        await handler(ctx);
        if (res.writableEnded) break;
      }
      if (!res.writableEnded) sendJson(res, 204, null);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound();
    if (path === '/health') {
      return sendJson(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });
    }
    if (path === '/' || path === '/index.html') {
      return serveStatic(PUBLIC_DIR, 'index.html', res) || sendText(res, 500, 'UI files are missing');
    }
    if (serveStatic(PUBLIC_DIR, path, res)) return;

    // Unknown non-API path: hand back the SPA shell so client-side routes work.
    if (!path.includes('.')) {
      return serveStatic(PUBLIC_DIR, 'index.html', res) || sendText(res, 404, 'Not found');
    }
    sendText(res, 404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, detail: err.detail ?? undefined });
    } else {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.error(`[error] ${req.method} ${path} (${ms.toFixed(0)}ms)`, err);
      const isConstraint = /UNIQUE|constraint/i.test(err?.message || '');
      sendJson(res, isConstraint ? 409 : 500, {
        error: isConstraint ? 'That record already exists or violates a data rule' : 'Internal server error',
        detail: process.env.NODE_ENV === 'production' ? undefined : err?.message,
      });
    }
  }
});

server.headersTimeout = 120_000;
server.requestTimeout = 300_000;   // long bulk reads from tunnel readers

server.listen(PORT, HOST, () => {
  const line = '='.repeat(66);
  console.log(`\n${line}`);
  console.log('  DENIM RFID TRACK & TRACE  -  Manufacturing Execution System');
  console.log(line);
  console.log(`  Web UI     : http://localhost:${PORT}`);
  console.log(`  Health     : http://localhost:${PORT}/health`);
  console.log(`  Database   : ${join(ROOT, 'data', 'denim_rfid.db')}`);
  if (bootstrap) {
    console.log(`\n  First run - administrator account created:`);
    console.log(`    username: ${bootstrap.username}`);
    console.log(`    password: ${bootstrap.password}`);
    console.log(`  Change this password after signing in.`);
  }
  if (!existsSync(PUBLIC_DIR)) console.log('\n  WARNING: public/ directory not found - the UI will not load.');
  console.log(`${line}\n`);
});

const shutdown = (sig) => {
  console.log(`\n${sig} received - closing.`);
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
