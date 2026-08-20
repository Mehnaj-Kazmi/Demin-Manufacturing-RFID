import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr,
  stat, empty, promptDialog, confirmDialog, bar, mount
} from '../ui.js';
import { can } from '../app.js';

/**
 * Modular report designer.
 *
 * The server publishes a catalogue of datasets and the fields each one exposes.
 * The user assembles columns, filters, groupings and aggregates from that
 * catalogue, so any report they can build is one the server can safely run.
 */
export async function render(ctx) {
  ctx.setSubtitle('Build your own reports - pick a dataset, choose the columns, filters and grouping');

  const [cat, saved] = await Promise.all([
    api.get('/api/reports/catalogue'),
    api.get('/api/reports/saved'),
  ]);

  const def = {
    dataset: cat.datasets[0].key,
    mode: 'detail',            // 'detail' | 'grouped'
    columns: [...cat.datasets[0].default_columns],
    group_by: [],
    aggregates: [],
    filters: [],
    sort: [],
    limit: 1000,
    name: '',
  };
  let currentId = null;

  const root = el('div');
  const designer = el('div');
  const resultBox = el('div');
  const savedBox = el('div');

  const dataset = () => cat.datasets.find((d) => d.key === def.dataset);
  const fieldOf = (key) => dataset().fields.find((f) => f.key === key);

  /* ---------------------------- Saved reports --------------------------- */
  function drawSaved(rows) {
    mount(savedBox, card('Saved reports',
      table([
        { key: 'name', label: 'Report' },
        { key: 'dataset', label: 'Dataset', render: (r) => cat.datasets.find((d) => d.key === r.dataset)?.label || r.dataset },
        { key: 'owner_name', label: 'Created by' },
        { key: 'updated_at', label: 'Updated', render: (r) => dateTime(r.updated_at) },
        { key: 'act', label: '', render: (r) => el('div', { class: 'inline' },
          el('button', { class: 'btn btn-sm btn-primary', onClick: async (e) => {
            e.stopPropagation();
            const { report } = await api.get(`/api/reports/saved/${r.id}`);
            loadDefinition(report);
          } }, 'Open'),
          can('reports.design') ? el('button', { class: 'btn btn-sm', onClick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({ title: `Delete "${r.name}"?`,
              message: 'The saved layout is removed. Data is not affected.', confirmLabel: 'Delete', tone: 'btn-danger' });
            if (!ok) return;
            try { await api.del(`/api/reports/saved/${r.id}`); toastOk('Report deleted'); refreshSaved(); }
            catch (err) { toastErr(err); }
          } }, 'Delete') : null) },
      ], rows, { empty: 'No saved reports yet', emptyHint: 'Build one below and save it for the team.' }),
      { tight: true }));
  }

  async function refreshSaved() { drawSaved((await api.get('/api/reports/saved')).rows); }

  function loadDefinition(report) {
    currentId = report.id;
    const d = report.definition;
    def.dataset = report.dataset;
    def.columns = d.columns || [];
    def.group_by = d.group_by || [];
    def.aggregates = d.aggregates || [];
    def.filters = d.filters || [];
    def.sort = d.sort || [];
    def.limit = d.limit || 1000;
    def.name = report.name;
    def.mode = def.group_by.length || def.aggregates.length ? 'grouped' : 'detail';
    drawDesigner();
    run();
    toast('Report loaded', report.name);
  }

  /* ------------------------------ Designer ------------------------------ */
  function drawDesigner() {
    const ds = dataset();

    const dsSel = select(cat.datasets.map((d) => ({ value: d.key, label: d.label })),
      { value: def.dataset, onChange: (v) => {
        def.dataset = v;
        const nd = dataset();
        def.columns = [...nd.default_columns];
        def.group_by = []; def.aggregates = []; def.filters = []; def.sort = [];
        currentId = null;
        drawDesigner();
      } });

    const modeSel = select([
      { value: 'detail', label: 'Detail - one row per record' },
      { value: 'grouped', label: 'Summary - grouped with totals' },
    ], { value: def.mode, onChange: (v) => { def.mode = v; drawDesigner(); } });

    /* Columns / groupings */
    const columnPicker = el('div', { class: 'pill-row' },
      ds.fields.filter((f) => def.mode === 'detail' || f.groupable).map((f) => {
        const active = def.mode === 'detail' ? def.columns.includes(f.key) : def.group_by.includes(f.key);
        const cb = el('input', { type: 'checkbox', checked: active });
        cb.addEventListener('change', () => {
          const list = def.mode === 'detail' ? def.columns : def.group_by;
          const i = list.indexOf(f.key);
          if (cb.checked && i < 0) list.push(f.key);
          if (!cb.checked && i >= 0) list.splice(i, 1);
        });
        return el('label', { class: 'checkbox' }, cb, f.label);
      }));

    /* Aggregates */
    const aggBox = el('div');
    const drawAgg = () => {
      mount(aggBox, table([
        { key: 'fn', label: 'Calculation', render: (a) => select(cat.aggregates.map((x) => ({ value: x.key, label: x.label })),
          { value: a.fn, onChange: (v) => { a.fn = v; } }) },
        { key: 'field', label: 'Of field', render: (a) => select(
          ds.fields.filter((f) => f.aggregatable || f.key === a.field).map((f) => ({ value: f.key, label: f.label })),
          { value: a.field, onChange: (v) => { a.field = v; } }) },
        { key: 'label', label: 'Column heading', render: (a) => {
          const i = el('input', { value: a.label || '', placeholder: 'Optional' });
          i.addEventListener('input', () => { a.label = i.value; });
          return i;
        } },
        { key: 'rm', label: '', render: (a) => el('button', { class: 'btn btn-sm',
          onClick: () => { def.aggregates.splice(def.aggregates.indexOf(a), 1); drawAgg(); } }, 'Remove') },
      ], def.aggregates, { empty: 'No calculations - a simple row count will be shown' }));
    };
    drawAgg();

    /* Filters */
    const filterBox = el('div');
    const drawFilters = () => {
      mount(filterBox, table([
        { key: 'field', label: 'Field', render: (f) => select(
          ds.fields.filter((x) => x.filterable).map((x) => ({ value: x.key, label: x.label })),
          { value: f.field, onChange: (v) => { f.field = v; drawFilters(); } }) },
        { key: 'op', label: 'Condition', render: (f) => select(
          cat.operators.map((o) => ({ value: o.key, label: o.label })),
          { value: f.op, onChange: (v) => { f.op = v; drawFilters(); } }) },
        { key: 'value', label: 'Value', render: (f) => {
          const op = cat.operators.find((o) => o.key === f.op);
          if (!op || op.args === 0) return el('span', { class: 'hint' }, 'no value needed');
          const meta = fieldOf(f.field);
          const type = meta?.type === 'date' && !['last_days'].includes(f.op) ? 'date'
            : meta?.type === 'number' || f.op === 'last_days' ? 'number' : 'text';
          const i = el('input', { type, value: f.value ?? '',
            placeholder: op.args === 'list' ? 'comma separated' : '' });
          i.addEventListener('input', () => { f.value = i.value; });
          if (op.args === 2) {
            const i2 = el('input', { type, value: f.value2 ?? '' });
            i2.addEventListener('input', () => { f.value2 = i2.value; });
            return el('div', { class: 'inline' }, i, el('span', { class: 'hint' }, 'and'), i2);
          }
          return i;
        } },
        { key: 'rm', label: '', render: (f) => el('button', { class: 'btn btn-sm',
          onClick: () => { def.filters.splice(def.filters.indexOf(f), 1); drawFilters(); } }, 'Remove') },
      ], def.filters, { empty: 'No filters - the whole dataset will be reported' }));
    };
    drawFilters();

    /* Sorting */
    const sortBox = el('div');
    const drawSort = () => {
      const sortable = def.mode === 'detail'
        ? ds.fields.map((f) => ({ value: f.key, label: f.label }))
        : [...def.group_by.map((k) => ({ value: k, label: fieldOf(k)?.label || k })),
           ...def.aggregates.map((a) => ({ value: a.label || `${a.fn.toLowerCase()}_${a.field}`,
             label: a.label || `${a.fn} of ${fieldOf(a.field)?.label || a.field}` }))];
      mount(sortBox, table([
        { key: 'field', label: 'Sort by', render: (s) => select(sortable, { value: s.field, onChange: (v) => { s.field = v; } }) },
        { key: 'dir', label: 'Direction', render: (s) => select(
          [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }],
          { value: s.dir, onChange: (v) => { s.dir = v; } }) },
        { key: 'rm', label: '', render: (s) => el('button', { class: 'btn btn-sm',
          onClick: () => { def.sort.splice(def.sort.indexOf(s), 1); drawSort(); } }, 'Remove') },
      ], def.sort, { empty: 'Default order' }));
    };
    drawSort();

    const limitInput = el('input', { type: 'number', min: '1', max: '100000', value: String(def.limit) });
    limitInput.addEventListener('input', () => { def.limit = Number(limitInput.value) || 1000; });

    mount(designer, card('Design the report',
      el('div', {},
        el('div', { class: 'form-grid mb' },
          field('Dataset', dsSel, ds.description),
          field('Report type', modeSel),
          field('Maximum rows', limitInput)),

        el('div', { class: 'sep' }),
        el('h4', { class: 'mb' }, def.mode === 'detail' ? 'Columns to show' : 'Group the data by'),
        columnPicker,

        def.mode === 'grouped' ? el('div', {},
          el('div', { class: 'sep' }),
          el('div', { class: 'inline mb' }, el('h4', {}, 'Calculations'),
            el('button', { class: 'btn btn-sm', onClick: () => {
              const f = ds.fields.find((x) => x.aggregatable) || ds.fields[0];
              def.aggregates.push({ fn: 'COUNT', field: f.key, label: '' }); drawAgg();
            } }, '+ Add calculation')),
          aggBox) : null,

        el('div', { class: 'sep' }),
        el('div', { class: 'inline mb' }, el('h4', {}, 'Filters'),
          el('button', { class: 'btn btn-sm', onClick: () => {
            const f = ds.fields.find((x) => x.filterable);
            def.filters.push({ field: f.key, op: 'eq', value: '' }); drawFilters();
          } }, '+ Add filter')),
        filterBox,

        el('div', { class: 'sep' }),
        el('div', { class: 'inline mb' }, el('h4', {}, 'Sorting'),
          el('button', { class: 'btn btn-sm', onClick: () => { def.sort.push({ field: '', dir: 'desc' }); drawSort(); } }, '+ Add sort')),
        sortBox,

        el('div', { class: 'sep' }),
        el('div', { class: 'inline' },
          el('button', { class: 'btn btn-primary btn-lg', onClick: run }, 'Run report'),
          el('button', { class: 'btn', onClick: exportCsv }, 'Export to CSV'),
          can('reports.design') ? el('button', { class: 'btn', onClick: saveReport }, currentId ? 'Save changes' : 'Save this report') : null,
          can('reports.design') && currentId ? el('button', { class: 'btn', onClick: () => { currentId = null; def.name = ''; toast('Saving as a new report'); } }, 'Save as new') : null))));
  }

  /* ------------------------------- Running ------------------------------ */
  function payload() {
    return {
      dataset: def.dataset,
      columns: def.mode === 'detail' ? def.columns : [],
      group_by: def.mode === 'grouped' ? def.group_by : [],
      aggregates: def.mode === 'grouped' ? def.aggregates.filter((a) => a.fn && a.field) : [],
      filters: def.filters.filter((f) => f.field && f.op),
      sort: def.sort.filter((s) => s.field),
      limit: def.limit,
    };
  }

  async function run() {
    mount(resultBox, card('Results', el('div', { class: 'loading' }, 'Running the report...'), { tight: true }));
    try {
      const out = await api.post('/api/reports/run', payload());
      const cols = out.columns.map((c) => ({
        key: c.key, label: c.label, num: c.type === 'number',
        render: c.type === 'number' ? (r) => num(r[c.key])
          : c.type === 'date' ? (r) => dateTime(r[c.key]) : undefined,
      }));

      // A grouped report with one metric gets an inline magnitude bar.
      const metric = out.columns.find((c) => c.role === 'metric');
      if (metric) {
        const max = Math.max(1, ...out.rows.map((r) => Number(r[metric.key]) || 0));
        cols.push({ key: '__bar', label: '', render: (r) => bar(((Number(r[metric.key]) || 0) / max) * 100) });
      }

      mount(resultBox, card(def.name || 'Results',
        el('div', {},
          out.truncated ? el('p', { class: 'hint', style: { padding: '10px 17px 0' } },
            `Showing the first ${num(out.row_count)} rows - raise the row limit or add filters to narrow it down.`) : null,
          table(cols, out.rows, { empty: 'No rows match this report', maxHeight: '560px' })),
        { tight: true,
          subtitle: `${num(out.row_count)} row(s)`,
          actions: el('div', { class: 'inline' },
            el('button', { class: 'btn btn-sm', onClick: exportCsv }, 'Export CSV'),
            el('button', { class: 'btn btn-sm', onClick: () => modal({
              title: 'Query that was run',
              subtitle: 'Every field comes from the server-side catalogue; values are bound parameters',
              body: el('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', margin: 0 } }, out.sql),
              actions: [{ label: 'Close', onClick: (c) => c() }] }) }, 'Show query')) }));
    } catch (e) {
      mount(resultBox, card('Results', empty('This report could not be run', e.message), { tight: true }));
      toastErr(e);
    }
  }

  async function exportCsv() {
    try {
      await api.download('/api/reports/export',
        { ...payload(), limit: Math.max(def.limit, 50000), name: def.name || def.dataset },
        `${(def.name || def.dataset).replace(/[^A-Za-z0-9_-]+/g, '_')}.csv`);
      toastOk('Export started', 'The CSV is downloading.');
    } catch (e) { toastErr(e); }
  }

  async function saveReport() {
    const name = await promptDialog({
      title: currentId ? 'Save changes' : 'Save this report',
      label: 'Report name', value: def.name,
      help: 'Saved reports are shared with everyone who can view reports.',
      confirmLabel: 'Save',
    });
    if (!name) return;
    try {
      const out = await api.post('/api/reports/saved', {
        id: currentId, name, dataset: def.dataset, definition: payload(), shared: true });
      currentId = out.report.id;
      def.name = out.report.name;
      toastOk('Report saved', name);
      refreshSaved();
    } catch (e) { toastErr(e); }
  }

  root.append(savedBox, designer, resultBox);
  drawSaved(saved.rows);
  drawDesigner();
  await run();
  return root;
}
