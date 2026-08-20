import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, get, run, all, localStamp } from './db.js';
import { roleHas } from './process.js';
import { unauthorized, forbidden, badRequest } from './http.js';

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);   // one shift + handover
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = Buffer.from(scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex'));
  const expected = Buffer.from(hash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function login(username, password, ip) {
  const u = get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', String(username || '').trim());
  // Constant-ish work whether or not the user exists.
  const ok = u && u.active && verifyPassword(String(password || ''), u.pass_hash, u.pass_salt);
  if (!ok) {
    audit(u ? { id: u.id, username: u.username } : null, 'LOGIN_FAILED', 'user', username, null, ip);
    throw unauthorized('Invalid username or password');
  }
  const token = randomBytes(32).toString('hex');
  const expires = localStamp(new Date(Date.now() + SESSION_HOURS * 3600_000));
  run('INSERT INTO sessions(token, user_id, expires_at, ip) VALUES(?,?,?,?)', token, u.id, expires, ip || null);
  run("DELETE FROM sessions WHERE expires_at < datetime('now','localtime')");
  audit(u, 'LOGIN', 'user', String(u.id), null, ip);
  return { token, expires_at: expires, user: publicUser(u) };
}

export function logout(token, user, ip) {
  run('DELETE FROM sessions WHERE token = ?', token);
  if (user) audit(user, 'LOGOUT', 'user', String(user.id), null, ip);
}

export function publicUser(u) {
  return {
    id: u.id, username: u.username, full_name: u.full_name, emp_code: u.emp_code,
    role: u.role, section: u.section, active: !!u.active,
  };
}

export function userFromToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now','localtime') AND u.active = 1`, token);
  return row || null;
}

/** Extracts a bearer token or the session cookie. */
export function tokenFrom(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'drfid_token') return decodeURIComponent(v.join('='));
    }
  }
  return null;
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requireCap(ctx, cap) {
  const u = requireUser(ctx);
  if (!roleHas(u.role, cap)) {
    throw forbidden(`Your role (${u.role}) is not permitted to perform: ${cap}`);
  }
  return u;
}

export function changePassword(userId, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    throw badRequest('Password must be at least 6 characters');
  }
  const { hash, salt } = hashPassword(String(newPassword));
  run('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?', hash, salt, userId);
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/* ------------------------------------------------------------------ */
/* Audit trail - every state change records who and from where          */
/* ------------------------------------------------------------------ */
export function audit(user, action, entity, entityId, detail, ip) {
  run(
    'INSERT INTO audit_log(user_id, username, action, entity, entity_id, detail, ip) VALUES(?,?,?,?,?,?,?)',
    user?.id ?? null,
    user?.username ?? null,
    action,
    entity ?? null,
    entityId != null ? String(entityId) : null,
    detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    ip ?? null
  );
}

export const auditCtx = (ctx, action, entity, entityId, detail) =>
  audit(ctx.user, action, entity, entityId, detail, ctx.ip);

/* ------------------------------------------------------------------ */
/* Reader (device) authentication - fixed readers post reads with a key */
/* ------------------------------------------------------------------ */
export function readerFromKey(apiKey) {
  if (!apiKey) return null;
  const r = get('SELECT * FROM readers WHERE api_key = ? AND active = 1', apiKey);
  if (r) run("UPDATE readers SET last_seen_at = datetime('now','localtime') WHERE id = ?", r.id);
  return r || null;
}

export function listSessions(userId) {
  return all('SELECT token, created_at, expires_at, ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC', userId);
}

export function seedAdminIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return null;
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const { hash, salt } = hashPassword(password);
  run(
    `INSERT INTO users(username, full_name, emp_code, pass_hash, pass_salt, role, section)
     VALUES('admin','System Administrator','EMP-0001',?,?,'ADMIN',NULL)`, hash, salt);
  return { username: 'admin', password };
}
