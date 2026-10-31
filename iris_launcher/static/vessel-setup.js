const $ = selector => document.querySelector(selector);
const dialog = $('#vessel-setup-editor');
const status = $('#vessel-setup-status');
let snapshot;
let busy = false;
let pendingAction;
let timer;
let joinSignature = '';

async function joinApi(suffix = '', body) {
  const response = await fetch('/api/security/vessels/requests' + suffix, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-IRIS-CSRF': $('meta[name="iris-csrf"]').content},
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || 'Core connection unavailable');
  return data;
}

async function refreshJoins() {
  const data = await joinApi();
  const signature = JSON.stringify(data.requests);
  if (signature === joinSignature) return;
  joinSignature = signature;
  const list = $('#vessel-join-requests'); list.replaceChildren();
  const visible = data.requests.filter(row => ['pending', 'approved', 'active'].includes(row.status));
  if (!visible.length) list.append(element('p', 'No connection requests. Run setup on the new device to begin.'));
  for (const row of visible) {
    const card = element('article', '', 'pairing-row');
    card.append(element('strong', `${row.name} · ${row.service}`), element('p', `${row.host}:${row.port} · ${row.status}`));
    if (row.status === 'pending') card.append(element('p', `Device code: ${row.code.match(/.{4}/g).join('-')}`));
    if (row.status === 'approved') card.append(element('p', 'Approved. Waiting for setup to start the vessel and verify the connection.'));
    const actions = element('div', '', 'pairing-actions');
    for (const action of row.status === 'pending' ? ['approve', 'deny'] : ['revoke']) {
      const button = element('button', action === 'approve' ? 'Code matches · approve' : action === 'deny' ? 'Deny' : 'Disconnect from Core', 'ghost-button');
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (action === 'approve' && !window.confirm(`Does ${row.code.match(/.{4}/g).join('-')} match the code on ${row.name}? This will replace Core's ${row.service} connection once the vessel is ready.`)) return;
        if (action === 'revoke' && !window.confirm(`Disconnect ${row.name} from Core? This does not stop the remote service or revoke credentials used by other callers.`)) return;
        button.disabled = true;
        try {
          await joinApi(`/${row.id}/${action}`, action === 'approve' ? {code: row.code} : {});
          $('#vessel-join-status').textContent = action === 'approve' ? 'Approved. Continue setup on the new device.' : 'Connection updated.';
          await refreshJoins();
        } catch (error) { $('#vessel-join-status').textContent = error.message; }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    card.append(actions); list.append(card);
  }
}

function element(tag, text = '', cls = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = cls;
  return node;
}
async function api(action = '', body) {
  const response = await fetch(`/api/vessel-setup${action ? `/${action}` : ''}`, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-IRIS-CSRF': $('meta[name="iris-csrf"]').content},
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Device operation failed');
  return data;
}
async function work(action) {
  if (busy) return;
  busy = true;
  status.textContent = 'Working…';
  const buttons = [...dialog.querySelectorAll('button')].map(node => [node, node.disabled]);
  buttons.forEach(([node]) => { node.disabled = true; });
  try { await action(); await refresh(); status.textContent = 'Updated.'; }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; buttons.forEach(([node, disabled]) => { node.disabled = disabled; }); }
}
function hostSelect(component, value, required) {
  const label = element('label', component === 'browser' ? 'Launcher / browser caller' : component);
  const select = element('select');
  const empty = element('option', required ? 'Choose device' : 'Not used');
  empty.value = ''; select.append(empty);
  for (const host of snapshot.hosts.filter(host => host.components.includes(component))) {
    const option = element('option', host.label); option.value = host.id; select.append(option);
  }
  select.value = value || ''; select.required = required; label.append(select);
  return {label, select};
}
function renderServices() {
  const list = $('#vessel-service-list'); list.replaceChildren();
  for (const [service, definition] of Object.entries(snapshot.catalog)) {
    const binding = snapshot.bindings[service];
    const row = element('article', '', 'pairing-row');
    const heading = element('h4', service.replaceAll('_', ' '));
    const badge = element('span', binding?.status || 'Not configured', 'vessel-state'); heading.append(badge); row.append(heading);
    const fields = element('div', '', 'vessel-form');
    const owner = hostSelect(service, binding?.owner, true); fields.append(owner.label);
    const callers = {};
    for (const caller of definition.consumers) {
      callers[caller] = hostSelect(caller, binding?.consumers?.[caller], false); fields.append(callers[caller].label);
    }
    row.append(fields);
    const actions = element('div', '', 'pairing-actions');
    const save = element('button', 'Save connection', 'ghost-button'); save.type = 'button';
    save.addEventListener('click', () => work(() => api('bind', {service, owner: owner.select.value,
      consumers: Object.fromEntries(Object.entries(callers).map(([name, field]) => [name, field.select.value]))})));
    actions.append(save);
    for (const action of ['rotate', 'revoke']) {
      const button = element('button', action === 'rotate' ? 'Rotate / enable' : 'Revoke access', 'ghost-button');
      button.type = 'button'; button.disabled = !binding;
      button.addEventListener('click', () => {
        if (!snapshot.bindings[service]) return;
        pendingAction = {service, action};
        const current = snapshot.bindings[service];
        const hostNames = [...new Set([current.owner, ...Object.values(current.consumers)].filter(Boolean))]
          .map(id => snapshot.hosts.find(host => host.id === id)?.label || 'Unknown device').join(', ');
        $('#vessel-review-description').textContent = action === 'revoke'
          ? `Disconnect ${service} on ${hostNames}. A fresh vessel token and different caller tokens will be installed. Affected services restart. Completion requires the old token to be rejected. Owner-token access is unchanged.`
          : `Replace the ${service} token on ${hostNames} and restart affected services. Requests may pause briefly. Existing settings are preserved. Completion requires successful authentication checks.`;
        $('#vessel-confirm-action').textContent = action === 'revoke' ? 'Revoke service access' : 'Rotate credentials';
        $('#vessel-action-review').hidden = false;
        $('#vessel-action-review').scrollIntoView({block: 'center', behavior: 'smooth'});
      }); actions.append(button);
    }
    row.append(actions); list.append(row);
  }
}
function renderProgress() {
  const list = $('#vessel-operation-list'); list.replaceChildren();
  if (!snapshot.operations.length) list.append(element('p', 'No unfinished operations.'));
  for (const op of snapshot.operations) {
    const row = element('article', '', 'pairing-row');
    row.append(element('strong', `${op.service} · ${op.action}`), element('p', `${op.status} · ${op.step}`));
    if (op.error) row.append(element('p', op.error));
    if (!snapshot.running) {
      const retry = element('button', 'Retry operation', 'ghost-button'); retry.type = 'button';
      retry.addEventListener('click', () => work(() => api('operate', {retry: op.id}))); row.append(retry);
    }
    list.append(row);
  }
  const history = $('#vessel-history'); history.replaceChildren();
  for (const event of snapshot.history.slice().reverse()) {
    history.append(element('p', `${new Date(event.at * 1000).toLocaleString()} · ${event.service || event.device} · ${event.action}`));
  }
}
async function refresh(progressOnly = false) {
  try { await refreshJoins(); } catch (error) { $('#vessel-join-status').textContent = error.message; }
  snapshot = await api();
  if (!progressOnly) {
    $('#vessel-managed-hosts').replaceChildren(...snapshot.hosts.map(host => element('span', `${host.label} · ${host.transport}`, 'vessel-state')));
    renderServices();
  }
  renderProgress();
}
$('#jump-vessel-setup').addEventListener('click', async () => {
  $('#device-editor').close(); dialog.showModal();
  try { await refresh(); } catch (error) { status.textContent = error.message; }
  timer = setInterval(async () => { if (!busy && dialog.open) {
    try { const wasRunning = snapshot?.running; await refresh(true); if (wasRunning && !snapshot.running) renderServices(); }
    catch (error) { status.textContent = error.message; }
  } }, 3000);
});
$('#vessel-setup-close').addEventListener('click', () => { dialog.close(); $('#device-editor').showModal(); });
dialog.addEventListener('close', () => { clearInterval(timer); });
$('#vessel-setup-refresh').addEventListener('click', () => work(() => refresh()));
$('#vessel-confirm-action').addEventListener('click', () => work(async () => {
  if (!pendingAction) return;
  await api('operate', pendingAction); pendingAction = null; $('#vessel-action-review').hidden = true;
}));
$('#vessel-cancel-action').addEventListener('click', () => { pendingAction = null; $('#vessel-action-review').hidden = true; });
