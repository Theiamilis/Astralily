// Launcher keeps the Core owner credential server-side. Only the one-time
// invitation appears here, and it is discarded when the Devices dialog closes.
const $ = selector => document.querySelector(selector);
const dialog = $('#pairing-editor');
const routeDialog = $('#device-editor');
const status = $('#pairing-status');
let busy = false;
let returnToDevices = false;

function node(tag, value, className = '') {
  const result = document.createElement(tag);
  result.textContent = value;
  if (className) result.className = className;
  return result;
}

function date(value) {
  return value ? new Date(value * 1000).toLocaleString() : 'Never';
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IRIS-CSRF': $('meta[name="iris-csrf"]').content,
    },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || `Request failed (${response.status})`);
  return payload;
}

function setBusy(value) {
  busy = value;
  $('#pairing-create').disabled = value;
  $('#pairing-refresh').disabled = value;
  $('#pairing-close').disabled = value;
  $('#pairing-panel').querySelectorAll('.pairing-actions button').forEach(button => { button.disabled = value; });
}

function renderRequests(requests) {
  const host = $('#pairing-requests');
  host.replaceChildren();
  const pending = requests.filter(request => request.status === 'pending');
  if (!pending.length) { host.append(node('p', 'No pending pairing requests.')); return; }
  for (const request of pending) {
    const row = node('article', '', 'pairing-row pairing-request');
    row.append(node('strong', `${request.name} · ${request.platform}`));
    row.append(node('small', `Role: ${request.role} · Scopes: ${request.scopes.join(', ') || 'none'}`));
    row.append(node('small', `Key: ${request.key_fingerprint.slice(0, 16)}… · Expires ${date(request.expires_at)}`));
    const actions = node('div', '', 'pairing-actions');
    const codeLabel = node('label', 'Code shown on device');
    const code = document.createElement('input');
    code.type = 'text'; code.inputMode = 'numeric'; code.maxLength = 6;
    code.pattern = '[0-9]{6}'; code.autocomplete = 'one-time-code';
    code.setAttribute('aria-label', `Six-digit verification code for ${request.name}`);
    codeLabel.append(code);
    const approve = node('button', 'Approve', 'primary-button'); approve.type = 'button';
    approve.addEventListener('click', async () => {
      if (!/^[0-9]{6}$/.test(code.value)) { status.textContent = 'Enter the six-digit code shown on the new device.'; return; }
      setBusy(true); status.textContent = `Checking ${request.name}…`;
      try {
        await api(`/api/security/pairing/requests/${request.id}/approve`, {verification_code: code.value});
        status.textContent = `${request.name} enrolled. Device-bound sign-in is not enabled yet.`;
        await load();
      } catch (error) { status.textContent = error.message; }
      finally { setBusy(false); }
    });
    const deny = node('button', 'Deny', 'ghost-button'); deny.type = 'button';
    deny.addEventListener('click', async () => {
      setBusy(true); status.textContent = `Denying ${request.name}…`;
      try {
        await api(`/api/security/pairing/requests/${request.id}/deny`, {});
        status.textContent = `${request.name} denied.`;
        await load();
      } catch (error) { status.textContent = error.message; }
      finally { setBusy(false); }
    });
    actions.append(codeLabel, approve, deny); row.append(actions); host.append(row);
  }
}

function renderDevices(devices) {
  const host = $('#paired-devices');
  host.replaceChildren();
  if (!devices.length) { host.append(node('p', 'No device identities enrolled yet.')); return; }
  for (const device of devices) {
    const row = node('article', '', 'pairing-row');
    row.append(node('strong', `${device.name} · ${device.role}${device.revoked_at ? ' · revoked' : ''}`));
    row.append(node('small', `${device.platform} · Scopes: ${device.scopes.join(', ') || 'none'} · Last seen: ${date(device.last_seen_at)}`));
    row.append(node('small', `Key: ${device.key_fingerprint.slice(0, 16)}… · Enrolled ${date(device.created_at)}`));
    if (!device.revoked_at) {
      const actions = node('div', '', 'pairing-actions');
      const revoke = node('button', 'Revoke access', 'ghost-button'); revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke ${device.name}? Device sessions will stop. Any previously copied shared token must also be rotated.`)) return;
        setBusy(true); status.textContent = `Revoking ${device.name}…`;
        try {
          await api(`/api/security/devices/${device.id}/revoke`, {});
          status.textContent = `${device.name} device sessions revoked. Rotate any legacy token previously held by that device.`;
          await load();
        } catch (error) { status.textContent = error.message; }
        finally { setBusy(false); }
      });
      actions.append(revoke); row.append(actions);
    }
    host.append(row);
  }
}

function renderHistory(events) {
  const host = $('#pairing-history');
  host.replaceChildren(...events.map(event => node('p', `${date(event.created_at)} · ${event.action} · ${event.device_id.slice(0, 12)}…`)));
  if (!events.length) host.append(node('p', 'No device changes yet.'));
}

async function load() {
  const [devices, requests, history] = await Promise.all([
    api('/api/security/devices'),
    api('/api/security/pairing/requests'),
    api('/api/security/devices/history'),
  ]);
  renderDevices(devices.devices || []);
  renderRequests(requests.requests || []);
  renderHistory(history.events || []);
}

$('#jump-pairing').addEventListener('click', () => {
  $('#device-close').click();
  if (routeDialog.open) return;
  dialog.showModal();
  status.textContent = 'Reading device identities…';
  void load().then(() => { status.textContent = 'Device identities loaded.'; })
    .catch(error => { status.textContent = error.message; });
});
$('#pairing-close').addEventListener('click', () => { if (!busy) dialog.close(); });
dialog.querySelector('.dialog-back').addEventListener('click', () => { returnToDevices = true; }, {capture: true});
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#pairing-refresh').addEventListener('click', async () => {
  setBusy(true);
  try { await load(); status.textContent = 'Device identities refreshed.'; }
  catch (error) { status.textContent = error.message; }
  finally { setBusy(false); }
});
$('#pairing-create').addEventListener('click', async () => {
  const role = $('#pairing-role').value;
  const scopes = $('#pairing-scopes').value.split(',').map(value => value.trim()).filter(Boolean);
  if (role === 'owner' && !window.confirm('Create an Owner invitation with full administrative intent?')) return;
  setBusy(true); status.textContent = 'Creating a one-time invitation…';
  try {
    const result = await api('/api/security/pairing/invitations', {role, scopes});
    $('#pairing-token').value = result.invitation.token;
    $('#pairing-expiry').textContent = `Expires ${date(result.invitation.expires_at)} · single use`;
    $('#pairing-invite').hidden = false;
    status.textContent = 'Invitation created. It does not grant access until owner approval.';
  } catch (error) { status.textContent = error.message; }
  finally { setBusy(false); }
});
$('#pairing-copy').addEventListener('click', async () => {
  const input = $('#pairing-token');
  try { await navigator.clipboard.writeText(input.value); status.textContent = 'Invitation copied.'; }
  catch { input.select(); status.textContent = 'Copy the selected invitation.'; }
});
dialog.addEventListener('close', () => {
  $('#pairing-token').value = '';
  $('#pairing-invite').hidden = true;
  if (returnToDevices) {
    returnToDevices = false;
    $('#edit-devices').click();
  }
});
