/** Thin API client. Session token is kept in localStorage and sent as a bearer. */

const TOKEN_KEY = 'drfid_token';

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  const headers = {};
  const t = token.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the network connection.');
  }

  if (res.status === 401) {
    token.clear();
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, 'Your session has expired - please sign in again.');
  }
  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, data && data.detail);
  }
  return data;
}

export const api = {
  get:  (p, q) => request('GET', q ? `${p}?${new URLSearchParams(clean(q))}` : p),
  post: (p, b) => request('POST', p, b ?? {}),
  put:  (p, b) => request('PUT', p, b ?? {}),
  del:  (p) => request('DELETE', p),

  /** Streams a POST response straight to a file download (CSV export). */
  async download(path, body, filename) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token.get();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text();
      let msg = `Export failed (${res.status})`;
      try { msg = JSON.parse(txt).error || msg; } catch { /* keep default */ }
      throw new ApiError(res.status, msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  /** Opens a printable server-rendered document in a new tab. */
  openPrint(path) {
    const t = token.get();
    const w = window.open('', '_blank');
    if (!w) return;
    fetch(path, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
      .then((r) => r.text())
      .then((html) => { w.document.write(html); w.document.close(); })
      .catch(() => { w.document.write('<p>Could not load the document.</p>'); w.document.close(); });
  },
};

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
