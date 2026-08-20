/**
 * Captures every screen of the running application for the user manual.
 *
 * Signs in as each kind of user, visits each screen, opens the dialogs that
 * matter, and writes PNGs into docs/manual/img/.
 *
 *   node tools/screenshots.js              (the server must be running)
 *   node tools/screenshots.js --only 8     capture only shots whose id starts with "8"
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, evaluate, navigate, capture, sleep } from './cdp.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const OUT = join(process.cwd(), 'docs', 'manual', 'img');
mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? process.argv[onlyArg + 1].split(',').map((s) => s.trim()) : null;

const PASSWORDS = {
  admin: 'admin123', pmanager: 'manager123',
  'store.sup': 'store123', 'cut.sup': 'cut123', 'stitch.sup': 'stitch123',
  'wash.sup': 'wash123', 'finish.sup': 'finish123', 'disp.sup': 'disp123',
  qc1: 'qc123', qc2: 'qc123',
};
const passwordFor = (u) => PASSWORDS[u] || 'op123';

// Re-running only fills the gaps unless --force is passed.
const SKIP_EXISTING = !process.argv.includes('--force');

/** Small helpers injected into the page before every prep script. */
const HELPERS = [
  'window.__byText = (sel, txt, root) =>',
  '  [...(root || document).querySelectorAll(sel)]',
  '    .find(n => n.textContent.trim().toLowerCase().includes(String(txt).toLowerCase()));',
  'window.__wait = (ms) => new Promise(r => setTimeout(r, ms));',
  'window.__rows = () => [...document.querySelectorAll("#view table.data tbody tr")];',
  'true;',
].join('\n');

/** Sign in through the API, store the token, so the app boots already signed in. */
function loginScript(user, pass) {
  return '(async () => {'
    + '  const r = await fetch("/api/auth/login", {'
    + '    method: "POST", headers: { "Content-Type": "application/json" },'
    + '    body: JSON.stringify({ username: ' + JSON.stringify(user) + ', password: ' + JSON.stringify(pass) + ' })'
    + '  });'
    + '  if (!r.ok) throw new Error("login failed for ' + user + '");'
    + '  const d = await r.json();'
    + '  localStorage.setItem("drfid_token", d.token);'
    + '  return d.user.role;'
    + '})()';
}

/**
 * The shot list.
 *   id       output file name (without .png)
 *   user     who to sign in as (null = signed out)
 *   hash     route to open
 *   prep     JS executed in the page after navigation, before capture
 *   settle   extra milliseconds to wait for data to load
 *   viewport capture only the visible window (use for dialogs, which are fixed)
 */
const SHOTS = [
  /* ------------------------------------------------------- Sign in */
  { id: '01-login', user: null, hash: '', viewport: true,
    settle: 1600 },

  /* ---------------------------------------------- Administrator */
  { id: '10-admin-dashboard', user: 'admin', hash: '#/dashboard', settle: 2400 },
  { id: '11-admin-dashboard-top', user: 'admin', hash: '#/dashboard', settle: 2400, viewport: true },
  { id: '12-admin-sections-wip', user: 'admin', hash: '#/sections', settle: 2400 },
  { id: '13-admin-sections-batch', user: 'admin', hash: '#/sections', settle: 2200,
    prep: 'let b = null;'
        + 'for (let i = 0; i < 30 && !b; i++) {'
        + '  b = [...document.querySelectorAll("#view .checkbox")].find(x => x.textContent.includes("Receiving Batch"));'
        + '  if (!b) await __wait(300);'
        + '}'
        + 'if (!b) throw new Error("grouping control not found");'
        + 'b.querySelector("input").click(); await __wait(2200); true' },
  { id: '14-admin-orders', user: 'admin', hash: '#/orders', settle: 1800 },
  { id: '15-admin-order-detail', user: 'admin', hash: '#/orders', settle: 1800, viewport: true,
    prep: '__rows()[4].click(); await __wait(1600); true' },
  { id: '16-admin-masters-styles', user: 'admin', hash: '#/masters', settle: 2000 },
  { id: '17-admin-masters-edit', user: 'admin', hash: '#/masters', settle: 2000, viewport: true,
    prep: '__rows()[0].click(); await __wait(1000); true' },
  { id: '18-admin-users', user: 'admin', hash: '#/admin', settle: 1800 },
  { id: '19-admin-readers', user: 'admin', hash: '#/admin', settle: 1800,
    prep: '__byText(".tab","RFID readers").click(); await __wait(1800); true' },
  { id: '20-admin-roles', user: 'admin', hash: '#/admin', settle: 1800,
    prep: '__byText(".tab","Roles").click(); await __wait(1400); true' },
  { id: '21-admin-audit', user: 'admin', hash: '#/audit', settle: 2200 },
  { id: '22-admin-reports', user: 'admin', hash: '#/reports', settle: 2800 },
  { id: '23-admin-reports-result', user: 'admin', hash: '#/reports', settle: 2800,
    prep: '__byText("#view table button","Open").click(); await __wait(2600);'
        + 'window.scrollTo(0, document.body.scrollHeight); await __wait(500); true' },

  /* ------------------------------------------------- Fabric store */
  { id: '30-store-stock', user: 'store.sup', hash: '#/fabric', settle: 1900 },
  { id: '31-store-rolls', user: 'store.sup', hash: '#/fabric', settle: 1900,
    prep: '__byText(".tab","Roll register").click(); await __wait(1900); true' },
  { id: '32-store-receive', user: 'store.sup', hash: '#/fabric', settle: 1700, viewport: true,
    prep: '__byText("#page-tools button","Receive rolls").click(); await __wait(1100); true' },
  { id: '33-store-grn-list', user: 'store.sup', hash: '#/fabric', settle: 1700,
    prep: '__byText(".tab","Goods receipts").click(); await __wait(1700); true' },

  /* ------------------------------------------------------ Cutting */
  { id: '40-cutting-list', user: 'cut.sup', hash: '#/cutting', settle: 1900 },
  { id: '41-cutting-detail', user: 'cut.sup', hash: '#/cutting', settle: 1900, viewport: true,
    prep: '__rows()[0].click(); await __wait(1800); true' },
  { id: '42-cutting-new', user: 'cut.sup', hash: '#/cutting', settle: 1700, viewport: true,
    prep: '__byText("#page-tools button","New cut order").click(); await __wait(1000); true' },

  /* ---------------------------------------------------- Stitching */
  { id: '50-stitching', user: 'stitch.op1', hash: '#/stitching', settle: 1900 },
  { id: '51-stitching-count', user: 'stitch.op1', hash: '#/stitching', settle: 1900, viewport: true,
    prep: '__byText("#view button","Count in").click(); await __wait(1000); true' },
  { id: '52-stitching-tags', user: 'stitch.op1', hash: '#/stitching', settle: 1900, viewport: true,
    prep: 'const b = __byText("#view button","Attach tags");'
        + 'if (b) { b.click(); await __wait(1200);'
        + '  const sim = __byText(".modal button","Simulate tag encoder");'
        + '  if (sim) { sim.click(); await __wait(1800); } } true' },

  /* ------------------------------------------------------ Sorting */
  { id: '60-sorting-list', user: 'sort.op1', hash: '#/sorting', settle: 1900 },
  { id: '61-sorting-new', user: 'sort.op1', hash: '#/sorting', settle: 1700, viewport: true,
    prep: '__byText("#page-tools button","New sorting session").click(); await __wait(1000); true' },
  { id: '62-sorting-session', user: 'sort.op1', hash: '#/sorting', settle: 2100, viewport: true,
    prep: 'const row = __rows().find(r => Number(r.cells[3].textContent.replace(/,/g,"")) >= 100) || __rows()[0];'
        + 'row.click(); await __wait(2400); true' },

  /* ---------------------------------------------------- Transfers */
  { id: '70-transfers-inbox', user: 'wash.op1', hash: '#/transfers?stage=WASHING', settle: 2400 },
  { id: '71-transfers-receive', user: 'wash.op1', hash: '#/transfers?stage=WASHING', settle: 2400, viewport: true,
    prep: '__byText("#view button","Receive").click(); await __wait(1300); true' },
  { id: '72-transfers-tally', user: 'wash.op1', hash: '#/transfers?stage=WASHING', settle: 2400, viewport: true,
    prep: '__byText("#view button","Receive").click(); await __wait(1300);'
        + '__byText(".modal button","Simulate short read").click(); await __wait(1900);'
        + '__byText(".modal button","Receive and tally").click(); await __wait(2800);'
        + 'const m = document.querySelector(".modal-body"); if (m) m.scrollTop = 300; true' },
  { id: '73-transfers-dispatch', user: 'sort.op1', hash: '#/transfers?stage=SORTING', settle: 2100, viewport: true,
    prep: '__byText("#page-tools button","Dispatch a batch").click(); await __wait(1200);'
        + 'const sim = __byText(".modal button","Simulate reader");'
        + 'if (sim) { sim.click(); await __wait(1900); } true' },
  { id: '74-transfers-history', user: 'admin', hash: '#/transfers?stage=QC', settle: 2400 },
  { id: '75-transfers-doc', user: 'admin', hash: '#/transfers?stage=QC', settle: 2400, viewport: true,
    prep: 'const tables = [...document.querySelectorAll("#view table.data")];'
        + 'tables[tables.length - 1].querySelector("tbody tr").click(); await __wait(2000); true' },

  /* ----------------------------------------------------------- QC */
  { id: '80-qc-inspect-empty', user: 'qc1', hash: '#/qc', settle: 1900 },
  { id: '81-qc-queue', user: 'qc1', hash: '#/qc', settle: 1900,
    prep: '__byText(".tab","QC queue").click(); await __wait(2200); true' },
  { id: '82-qc-inspect-garment', user: 'qc1', hash: '#/qc', settle: 1900,
    prep: '__byText(".tab","QC queue").click(); await __wait(2200);'
        + '__rows().find(r => r.textContent.includes("PENDING")).click(); await __wait(2800); true' },
  { id: '83-qc-defect-dialog', user: 'qc1', hash: '#/qc', settle: 1900, viewport: true,
    prep: '__byText(".tab","QC queue").click(); await __wait(2200);'
        + '__rows().find(r => r.textContent.includes("PENDING")).click(); await __wait(2800);'
        + 'const map = document.querySelector(".defectmap"); const img = map.querySelector("img");'
        + 'const r = img.getBoundingClientRect();'
        + 'map.dispatchEvent(new MouseEvent("click", { bubbles:true, clientX:r.left+r.width*0.35, clientY:r.top+r.height*0.62 }));'
        + 'await __wait(1000); true' },
  { id: '84-qc-defect-marked', user: 'qc1', hash: '#/qc', settle: 1900,
    prep: '__byText(".tab","QC queue").click(); await __wait(2200);'
        + '__rows().find(r => r.textContent.includes("PENDING")).click(); await __wait(2800);'
        + 'const map = document.querySelector(".defectmap"); const img = map.querySelector("img");'
        + 'const r = img.getBoundingClientRect();'
        + 'map.dispatchEvent(new MouseEvent("click", { bubbles:true, clientX:r.left+r.width*0.35, clientY:r.top+r.height*0.62 }));'
        + 'await __wait(1000);'
        + '__byText(".modal-foot button","Add defect").click(); await __wait(1000); true' },
  { id: '85-qc-analysis', user: 'qc1', hash: '#/qc', settle: 1900,
    prep: '__byText(".tab","Defect analysis").click(); await __wait(2800); true' },

  /* ----------------------------------------------------- Retrofit */
  { id: '90-retrofit-queue', user: 'retro.op1', hash: '#/retrofit', settle: 2100 },
  { id: '91-retrofit-file', user: 'retro.op1', hash: '#/retrofit', settle: 2100,
    prep: '__rows()[0].click(); await __wait(2400); window.scrollTo(0,0); true' },

  /* ----------------------------------------------------- Dispatch */
  { id: '95-dispatch-ready', user: 'disp.sup', hash: '#/dispatch', settle: 2100 },
  { id: '96-dispatch-shipments', user: 'disp.sup', hash: '#/dispatch', settle: 2100,
    prep: '__byText(".tab","Shipments").click(); await __wait(1900); true' },
  { id: '97-dispatch-swap', user: 'disp.sup', hash: '#/dispatch', settle: 2100, viewport: true,
    prep: '__byText(".tab","Shipments").click(); await __wait(1900);'
        + 'const open = __rows().find(r => r.textContent.includes("OPEN")) || __rows()[0];'
        + 'open.click(); await __wait(1900);'
        + 'const b = __byText(".modal-foot button","Re-tag garments");'
        + 'if (b) { b.click(); await __wait(1300);'
        + '  const sim = __byText(".modal button","Simulate tabletop encoder");'
        + '  if (sim) { sim.click(); await __wait(2400); } } true' },

  /* -------------------------------------------------------- Trace */
  { id: '98-trace-search', user: 'admin', hash: '#/trace', settle: 2100 },
  { id: '99-trace-article', user: 'admin', hash: '#/trace', settle: 2100,
    prep: '__rows()[0].click(); await __wait(2600); true' },
];

/* ------------------------------------------------------------------ */
const client = await launch({ width: 1440, height: 940 });
await client.send('Page.enable');
await client.send('Runtime.enable');

let currentUser = '__none__';
let ok = 0;
const failures = [];

try {
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.some((p) => shot.id.startsWith(p))) continue;
    if (SKIP_EXISTING && existsSync(join(OUT, shot.id + '.png'))) continue;
    process.stdout.write('  ' + shot.id.padEnd(28));
    try {
      if (shot.user !== currentUser) {
        await navigate(client, BASE, 800);
        if (shot.user) await evaluate(client, loginScript(shot.user, passwordFor(shot.user)));
        else await evaluate(client, 'localStorage.removeItem("drfid_token"); true');
        currentUser = shot.user;
      }

      // A unique query string forces a full document load; a hash-only change
      // would be a same-document navigation and the app would never re-boot.
      await navigate(client, BASE + '/?s=' + Date.now() + shot.hash, 900);
      await evaluate(client, HELPERS);
      await sleep(shot.settle ?? 1500);
      if (shot.prep) await evaluate(client, '(async () => { ' + shot.prep + ' })()');
      await sleep(600);

      const png = await capture(client, { fullPage: !shot.viewport });
      writeFileSync(join(OUT, shot.id + '.png'), png);
      console.log('ok  ' + (png.length / 1024).toFixed(0).padStart(5) + ' KB');
      ok++;
    } catch (e) {
      console.log('FAILED  ' + String(e.message).slice(0, 90));
      failures.push({ id: shot.id, error: e.message });
      currentUser = '__none__';
    }
  }
} finally {
  await client.close();
}

console.log('\n' + ok + ' screenshot(s) written to docs/manual/img');
if (failures.length) {
  console.log(failures.length + ' failed:');
  for (const f of failures) console.log('  ' + f.id + ': ' + String(f.error).slice(0, 120));
}
