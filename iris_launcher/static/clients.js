const $ = selector => document.querySelector(selector);
const dialog = $('#client-editor');
let state = null;
let plan = null;
let busy = false;
const selected = () => [...dialog.querySelectorAll('[data-client]:checked')].map(node => node.dataset.client);
function controls() {
  $('#client-close').disabled = busy;
  $('#client-reload').disabled = busy;
  $('#client-core').disabled = busy;
  dialog.querySelectorAll('[data-client]').forEach(node => { node.disabled = busy || node.dataset.editable !== 'true'; });
  $('#client-preview').disabled = busy || !state || !selected().length || !$('#client-core').value.trim();
  $('#client-apply').disabled = busy || !plan || !$('#client-confirm').checked;
}
function invalidate() {
  plan = null;
  $('#client-plan').hidden = true;
  $('#client-confirm').checked = false;
  controls();
}
async function api(path, body) {
  const response = await fetch(path, body ? {method: 'POST', headers: {'Content-Type': 'application/json',
    'X-IRIS-CSRF': $('meta[name="iris-csrf"]').content}, body: JSON.stringify(body)} : {});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Local client request failed.');
  return result;
}
function render(data) {
  state = data;
  $('#client-scope').textContent = `Editing local files in ${data.scope}. No client selected by default.`;
  $('#client-list').replaceChildren(...data.clients.map(client => {
    const row = document.createElement('section'); row.className = 'client-row';
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.dataset.client = client.id; checkbox.dataset.editable = String(client.editable);
    checkbox.addEventListener('change', invalidate);
    label.append(checkbox, document.createTextNode(client.component));
    const address = document.createElement('code'); address.textContent = client.url || '(unset or unavailable)';
    const note = document.createElement('p'); note.className = 'device-note';
    note.textContent = client.editable ? client.restart : 'Missing or unsafe local .env. Configure this client manually first.';
    row.append(label, address, note); return row;
  }));
  invalidate();
}
async function load() {
  busy = true; controls(); $('#client-status').textContent = 'Reading local client addresses…';
  try { render(await api('/api/local-clients')); $('#client-status').textContent = 'No files changed.'; }
  catch (error) { state = null; $('#client-list').replaceChildren(); invalidate(); $('#client-status').textContent = error.message; }
  finally { busy = false; controls(); }
}
$('#edit-local-clients').addEventListener('click', () => { dialog.showModal(); void load(); });
const discard = () => !selected().length || window.confirm('Discard the local client selection and preview?');
$('#client-close').addEventListener('click', () => { if (!busy && discard()) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
$('#client-reload').addEventListener('click', () => { if (discard()) void load(); });
$('#client-core').addEventListener('input', invalidate);
$('#client-confirm').addEventListener('change', controls);
$('#client-preview').addEventListener('click', async () => {
  busy = true; controls(); $('#client-status').textContent = 'Checking selected local configuration…';
  try {
    plan = await api('/api/local-clients/preview', {revision: state.revision, clients: selected(), core_url: $('#client-core').value.trim()});
    $('#client-diff').textContent = plan.changes.map(row => `${row.component}\n${row.before}\n→ ${row.after}\n${row.restart}`).join('\n\n') + '\n\n' + plan.warnings.join('\n');
    $('#client-confirm').checked = false; $('#client-plan').hidden = false;
    $('#client-status').textContent = 'Preview only. No files changed.';
  } catch (error) { invalidate(); $('#client-status').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('#client-apply').addEventListener('click', async () => {
  if (!plan || busy || !$('#client-confirm').checked) return;
  busy = true; controls(); $('#client-status').textContent = 'Backing up and saving selected local clients…';
  try {
    const result = await api('/api/local-clients/apply', {revision: plan.revision, clients: plan.clients, core_url: plan.core_url, confirm: true});
    render(result.snapshot);
    $('#client-status').textContent = `Saved. Backup: ${result.backup}. Restart/rebuild selected clients; no processes were restarted.`;
  } catch (error) { invalidate(); $('#client-status').textContent = error.message; }
  finally { busy = false; controls(); }
});
