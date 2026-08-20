import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr, tabs, kv, empty, mount
} from '../ui.js';
import { state, stageName } from '../app.js';

/** User accounts and RFID reader registration. */
export async function render(ctx) {
  ctx.setSubtitle('Station accounts, roles and the readers installed on the floor');

  const root = el('div');
  const body = el('div');
  root.appendChild(tabs([
    { key: 'users', label: 'Users' },
    { key: 'readers', label: 'RFID readers' },
    { key: 'roles', label: 'Roles & permissions' },
  ], (k) => show(k), 'users'));
  root.appendChild(body);

  async function show(view) {
    mount(body, el('div', { class: 'loading' }, 'Loading...'));
    if (view === 'users') return showUsers();
    if (view === 'readers') return showReaders();
    return showRoles();
  }

  /* -------------------------------- Users ------------------------------- */
  async function showUsers() {
    const { rows } = await api.get('/api/admin/users');
    mount(body, card('User accounts',
      table([
        { key: 'username', label: 'Username', mono: true },
        { key: 'full_name', label: 'Name' },
        { key: 'emp_code', label: 'Employee No' },
        { key: 'role', label: 'Role', render: (r) => chip(r.role, r.role === 'ADMIN' ? 'danger' : 'brand') },
        { key: 'section', label: 'Home section', render: (r) => r.section ? stageName(r.section) : '-' },
        { key: 'active', label: 'Status', render: (r) => chip(r.active ? 'ACTIVE' : 'DISABLED', r.active ? 'ok' : 'danger') },
        { key: 'created_at', label: 'Created', render: (r) => dateTime(r.created_at) },
      ], rows, { onRow: (r) => userDialog(r), empty: 'No users' }),
      { tight: true,
        subtitle: 'A user\'s home section decides which transfers they see first. Every action they take is recorded against them.',
        actions: el('button', { class: 'btn btn-sm btn-primary', onClick: () => userDialog(null) }, '+ New user') }));
  }

  function userDialog(user) {
    const username = el('input', { value: user?.username || '', disabled: !!user });
    const fullName = el('input', { value: user?.full_name || '' });
    const empCode = el('input', { value: user?.emp_code || '' });
    const roleSel = select(state.meta.roles.map((r) => ({ value: r.key, label: `${r.key} · ${r.name}` })),
      { value: user?.role || 'OPERATOR' });
    const sectionSel = select([{ value: '', label: 'No home section' },
      ...state.meta.stages.map((s) => ({ value: s.code, label: s.name }))], { value: user?.section || '' });
    const activeSel = select([{ value: '1', label: 'Active' }, { value: '0', label: 'Disabled' }],
      { value: user ? String(user.active ? 1 : 0) : '1' });
    const password = el('input', { type: 'text', placeholder: user ? 'Leave blank to keep the current password' : 'At least 6 characters' });

    modal({
      title: user ? `Edit ${user.username}` : 'New user account',
      body: el('div', { class: 'form-grid' },
        field('Username', username), field('Full name', fullName), field('Employee number', empCode),
        field('Role', roleSel), field('Home section', sectionSel), field('Status', activeSel),
        field('Password', password, user ? 'Setting a password signs the user out of all devices' : null)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: user ? 'Save changes' : 'Create user', class: 'btn-primary', onClick: async (close) => {
          const payload = {
            full_name: fullName.value.trim(), emp_code: empCode.value.trim() || null,
            role: roleSel.value, section: sectionSel.value || null, active: activeSel.value === '1',
          };
          if (password.value) payload.password = password.value;
          try {
            if (user) await api.put(`/api/admin/users/${user.id}`, payload);
            else {
              if (!username.value.trim()) { toast('Username required', '', 'warn'); return; }
              if (!password.value) { toast('Password required', 'Set an initial password.', 'warn'); return; }
              await api.post('/api/admin/users', { ...payload, username: username.value.trim(), password: password.value });
            }
            close(); toastOk(user ? 'User updated' : 'User created'); showUsers();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* ------------------------------- Readers ------------------------------ */
  async function showReaders() {
    const { rows } = await api.get('/api/admin/readers');
    mount(body, 
      card('How readers connect',
        el('div', {},
          el('p', {}, 'Fixed readers (portals, tunnels, tabletop encoders) post the tags they see to the gateway. They need no business logic of their own - the server works out what each tag means.'),
          el('pre', { class: 'mono', style: { background: 'var(--surface-2)', padding: '13px', borderRadius: '7px', overflowX: 'auto' } },
`POST /api/gateway/reads
X-Reader-Key: <the key issued below>
Content-Type: application/json

{ "epcs": ["E28011...", "E28011..."] }`),
          el('p', { class: 'hint' }, 'Handheld readers in keyboard-wedge mode need no key at all - the operator signs in and the tags type straight into the scan box on each screen.')),
        { subtitle: 'Integration' }),

      card('Registered readers',
        table([
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Reader' },
          { key: 'section', label: 'Section', render: (r) => chip(stageName(r.section), 'brand') },
          { key: 'mode', label: 'Type', render: (r) => chip(r.mode) },
          { key: 'host', label: 'Address', mono: true },
          { key: 'has_key', label: 'Key issued', render: (r) => chip(r.has_key ? 'YES' : 'NO', r.has_key ? 'ok' : '') },
          { key: 'last_seen_at', label: 'Last seen', render: (r) => r.last_seen_at ? dateTime(r.last_seen_at) : el('span', { class: 'hint' }, 'never') },
          { key: 'active', label: 'Status', render: (r) => chip(r.active ? 'ACTIVE' : 'DISABLED', r.active ? 'ok' : 'danger') },
          { key: 'act', label: '', render: (r) => el('button', { class: 'btn btn-sm', onClick: async (e) => {
            e.stopPropagation();
            try {
              const out = await api.post(`/api/admin/readers/${r.id}/key`, {});
              modal({
                title: `Key for ${r.code}`,
                subtitle: out.note,
                body: el('div', {},
                  el('p', {}, 'Configure the reader to send this header with every read:'),
                  el('pre', { class: 'mono', style: { background: 'var(--surface-2)', padding: '13px', borderRadius: '7px', wordBreak: 'break-all', whiteSpace: 'pre-wrap' } },
                    `X-Reader-Key: ${out.api_key}`)),
                actions: [{ label: 'Copy key', onClick: () => { navigator.clipboard?.writeText(out.api_key); toast('Copied'); } },
                          { label: 'Done', class: 'btn-primary', onClick: (c) => c() }],
              });
              showReaders();
            } catch (err) { toastErr(err); }
          } }, r.has_key ? 'Reissue key' : 'Issue key') },
        ], rows, { onRow: (r) => readerDialog(r), empty: 'No readers registered' }),
        { tight: true,
          actions: el('button', { class: 'btn btn-sm btn-primary', onClick: () => readerDialog(null) }, '+ New reader') }));
  }

  function readerDialog(reader) {
    const code = el('input', { value: reader?.code || '' });
    const name = el('input', { value: reader?.name || '' });
    const sectionSel = select(state.meta.stages.map((s) => ({ value: s.code, label: s.name })),
      { value: reader?.section || 'STITCHING' });
    const modeSel = select(['HANDHELD', 'PORTAL', 'TUNNEL', 'TABLETOP', 'ENCODER'].map((m) => ({ value: m, label: m })),
      { value: reader?.mode || 'HANDHELD' });
    const host = el('input', { value: reader?.host || '', placeholder: 'IP address or hostname' });
    const activeSel = select([{ value: '1', label: 'Active' }, { value: '0', label: 'Disabled' }],
      { value: reader ? String(reader.active ? 1 : 0) : '1' });

    modal({
      title: reader ? `Edit ${reader.code}` : 'Register a reader',
      body: el('div', { class: 'form-grid' },
        field('Code', code), field('Name', name), field('Section', sectionSel),
        field('Type', modeSel), field('Address', host), field('Status', activeSel)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: reader ? 'Save' : 'Register', class: 'btn-primary', onClick: async (close) => {
          const payload = { code: code.value.trim(), name: name.value.trim(), section: sectionSel.value,
            mode: modeSel.value, host: host.value.trim() || null, active: Number(activeSel.value) };
          if (!payload.code || !payload.name) { toast('Code and name are required', '', 'warn'); return; }
          try {
            if (reader) await api.put(`/api/masters/readers/${reader.id}`, payload);
            else await api.post('/api/masters/readers', payload);
            close(); toastOk('Reader saved'); showReaders();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* -------------------------------- Roles ------------------------------- */
  function showRoles() {
    const CAP_LABELS = {
      'fabric.receive': 'Receive fabric into the store',
      'fabric.issue': 'Issue rolls to cutting',
      'cutting.manage': 'Create cut orders and bundles',
      'stitching.commission': 'Count bundles in and attach RFID tags',
      'sort.run': 'Run sorting sessions',
      'movement.dispatch': 'Dispatch a batch to another section',
      'movement.receive': 'Receive and tally an incoming batch',
      'movement.close_variance': 'Close a count variance or cancel a dispatch',
      'qc.inspect': 'Inspect garments and record defects',
      'qc.override': 'Override a QC decision',
      'rework.perform': 'Carry out retrofit corrections',
      'dispatch.tagswap': 'Swap tracking tags for customer tags',
      'dispatch.ship': 'Despatch a shipment',
      'masters.manage': 'Maintain master data',
      'orders.manage': 'Create and edit customer orders',
      'reports.view': 'Run reports',
      'reports.design': 'Design and save reports',
      'kpi.view': 'See KPI dashboards',
      'admin.users': 'Manage user accounts',
      'admin.readers': 'Manage RFID readers',
      'admin.audit': 'View the audit trail',
      'article.adjust': 'Correct a garment record or scrap it',
    };

    mount(body, card('What each role can do',
      table([
        { key: 'cap', label: 'Permission', render: (r) => el('div', {},
          el('strong', {}, CAP_LABELS[r.cap] || r.cap), el('div', { class: 'hint mono' }, r.cap)) },
        ...state.meta.roles.map((role) => ({
          key: role.key, label: role.key, num: true,
          render: (r) => r.roles.includes(role.key) ? chip('yes', 'ok') : el('span', { class: 'hint' }, '-'),
        })),
      ], state.meta.caps.map((cap) => ({
        cap,
        roles: state.meta.roles.filter((role) => role.caps.includes(cap)).map((r) => r.key),
      })), { maxHeight: '620px' }),
      { tight: true, subtitle: 'Published by the server, so this matrix always matches what is actually enforced' }));
  }

  await show('users');
  return root;
}
