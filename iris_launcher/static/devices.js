const $ = selector => document.querySelector(selector);
const dialog = $('#device-editor');
let state = null;
let plan = null;
let busy = false;
const inputs = new Map();
const changes = () => [...inputs].filter(([id, input]) => input.value.trim() !== state.routes.find(r => r.id === id).url)
  .map(([id, input]) => ({id, url: input.value.trim()}));
const hasChanges = () => state && changes().length > 0;
function invalidate() {
  plan = null;
  $('#device-plan').hidden = true;
  $('#device-confirm').checked = false;
  controls();
}
function controls() {
  $('#device-preview').disabled = busy || !hasChanges();
  $('#device-apply').disabled = busy || !plan || !$('#device-confirm').checked;
  $('#device-reload').disabled = busy;
  $('#device-close').disabled = busy;
  $('#jump-pairing').disabled = busy;
  for (const input of inputs.values()) input.disabled = busy || !input.dataset.configured;
  document.querySelectorAll('#device-routes select').forEach(select => { select.disabled = busy; });
}
async function api(path, body) {
  const response = await fetch(path, body ? {method:'POST', headers:{'Content-Type':'application/json',
    'X-IRIS-CSRF':document.querySelector('meta[name="iris-csrf"]').content}, body:JSON.stringify(body)} : {});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Routing request failed.');
  return result;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(data) {
  state = data; inputs.clear(); invalidate();
  $('#device-target').textContent = `Managing Core: ${data.core_url || 'configured Core'} · Active routes, not automatic device discovery.`;
  const routeCount = new Map();
  for (const route of data.routes) {
    const match = data.services.find(service => service.id === route.service_id)?.device;
    if (match) routeCount.set(match, (routeCount.get(match) || 0) + 1);
  }
  $('#device-hosts').replaceChildren(...data.devices.map(device => {
    const card = element('article', '', 'device-host');
    const heading = element('div', '', 'device-host-heading');
    heading.append(element('b', device.label), element('span', device.host ? 'address configured' : 'no route', device.host ? 'device-online' : 'device-offline'));
    card.append(heading, element('code', device.host || 'No network host'));
    card.append(element('small', `alias · ${device.alias || device.id || 'unassigned'}`, 'device-alias'));
    card.append(element('small', `${routeCount.get(device.id) || 0} active route${routeCount.get(device.id) === 1 ? '' : 's'}`, 'device-route-count'));
    return card;
  }));
  const list = $('#device-routes'); list.replaceChildren();
  for (const route of data.routes) {
    const service = data.services.find(s => s.id === route.service_id);
    const row = element('section', '', 'device-route');
    const label = element('label', service?.label || route.id);
    const input = element('input'); input.type = 'url'; input.value = route.url;
    input.id = 'route-'+route.id.replace(/[^a-z0-9_-]/gi,'-'); label.htmlFor = input.id;
    input.dataset.configured = route.url ? 'true' : ''; input.maxLength = 512;
    input.addEventListener('input', invalidate); inputs.set(route.id, input);
    const select = element('select'); select.setAttribute('aria-label', `Use device address for ${route.id}`);
    const hint = element('option', 'Use a documented device…'); hint.value = ''; select.append(hint);
    for (const device of data.devices.filter(d => d.host)) {
      const option = element('option', device.label); option.value = device.host; select.append(option);
    }
    select.addEventListener('change', () => {
      if (!select.value || !input.value) return;
      try { const url = new URL(input.value); url.hostname = select.value; input.value = url.href.replace(/\/$/,''); invalidate(); }
      catch { $('#device-status').textContent = 'Enter a valid URL first.'; }
      select.value = '';
    });
    row.append(label, element('small', `${route.id}${route.priority !== null ? ` · priority ${route.priority} · profiles ${route.profiles.join(', ') || 'all'}` : ''}`), input, select);
    list.append(row);
  }
  $('#device-inventory').replaceChildren(...data.services.map(service => {
    const owner = data.devices.find(d => d.id === service.device);
    return element('p', `${service.label} — ${owner?.label || 'Unassigned'}${service.port ? ` :${service.port}` : ''}${data.routes.some(r => r.service_id === service.id) ? '' : ' · managed outside this routing editor'}`);
  }));
  controls();
}
async function load() {
  busy = true; controls(); $('#device-status').textContent = 'Reading Core configuration…';
  try { render(await api('/api/devices')); $('#device-status').textContent = 'No configuration changed.'; }
  catch(error) { $('#device-status').textContent = error.message; }
  finally { busy = false; controls(); }
}
$('#edit-devices').addEventListener('click', () => { dialog.showModal(); void load(); });
$('#device-refresh-all').addEventListener('click', () => { if (!busy) void load(); });
const discard = () => !hasChanges() || window.confirm('Discard unsaved routing changes?');
$('#device-close').addEventListener('click', () => { if (!busy && discard()) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
$('#device-reload').addEventListener('click', () => { if (discard()) void load(); });
$('#device-confirm').addEventListener('change', controls);
$('#device-preview').addEventListener('click', async () => {
  busy = true; controls(); $('#device-status').textContent = 'Validating addresses and port collisions…';
  try {
    plan = await api('/api/devices/preview', {revision:state.revision, changes:changes()});
    $('#device-diff').textContent = plan.changes.map(c => `${c.id}\n  ${c.before}\n→ ${c.after}`).join('\n\n') + '\n\n' + plan.warnings.join('\n');
    $('#device-plan').hidden = false; $('#device-confirm').checked = false;
    $('#device-status').textContent = 'Validated. Nothing has been saved yet.';
  } catch(error) { invalidate(); $('#device-status').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('#device-apply').addEventListener('click', async () => {
  if (!plan || busy || !$('#device-confirm').checked) return;
  busy = true; controls(); $('#device-status').textContent = 'Applying routes…';
  try {
    const result = await api('/api/devices/apply', {revision:plan.revision, changes:plan.changes.map(c => ({id:c.id,url:c.after})), confirm:true});
    render({...result.snapshot,core_url:result.core_url});
    $('#device-status').textContent = 'Core routes saved. Previous configuration backed up. Other clients and remote services were not changed.';
  } catch(error) { invalidate(); $('#device-status').textContent = error.message; }
  finally { busy = false; controls(); }
});

const buildStates = {
  running: 'Process running', starting_or_unhealthy: 'Process present · port unverified',
  reachable_unverified: 'Port reachable · build unknown', stopped: 'No local process observed', not_installed: 'Source not installed'
};
$('#device-build-refresh').addEventListener('click', async () => {
  const button = $('#device-build-refresh'); button.disabled = true;
  $('#device-build-status').textContent = 'Reading device versions…';
  try {
    const data = await api('/api/device-updates');
    $('#device-build-results').replaceChildren(...data.devices.map(device => {
      const card = element('section', '', 'device-build-card');
      card.append(element('h4', device.label));
      if (!device.ok) { card.append(element('p', device.error)); return card; }
      const build = device.installed;
      card.append(element('p', `Source: ${build.branch || 'branch unknown'} · ${build.revision || 'revision unknown'}${build.modified ? ' · local changes' : ''}`, 'device-note'));
      const rows = element('div', '', 'device-build-rows');
      for (const service of device.services.filter(s => s.state !== 'not_installed')) {
        const row = element('div', '', 'device-build-row');
        row.append(element('b', service.label));
        row.append(element('span', buildStates[service.state] || 'Unverified'));
        row.append(element('span', service.restart_required === true ? 'Restart required' : service.restart_required === false ? 'Matches installed source' : 'Running version unverified', service.restart_required === true ? 'build-restart' : ''));
        const hashes = service.running_fingerprint ? `Running ${service.running_fingerprint} → installed ${service.installed_fingerprint}` : `Installed ${service.installed_fingerprint || 'unknown'}`;
        row.append(element('small', hashes)); rows.append(row);
      }
      card.append(rows); return card;
    }));
    $('#device-build-status').textContent = 'Checked just now. No services were changed.';
  } catch (error) { $('#device-build-status').textContent = error.message; }
  finally { button.disabled = false; }
});
