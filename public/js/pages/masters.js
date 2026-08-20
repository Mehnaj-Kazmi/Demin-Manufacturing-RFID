import { api } from '../api.js';
import {
  el, card, table, chip, num, select, field, modal, toast, toastOk, toastErr, tabs, swatch, empty, mount
} from '../ui.js';
import { state, masters as cachedMasters } from '../app.js';

/** Master data maintenance: customers, fabrics, colours, sizes, designs and defect codes. */
export async function render(ctx) {
  ctx.setSubtitle('Reference data used across the whole system');

  const ENTITIES = {
    styles: {
      label: 'Designs / Styles',
      hint: 'The design image is what QC marks defects on, so keep it accurate.',
      fields: [
        { key: 'code', label: 'Style code', required: true },
        { key: 'name', label: 'Name', required: true },
        { key: 'description', label: 'Description' },
        { key: 'fabric_type_id', label: 'Fabric type', type: 'ref', ref: 'fabric_types' },
        { key: 'image_front', label: 'Front image URL', hint: 'e.g. /img/jeans-front.svg' },
        { key: 'image_back', label: 'Back image URL' },
        { key: 'wash_recipe', label: 'Standard wash recipe' },
        { key: 'smv', label: 'SMV (minutes)', type: 'number' },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: (refs) => [
        { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Design' },
        { key: 'fabric_type_id', label: 'Fabric', render: (r) => refs.fabric_types?.find((f) => f.id === r.fabric_type_id)?.name || '-' },
        { key: 'wash_recipe', label: 'Wash recipe' },
        { key: 'smv', label: 'SMV', num: true },
        { key: 'image_front', label: 'Image', render: (r) => r.image_front
          ? el('img', { src: r.image_front, style: { height: '38px' }, onError: (e) => e.target.remove() }) : '-' },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
    customers: {
      label: 'Customers',
      hint: 'The tag specification is shown to the dispatch operator when the customer tag is applied.',
      fields: [
        { key: 'code', label: 'Code', required: true },
        { key: 'name', label: 'Name', required: true },
        { key: 'country', label: 'Country' },
        { key: 'tag_spec', label: 'Customer tag specification', hint: 'e.g. SGTIN-96, GS1 prefix 0614141' },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: () => [
        { key: 'code', label: 'Code', mono: true }, { key: 'name', label: 'Customer' },
        { key: 'country', label: 'Country' }, { key: 'tag_spec', label: 'Tag specification' },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
    fabric_types: {
      label: 'Fabric types',
      fields: [
        { key: 'code', label: 'Code', required: true },
        { key: 'name', label: 'Name', required: true },
        { key: 'composition', label: 'Composition' },
        { key: 'weight_oz', label: 'Weight (oz)', type: 'number' },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: () => [
        { key: 'code', label: 'Code', mono: true }, { key: 'name', label: 'Fabric' },
        { key: 'composition', label: 'Composition' }, { key: 'weight_oz', label: 'Weight (oz)', num: true },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
    colors: {
      label: 'Colours',
      fields: [
        { key: 'code', label: 'Code', required: true },
        { key: 'name', label: 'Name', required: true },
        { key: 'hex', label: 'Swatch colour', type: 'color' },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: () => [
        { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Colour', render: (r) => el('span', {}, swatch(r.hex), ' ', r.name) },
        { key: 'hex', label: 'Hex', mono: true },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
    sizes: {
      label: 'Sizes',
      hint: 'Sort order controls how sizes appear on every report and document.',
      fields: [
        { key: 'code', label: 'Code', required: true },
        { key: 'name', label: 'Name', required: true },
        { key: 'sort_ord', label: 'Sort order', type: 'number' },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: () => [
        { key: 'sort_ord', label: 'Order', num: true }, { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Size' },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
    defect_codes: {
      label: 'Defect codes',
      hint: 'These are the reasons a QC inspector can choose when failing a garment.',
      fields: [
        { key: 'code', label: 'Code', required: true },
        { key: 'name', label: 'Defect', required: true },
        { key: 'category', label: 'Category', type: 'choice',
          choices: ['STITCHING', 'FABRIC', 'WASH', 'FINISHING', 'MEASUREMENT'] },
        { key: 'severity', label: 'Default severity', type: 'choice', choices: ['CRITICAL', 'MAJOR', 'MINOR'] },
        { key: 'active', label: 'Active', type: 'bool' },
      ],
      columns: () => [
        { key: 'code', label: 'Code', mono: true }, { key: 'name', label: 'Defect' },
        { key: 'category', label: 'Category', render: (r) => chip(r.category || '-') },
        { key: 'severity', label: 'Severity', render: (r) => chip(r.severity) },
        { key: 'active', label: 'Active', render: (r) => chip(r.active ? 'ACTIVE' : 'INACTIVE', r.active ? 'ok' : '') },
      ],
    },
  };

  const root = el('div');
  const body = el('div');
  let current = ctx.params.entity && ENTITIES[ctx.params.entity] ? ctx.params.entity : 'styles';

  root.appendChild(tabs(Object.entries(ENTITIES).map(([key, e]) => ({ key, label: e.label })),
    (k) => { current = k; load(); }, current));
  root.appendChild(body);

  const refs = { fabric_types: await cachedMasters('fabric_types') };

  async function load() {
    mount(body, el('div', { class: 'loading' }, 'Loading...'));
    const def = ENTITIES[current];
    const { rows } = await api.get(`/api/masters/${current}`);

    mount(body, card(def.label,
      table(def.columns(refs), rows, {
        onRow: (r) => editDialog(r),
        empty: `No ${def.label.toLowerCase()} defined yet`,
        maxHeight: '560px',
      }),
      { tight: true, subtitle: def.hint,
        actions: el('button', { class: 'btn btn-sm btn-primary', onClick: () => editDialog(null) }, `+ New`) }));
  }

  function editDialog(row) {
    const def = ENTITIES[current];
    const inputs = {};

    const controls = def.fields.map((f) => {
      let control;
      if (f.type === 'bool') {
        control = select([{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }],
          { value: row ? String(row[f.key] ?? 1) : '1' });
      } else if (f.type === 'choice') {
        control = select(f.choices.map((c) => ({ value: c, label: c })), { value: row?.[f.key] ?? f.choices[0] });
      } else if (f.type === 'ref') {
        control = select([{ value: '', label: '(none)' }, ...(refs[f.ref] || []).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))],
          { value: row?.[f.key] ?? '' });
      } else if (f.type === 'color') {
        control = el('input', { type: 'color', value: row?.[f.key] || '#3355aa' });
      } else {
        control = el('input', { type: f.type === 'number' ? 'number' : 'text',
          value: row?.[f.key] ?? '', step: f.type === 'number' ? 'any' : undefined });
      }
      inputs[f.key] = { control, def: f };
      return field(f.label + (f.required ? ' *' : ''), control, f.hint);
    });

    modal({
      title: row ? `Edit ${row.code}` : `New ${def.label.replace(/s$/, '')}`,
      subtitle: def.hint,
      body: el('div', { class: 'form-grid' }, controls),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: row ? 'Save changes' : 'Create', class: 'btn-primary', onClick: async (close) => {
          const payload = {};
          for (const [key, { control, def: f }] of Object.entries(inputs)) {
            let v = control.value;
            if (f.required && !String(v).trim()) { toast(`${f.label} is required`, '', 'warn'); return; }
            if (f.type === 'number') v = v === '' ? null : Number(v);
            else if (f.type === 'bool') v = Number(v);
            else if (f.type === 'ref') v = v === '' ? null : Number(v);
            else v = String(v).trim() || null;
            payload[key] = v;
          }
          try {
            if (row) await api.put(`/api/masters/${current}/${row.id}`, payload);
            else await api.post(`/api/masters/${current}`, payload);
            close();
            toastOk(row ? 'Changes saved' : 'Created');
            delete state.masters[current];          // invalidate the cached lookup
            if (current === 'fabric_types') refs.fabric_types = await cachedMasters('fabric_types', { force: true });
            load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  await load();
  return root;
}
