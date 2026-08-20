import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, age, select, field, modal, toast, toastOk, toastErr,
  stat, empty, scanPad, simSection, tabs, kv, swatch, $, mount
} from '../ui.js';
import { state, can, stageName, go, masters } from '../app.js';

/**
 * Quality control.
 *
 * A failure must carry at least one reason, and the inspector can pin each defect
 * to the exact spot on the design image - that position travels with the garment
 * to the retrofit bench and feeds the defect heat map.
 */
export async function render(ctx) {
  ctx.setSubtitle('Inspect garments, record defects on the design, and route failures to retrofitting');

  const defectCodes = await masters('defect_codes');
  const root = el('div');
  const body = el('div');
  let inspectMount = null;      // set by showInspect so other tabs can jump into it

  const tabRow = tabs([
    { key: 'inspect', label: 'Inspect' },
    { key: 'queue', label: 'QC queue' },
    { key: 'analysis', label: 'Defect analysis' },
  ], (k) => show(k), 'inspect');
  root.appendChild(tabRow);
  root.appendChild(body);

  /** Switch the visible tab from code (e.g. jumping from the queue into Inspect). */
  const activateTab = (label) => {
    const btns = [...tabRow.querySelectorAll('.tab')];
    btns.forEach((b) => b.classList.toggle('active', b.textContent === label));
  };

  async function show(view) {
    mount(body, el('div', { class: 'loading' }, 'Loading...'));
    if (view === 'inspect') return showInspect();
    if (view === 'queue') return showQueue();
    return showAnalysis();
  }

  /* ------------------------------ Inspect ------------------------------- */
  async function showInspect() {
    const scanInput = el('input', {
      placeholder: 'Scan the garment tag...', class: 'mono',
      style: { fontSize: '16px', padding: '13px' }, autofocus: true,
    });
    const panel = el('div');
    inspectMount = panel;

    const lookup = async () => {
      const epc = scanInput.value.trim().toUpperCase();
      if (!epc) return;
      mount(panel, el('div', { class: 'loading' }, 'Looking up garment...'));
      try {
        const { article } = await api.get(`/api/articles/by-epc/${encodeURIComponent(epc)}`);
        if (article.stage !== 'QC') {
          mount(panel, card('Not in QC',
            el('div', {}, el('p', {}, `${article.serial_no} is currently in ${stageName(article.stage)}.`),
              el('p', { class: 'hint' }, 'Receive the batch into QC before inspecting it.'),
              el('button', { class: 'btn', onClick: () => go('transfers', { stage: 'QC' }) }, 'Go to transfers'))));
          return;
        }
        scanInput.value = '';
        await inspectPanel(article.id, panel);
      } catch (e) {
        mount(panel, card('Tag not recognised',
          el('p', {}, e.message), { tight: false }));
      }
      scanInput.focus();
    };
    scanInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });

    const batchPad = scanPad({
      placeholder: 'Bulk-read a clean batch to pass it in one go.',
      hint: 'Only use this when every garment in the pile has been checked',
      simulate: () => simSection('QC'),
    });

    mount(body, 
      card('Inspect a garment',
        el('div', {},
          el('p', { class: 'hint mb' }, 'Scan the tracking tag. The garment\'s design, order and full history appear so you can inspect against the right specification.'),
          el('div', { class: 'inline' }, scanInput,
            el('button', { class: 'btn btn-primary btn-lg', onClick: lookup }, 'Look up'))),
        { subtitle: 'Bench station' }),
      panel,
      can('qc.inspect') ? card('Pass a whole batch',
        el('div', {}, batchPad.node,
          el('button', { class: 'btn btn-ok btn-lg mt', onClick: async (e) => {
            const epcs = batchPad.epcs;
            if (!epcs.length) { toast('Nothing scanned', 'Read the batch first.', 'warn'); return; }
            const clicked = e.currentTarget; clicked.disabled = true;
            try {
              const out = await api.post('/api/qc/batch-pass', { epcs, remarks: 'Batch pass at QC bench' });
              batchPad.set([]);
              toastOk(`${out.passed} garment(s) passed`,
                out.skipped.length ? `${out.skipped.length} could not be passed - see the list.` : 'All accepted.');
              if (out.skipped.length) {
                modal({ title: 'Not passed', body: table([
                  { key: 'epc', label: 'Tag', mono: true },
                  { key: 'serial_no', label: 'Serial No', mono: true },
                  { key: 'reason', label: 'Reason' }], out.skipped),
                  actions: [{ label: 'Close', onClick: (c) => c() }] });
              }
            } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
          } }, 'Pass all scanned garments')),
        { subtitle: 'Every pass is still recorded against you individually' }) : null);

    scanInput.focus();
  }

  /* ---------------------- The inspection workspace ---------------------- */
  async function inspectPanel(articleId, target) {
    const file = await api.get(`/api/qc/article/${articleId}`);
    const a = file.article;
    const defects = [];       // pins being placed in this inspection
    let view = 'FRONT';

    const imgWrap = el('div', { class: 'defectmap placing' });
    const listBox = el('div', { class: 'defect-list' });
    const remarks = el('textarea', { placeholder: 'Optional notes for this inspection', rows: 2 });

    const drawPins = () => {
      [...imgWrap.querySelectorAll('.pin')].forEach((p) => p.remove());
      defects.filter((d) => d.view === view).forEach((d) => {
        const idx = defects.indexOf(d) + 1;
        imgWrap.appendChild(el('div', {
          class: `pin ${d.severity}`, style: { left: `${d.pos_x * 100}%`, top: `${d.pos_y * 100}%` },
          title: `${d.name} (${d.severity})`,
          onClick: (e) => { e.stopPropagation(); defects.splice(defects.indexOf(d), 1); drawPins(); drawList(); },
        }, String(idx)));
      });
    };

    const drawList = () => {
      mount(listBox, ...(defects.length ? defects.map((d, i) => el('div', { class: 'defect-row' },
        el('div', { class: `idx pin ${d.severity}`, style: { position: 'static', margin: 0 } }, String(i + 1)),
        el('div', { style: { flex: 1 } },
          el('strong', {}, d.name),
          el('div', { class: 'hint' }, `${d.view} · ${d.severity}${d.note ? ' · ' + d.note : ''}`)),
        el('button', { class: 'btn btn-sm', onClick: () => { defects.splice(i, 1); drawPins(); drawList(); } }, 'Remove')))
        : [el('p', { class: 'hint' }, 'No defects recorded. Click the design where you found a problem, or use "Add defect without a position".')]));
    };

    const setImage = () => {
      mount(imgWrap, el('img', {
        src: (view === 'FRONT' ? a.image_front : a.image_back) || '/img/jeans-front.svg',
        alt: `${a.style_code} ${view.toLowerCase()} view`,
        onError: (e) => { e.target.src = '/img/jeans-front.svg'; },
      }));
      drawPins();
    };

    imgWrap.addEventListener('click', (e) => {
      const img = imgWrap.querySelector('img');
      if (!img || e.target.classList.contains('pin')) return;
      const r = img.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      defectDialog({ pos_x: Math.round(x * 1000) / 1000, pos_y: Math.round(y * 1000) / 1000 });
    });

    function defectDialog(pos) {
      const codeSel = select(defectCodes.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` })));
      const sevSel = select(['CRITICAL', 'MAJOR', 'MINOR'].map((s) => ({ value: s, label: s })));
      const note = el('input', { placeholder: 'e.g. left knee, 5 cm from seam' });
      codeSel.addEventListener('change', () => {
        const d = defectCodes.find((x) => x.id === Number(codeSel.value));
        if (d) sevSel.value = d.severity;
      });
      const first = defectCodes.find((x) => x.id === Number(codeSel.value));
      if (first) sevSel.value = first.severity;

      modal({
        title: 'Record a defect',
        subtitle: pos ? `Marked on the ${view.toLowerCase()} view` : 'No position on the design',
        body: el('div', { class: 'form-grid' },
          field('Defect', codeSel), field('Severity', sevSel), field('Note', note)),
        actions: [
          { label: 'Cancel', onClick: (close) => close() },
          { label: 'Add defect', class: 'btn-primary', onClick: (close) => {
            const code = defectCodes.find((x) => x.id === Number(codeSel.value));
            defects.push({
              defect_code_id: code.id, name: code.name, code: code.code,
              severity: sevSel.value, view, note: note.value.trim() || null,
              pos_x: pos?.pos_x ?? null, pos_y: pos?.pos_y ?? null,
            });
            close(); drawPins(); drawList();
          } },
        ],
      });
    }

    const historyRows = file.inspections.flatMap((i) => [{
      when: i.inspected_at, result: i.result, attempt: i.attempt,
      inspector: i.inspector_name, detail: i.defects.map((d) => d.name).join(', ') || i.remarks || '-',
    }]);

    setImage();
    drawList();

    mount(target, card(`${a.serial_no} · ${a.style_code} ${a.style_name}`,
      el('div', { class: 'grid-2' },
        el('div', {},
          el('div', { class: 'inline mb' },
            el('button', { class: 'btn btn-sm', onClick: () => { view = 'FRONT'; setImage(); } }, 'Front'),
            el('button', { class: 'btn btn-sm', onClick: () => { view = 'BACK'; setImage(); } }, 'Back'),
            el('span', { class: 'hint' }, 'Click the design where the defect is')),
          imgWrap),
        el('div', {},
          kv([
            ['Tag', el('span', { class: 'mono' }, a.epc)],
            ['Design', `${a.style_code} · ${a.style_name}`],
            ['Colour', el('span', {}, swatch(a.color_hex), ' ', a.color_name)],
            ['Size', a.size_code],
            ['Order', a.order_no || '-'],
            ['Customer', a.customer_name || '-'],
            ['Bundle', a.bundle_no || '-'],
            ['In QC since', `${dateTime(a.stage_since)} (${age((Date.now() - new Date(String(a.stage_since).replace(' ', 'T')).getTime()) / 3600000)})`],
            ['QC state', chip(a.qc_state)],
            ['Previous failures', String(a.qc_fail_count)],
          ]),
          el('div', { class: 'sep' }),
          el('h4', { class: 'mb' }, 'Defects on this inspection'),
          listBox,
          el('button', { class: 'btn btn-sm mt', onClick: () => defectDialog(null) }, '+ Add defect without a position'),
          el('div', { class: 'sep' }),
          field('Inspection remarks', remarks),
          historyRows.length ? el('div', { class: 'mt' },
            el('h4', { class: 'mb' }, 'Previous inspections'),
            table([
              { key: 'attempt', label: '#', num: true },
              { key: 'result', label: 'Result', render: (r) => chip(r.result) },
              { key: 'when', label: 'When', render: (r) => dateTime(r.when) },
              { key: 'inspector', label: 'Inspector' },
              { key: 'detail', label: 'Detail' },
            ], historyRows, { maxHeight: '180px' })) : null)),
      { tight: false,
        subtitle: `${a.order_no || 'no order'} · ${a.customer_name || 'no customer'}`,
        actions: can('qc.inspect') ? el('div', { class: 'inline' },
          el('button', { class: 'btn btn-danger btn-lg', onClick: () => submit('FAIL') }, 'Fail — send to retrofit'),
          el('button', { class: 'btn btn-ok btn-lg', onClick: () => submit('PASS') }, 'Pass')) : null }));

    async function submit(result) {
      if (result === 'FAIL' && !defects.length) {
        toast('Reason required', 'Mark at least one defect before failing a garment.', 'warn');
        return;
      }
      try {
        const out = await api.post('/api/qc/inspect', {
          article_id: a.id, result, remarks: remarks.value.trim() || null,
          defects: defects.map((d) => ({
            defect_code_id: d.defect_code_id, severity: d.severity, view: d.view,
            pos_x: d.pos_x, pos_y: d.pos_y, note: d.note })),
        });
        if (result === 'PASS') toastOk(`${a.serial_no} passed`, 'Ready to move to dispatch.');
        else toast(`${a.serial_no} failed`, `${defects.length} defect(s) recorded. Dispatch it to retrofitting.`, 'warn');
        mount(target, card(result === 'PASS' ? 'Passed' : 'Failed',
          el('div', {},
            el('p', {}, `${a.serial_no} — ${out.article.qc_state}`),
            el('p', { class: 'hint' }, result === 'FAIL'
              ? 'A retrofit job has been opened. Send the garment to retrofitting on a transfer note.'
              : 'The garment can now be dispatched to the dispatch section.'),
            el('div', { class: 'inline mt' },
              el('button', { class: 'btn btn-primary', onClick: () => showInspect() }, 'Inspect the next garment'),
              result === 'FAIL' ? el('button', { class: 'btn', onClick: () => go('transfers', { stage: 'QC' }) }, 'Dispatch to retrofit') : null))));
      } catch (e) { toastErr(e); }
    }
  }

  /* ------------------------------- Queue -------------------------------- */
  async function showQueue() {
    const [{ rows }, pending] = await Promise.all([
      api.get('/api/qc/queue', { limit: 500 }),
      api.get('/api/movements/pending/QC'),
    ]);
    const waiting = rows.filter((r) => r.qc_state === 'PENDING' || r.qc_state === 'REWORKED');
    const passed = rows.filter((r) => r.qc_state === 'PASS');
    const failed = rows.filter((r) => r.qc_state === 'FAIL');

    mount(body, 
      el('div', { class: 'stats' },
        stat('Awaiting inspection', num(waiting.length), { tone: waiting.length ? 'warn' : 'ok' }),
        stat('Passed, awaiting dispatch', num(passed.length), { tone: 'ok' }),
        stat('Failed, awaiting transfer to retrofit', num(failed.length), { tone: failed.length ? 'danger' : 'ok' }),
        stat('Batches inbound', num(pending.rows.length))),

      card('Garments in QC',
        table([
          { key: 'serial_no', label: 'Serial No', mono: true },
          { key: 'epc', label: 'Tag', mono: true },
          { key: 'style_code', label: 'Style' },
          { key: 'color_code', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_code) },
          { key: 'size_code', label: 'Size' },
          { key: 'order_no', label: 'Order' },
          { key: 'customer_name', label: 'Customer' },
          { key: 'qc_state', label: 'QC state', render: (r) => chip(r.qc_state) },
          { key: 'qc_fail_count', label: 'Fails', num: true },
          { key: 'stage_since', label: 'Here since', render: (r) => dateTime(r.stage_since) },
          { key: 'waiting', label: 'Waiting', num: true, render: (r) => {
            const h = (Date.now() - new Date(String(r.stage_since).replace(' ', 'T')).getTime()) / 3600000;
            return chip(age(h), h > 24 ? 'danger' : h > 8 ? 'warn' : ''); } },
        ], rows, {
          onRow: async (r) => {
            activateTab('Inspect');
            await show('inspect');
            await inspectPanel(r.id, inspectMount);
            inspectMount.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
          empty: 'QC is empty', emptyHint: 'Nothing has been received into QC.', maxHeight: '520px',
        }),
        { tight: true, subtitle: 'Click a garment to inspect it' }));
  }

  /* ----------------------------- Analysis ------------------------------- */
  async function showAnalysis() {
    const styles = await masters('styles');
    let styleId = styles[0]?.id;
    let view = 'FRONT';

    const mapBox = el('div');
    const [pareto, quality] = await Promise.all([
      api.get('/api/qc/pareto', {}),
      api.get('/api/kpi/quality'),
    ]);

    const maxQty = Math.max(1, ...pareto.rows.map((r) => r.qty));

    async function drawMap() {
      mount(mapBox, el('div', { class: 'loading' }, 'Loading defect positions...'));
      const style = styles.find((s) => s.id === Number(styleId));
      const { rows } = await api.get('/api/qc/defect-map', { style_id: styleId, view });
      const wrap = el('div', { class: 'defectmap' },
        el('img', { src: (view === 'FRONT' ? style?.image_front : style?.image_back) || '/img/jeans-front.svg',
          onError: (e) => { e.target.src = '/img/jeans-front.svg'; } }));
      for (const d of rows) {
        wrap.appendChild(el('div', { class: `pin heat ${d.severity}`,
          style: { left: `${d.pos_x * 100}%`, top: `${d.pos_y * 100}%` }, title: `${d.name} (${d.severity})` }));
      }
      mount(mapBox, 
        el('div', { class: 'inline mb' },
          el('button', { class: 'btn btn-sm', onClick: () => { view = 'FRONT'; drawMap(); } }, 'Front'),
          el('button', { class: 'btn btn-sm', onClick: () => { view = 'BACK'; drawMap(); } }, 'Back'),
          el('span', { class: 'hint' }, `${rows.length} positioned defect(s)`)),
        wrap);
    }

    mount(body, 
      el('div', { class: 'grid-2' },
        card('Where defects occur on the design',
          el('div', {},
            field('Design', select(styles.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })),
              { value: styleId, onChange: (v) => { styleId = Number(v); drawMap(); } })),
            el('div', { class: 'mt' }, mapBox)),
          { subtitle: 'Every marker is one recorded defect' }),

        card('Most common defects',
          table([
            { key: 'name', label: 'Defect' },
            { key: 'category', label: 'Category' },
            { key: 'severity', label: 'Severity', render: (r) => chip(r.severity) },
            { key: 'qty', label: 'Count', num: true, render: (r) => num(r.qty) },
            { key: 'graph', label: '', render: (r) => el('div', { class: 'bar' },
              el('span', { style: { width: `${(r.qty / maxQty) * 100}%`,
                background: r.severity === 'CRITICAL' ? 'var(--danger)' : r.severity === 'MAJOR' ? 'var(--warn)' : 'var(--info)' } })) },
          ], pareto.rows, { empty: 'No defects recorded yet', maxHeight: '460px' }), { tight: true })),

      card('Inspector activity',
        table([
          { key: 'full_name', label: 'Inspector' },
          { key: 'inspections', label: 'Inspections', num: true, render: (r) => num(r.inspections) },
          { key: 'failed', label: 'Failed', num: true, render: (r) => num(r.failed) },
          { key: 'fail_rate', label: 'Fail rate', num: true, render: (r) => chip(r.fail_rate + '%', r.fail_rate > 15 ? 'warn' : '') },
        ], quality.by_inspector, { empty: 'No inspections in this period' }),
        { tight: true, subtitle: 'Last 7 days - a very low or very high rate is worth a conversation, not a conclusion' }));

    await drawMap();
  }

  await show('inspect');
  return root;
}
