import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, age, field, modal, toast, toastOk, toastErr,
  stat, empty, kv, swatch, confirmDialog, mount
} from '../ui.js';
import { can, stageName, go } from '../app.js';

/**
 * Retrofitting bench.
 *
 * The operator scans a garment and everything the QC inspector recorded pops up -
 * including where on the design each defect sits - so the correction can be made
 * without guesswork. Completing the job frees the garment to go back to QC.
 */
export async function render(ctx) {
  ctx.setSubtitle('Scan a garment to see exactly what QC found, correct it, then send it back for re-inspection');

  const root = el('div');
  const scanBox = el('div');
  const workBox = el('div');
  const queueBox = el('div');

  const scanInput = el('input', {
    placeholder: 'Scan the garment tag...', class: 'mono',
    style: { fontSize: '16px', padding: '13px' }, autofocus: true,
  });

  const lookup = async () => {
    const epc = scanInput.value.trim().toUpperCase();
    if (!epc) return;
    mount(workBox, el('div', { class: 'loading' }, 'Loading the defect file...'));
    try {
      const file = await api.get(`/api/rework/scan/${encodeURIComponent(epc)}`);
      scanInput.value = '';
      showFile(file);
    } catch (e) {
      mount(workBox, card('Cannot open this garment', el('p', {}, e.message)));
    }
    scanInput.focus();
  };
  scanInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });

  scanBox.appendChild(card('Pick up a garment',
    el('div', {},
      el('p', { class: 'hint mb' }, 'Scanning the tag shows the design, the defects marked on it, who inspected it and when.'),
      el('div', { class: 'inline' }, scanInput,
        el('button', { class: 'btn btn-primary btn-lg', onClick: lookup }, 'Open'))),
    { subtitle: 'Retrofit bench' }));

  root.append(scanBox, workBox, queueBox);

  /* ---------------------------- Defect file ----------------------------- */
  function showFile(file) {
    const a = file.article;
    const open = file.open_defects;
    let view = 'FRONT';

    const imgWrap = el('div', { class: 'defectmap' });
    const chosen = new Set(open.map((d) => d.id));   // all corrections assumed done by default

    const drawImage = () => {
      mount(imgWrap, el('img', {
        src: (view === 'FRONT' ? a.image_front : a.image_back) || '/img/jeans-front.svg',
        onError: (e) => { e.target.src = '/img/jeans-front.svg'; } }));
      open.filter((d) => d.view === view && d.pos_x !== null).forEach((d) => {
        imgWrap.appendChild(el('div', {
          class: `pin ${d.severity}`, style: { left: `${d.pos_x * 100}%`, top: `${d.pos_y * 100}%` },
          title: `${d.name}${d.note ? ' - ' + d.note : ''}` }, String(open.indexOf(d) + 1)));
      });
    };
    drawImage();

    const defectList = el('div', { class: 'defect-list' },
      open.length ? open.map((d, i) => {
        const cb = el('input', { type: 'checkbox', checked: true });
        cb.addEventListener('change', () => { cb.checked ? chosen.add(d.id) : chosen.delete(d.id); });
        return el('label', { class: 'defect-row' },
          el('div', { class: `idx pin ${d.severity}`, style: { position: 'static', margin: 0 } }, String(i + 1)),
          el('div', { style: { flex: 1 } },
            el('strong', {}, d.name),
            el('div', { class: 'hint' },
              `${d.code} · ${d.severity} · ${d.view} view${d.note ? ' · ' + d.note : ''}` +
              (d.pos_x === null ? ' · no position marked' : ''))),
          el('span', { class: 'inline' }, cb, el('span', { class: 'hint' }, 'corrected')));
      }) : el('p', { class: 'hint' }, 'No unresolved defects are recorded against this garment.'));

    const action = el('textarea', { rows: 2, placeholder: 'What did you do to correct it? e.g. re-stitched the left knee seam and pressed' });
    const remarks = el('input', { placeholder: 'Anything QC should know on re-inspection' });

    const inSection = a.stage === 'RETROFIT';

    mount(workBox, card(`${a.serial_no} · ${a.style_code} ${a.style_name}`,
      el('div', { class: 'grid-2' },
        el('div', {},
          el('div', { class: 'inline mb' },
            el('button', { class: 'btn btn-sm', onClick: () => { view = 'FRONT'; drawImage(); } }, 'Front'),
            el('button', { class: 'btn btn-sm', onClick: () => { view = 'BACK'; drawImage(); } }, 'Back'),
            el('span', { class: 'hint' }, 'Numbered markers show exactly where QC found each problem')),
          imgWrap),
        el('div', {},
          kv([
            ['Tag', el('span', { class: 'mono' }, a.epc)],
            ['Design', `${a.style_code} · ${a.style_name}`],
            ['Colour', el('span', {}, swatch(a.color_hex), ' ', a.color_name)],
            ['Size', a.size_code],
            ['Order', a.order_no || '-'],
            ['Customer', a.customer_name || '-'],
            ['Currently in', chip(stageName(a.stage), inSection ? 'brand' : 'warn')],
            ['Times failed', String(a.qc_fail_count)],
            ['Job opened', file.rework ? dateTime(file.rework.opened_at) : '-'],
            ['Job status', file.rework ? chip(file.rework.status) : '-'],
          ]),
          el('div', { class: 'sep' }),
          el('h4', { class: 'mb' }, `Defects to correct (${open.length})`),
          defectList,
          el('div', { class: 'sep' }),
          field('Correction carried out', action),
          field('Remarks', remarks),
          !inSection ? el('p', { class: 'hint mt' },
            `This garment is in ${stageName(a.stage)}, not Retrofitting. Receive it into the section before completing the job.`) : null)),
      { subtitle: file.inspections.length
          ? `Last inspected by ${file.inspections[0].inspector_name} on ${dateTime(file.inspections[0].inspected_at)}`
          : null,
        actions: el('div', { class: 'inline' },
          can('article.adjust') ? el('button', { class: 'btn btn-danger', onClick: () => scrap(a) }, 'Scrap garment') : null,
          can('rework.perform') ? el('button', {
            class: 'btn btn-ok btn-lg', disabled: !inSection,
            onClick: () => complete(a),
          }, 'Mark corrected') : null) }));

    async function complete(article) {
      if (!action.value.trim()) { toast('Describe the correction', 'Write what was done so QC can verify it.', 'warn'); return; }
      try {
        await api.post(`/api/rework/${article.id}/complete`, {
          action_taken: action.value.trim(),
          remarks: remarks.value.trim() || null,
          resolved_defect_ids: [...chosen],
        });
        toastOk(`${article.serial_no} corrected`, 'Dispatch it back to QC for re-inspection.');
        mount(workBox, card('Correction recorded',
          el('div', {},
            el('p', {}, `${article.serial_no} is ready to go back to QC.`),
            el('div', { class: 'inline mt' },
              el('button', { class: 'btn btn-primary', onClick: () => { mount(workBox); scanInput.focus(); } }, 'Next garment'),
              el('button', { class: 'btn', onClick: () => go('transfers', { stage: 'RETROFIT' }) }, 'Dispatch batch to QC')))));
        loadQueue();
      } catch (e) { toastErr(e); }
    }

    async function scrap(article) {
      const reason = await confirmDialog({
        title: `Scrap ${article.serial_no}?`,
        message: 'The garment is written off and removed from work in process. This cannot be undone.',
        confirmLabel: 'Scrap it', tone: 'btn-danger', requireNote: true, noteLabel: 'Why is it being scrapped?',
      });
      if (!reason) return;
      try {
        await api.post(`/api/rework/${article.id}/scrap`, { reason });
        toast('Garment scrapped', `${article.serial_no} written off.`, 'warn');
        mount(workBox);
        loadQueue();
      } catch (e) { toastErr(e); }
    }
  }

  /* ------------------------------- Queue -------------------------------- */
  async function loadQueue() {
    mount(queueBox, el('div', { class: 'loading' }, 'Loading the retrofit queue...'));
    const [{ rows }, pending] = await Promise.all([
      api.get('/api/rework/queue', { limit: 400 }),
      api.get('/api/movements/pending/RETROFIT'),
    ]);
    const openJobs = rows.filter((r) => r.job_status === 'OPEN' || r.job_status === 'IN_PROGRESS');

    mount(queueBox, 
      el('div', { class: 'stats' },
        stat('Garments in retrofitting', num(rows.length), { tone: rows.length ? 'warn' : 'ok' }),
        stat('Jobs still open', num(openJobs.length)),
        stat('Corrected, ready for QC', num(rows.length - openJobs.length), { tone: 'ok' }),
        stat('Batches inbound', num(pending.rows.length))),

      pending.rows.length ? card('Batches waiting to be received',
        table([
          { key: 'doc_no', label: 'Document', mono: true },
          { key: 'expected_count', label: 'Garments', num: true },
          { key: 'created_at', label: 'Sent', render: (r) => dateTime(r.created_at) },
          { key: 'created_by_name', label: 'Sent by' },
        ], pending.rows, { onRow: () => go('transfers', { stage: 'RETROFIT' }) }),
        { tight: true, subtitle: 'Receive them in Transfers before starting work' }) : null,

      card('Retrofit queue',
        table([
          { key: 'serial_no', label: 'Serial No', mono: true },
          { key: 'epc', label: 'Tag', mono: true },
          { key: 'style_code', label: 'Style' },
          { key: 'color_code', label: 'Colour' },
          { key: 'size_code', label: 'Size' },
          { key: 'order_no', label: 'Order' },
          { key: 'open_defects', label: 'Defects', num: true,
            render: (r) => r.open_defects ? chip(String(r.open_defects), 'danger') : chip('corrected', 'ok') },
          { key: 'qc_fail_count', label: 'Fails', num: true },
          { key: 'job_status', label: 'Job', render: (r) => chip(r.job_status || 'NONE') },
          { key: 'opened_at', label: 'Opened', render: (r) => dateTime(r.opened_at) },
          { key: 'waiting', label: 'Waiting', num: true, render: (r) => {
            const h = (Date.now() - new Date(String(r.stage_since).replace(' ', 'T')).getTime()) / 3600000;
            return chip(age(h), h > 24 ? 'danger' : h > 8 ? 'warn' : ''); } },
        ], rows, {
          onRow: async (r) => {
            try { showFile(await api.get(`/api/rework/scan/${encodeURIComponent(r.epc)}`)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
            catch (e) { toastErr(e); }
          },
          empty: 'Nothing in retrofitting', emptyHint: 'No QC failures are waiting for correction.', maxHeight: '520px',
        }),
        { tight: true, subtitle: 'Click a garment to open its defect file' }));
  }

  await loadQueue();
  if (ctx.params.epc) { scanInput.value = ctx.params.epc; lookup(); }
  return root;
}
