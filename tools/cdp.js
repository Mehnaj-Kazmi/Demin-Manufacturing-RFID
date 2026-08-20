/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 24 ships a WebSocket client, so driving a headless browser needs no
 * dependencies at all. Only the handful of CDP commands the screenshot harness
 * needs are wrapped here.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export function findBrowser() {
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  throw new Error('No Chrome or Edge installation found.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch a headless browser with the debugging port open. */
export async function launch({ width = 1440, height = 900, port = 9333 } = {}) {
  const exe = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'drfid-shots-'));
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=2',      // crisp screenshots for print
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint to answer.
  let info = null;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { info = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!info) { proc.kill(); throw new Error('Browser did not open its debugging port.'); }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page') || targets[0];

  const client = await connect(page.webSocketDebuggerUrl);
  client.close = async () => {
    try { client.socket.close(); } catch { /* already closed */ }
    proc.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  };
  return client;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: no } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) no(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else ok(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) fn(msg.params);
      }
    });
    socket.addEventListener('error', (e) => reject(new Error('CDP socket error: ' + (e.message || 'unknown'))));
    socket.addEventListener('open', () => {
      resolve({
        socket,
        /**
         * Every command carries a timeout. Without one, a page that never
         * settles (a promise that does not resolve, a navigation that hangs)
         * would block the whole capture run instead of failing one shot.
         */
        send(method, params = {}, timeoutMs = 25000) {
          const id = nextId++;
          return new Promise((ok, no) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              no(new Error(method + ' timed out after ' + timeoutMs + ' ms'));
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => { clearTimeout(timer); ok(v); },
              reject: (e) => { clearTimeout(timer); no(e); },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, []);
          listeners.get(method).push(fn);
        },
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Convenience wrappers                                                */
/* ------------------------------------------------------------------ */

/** Evaluate an expression in the page and return its (awaited) value. */
export async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error('Page error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

export async function navigate(client, url, settleMs = 900) {
  await client.send('Page.navigate', { url });
  await sleep(settleMs);
}

/** Full-page PNG. Height is clamped so a very long page stays a sane image. */
export async function capture(client, { fullPage = true, maxHeight = 4200 } = {}) {
  if (!fullPage) {
    const res = await client.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(res.data, 'base64');
  }
  const metrics = await client.send('Page.getLayoutMetrics');
  const w = Math.ceil(metrics.cssContentSize.width);
  const h = Math.min(Math.ceil(metrics.cssContentSize.height), maxHeight);
  const res = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  });
  return Buffer.from(res.data, 'base64');
}

export { sleep };
