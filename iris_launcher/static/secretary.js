const dialog = document.querySelector('#secretary-editor');
import { installInboxReview } from './inbox-review.js';
import { installGoogleContacts } from './google-contacts.js';
import { installSecretarySimulator } from './secretary-simulator.js';
installInboxReview();
const form = document.querySelector('#secretary-form');
const fields = document.querySelector('#secretary-fields');
const status = document.querySelector('#secretary-status');
const runtimeStatus = document.querySelector('#secretary-runtime-status');
const rows = document.querySelector('#secretary-contacts');
let snapshot = null;
let baseline = '';
let busy = false;
let runtimePoller = null;
const numeric = ['first_reply_seconds', 'followup_seconds', 'handoff_minutes', 'conversation_minutes', 'max_replies', 'summary_delay_seconds', 'per_contact_send_limit_per_hour', 'global_send_limit_per_hour'];
const field = name => form.elements.namedItem(name);
function value() {
  return { mode: field('mode').value, default_action: field('default_action').value,
    ...(snapshot && Object.hasOwn(snapshot.settings, 'triage_mode') ? {triage_mode: field('triage_mode').value} : {}),
    system_prompt: field('system_prompt').value,
    ...(snapshot && Object.hasOwn(snapshot.settings, 'notifications') ? {notifications: {
      channels: ['wa', 'mobile', 'hud'].filter(channel => field('notify_' + channel).checked),
      mode: field('notify_mode').value, digest_minutes: Number(field('notify_digest_minutes').value),
      quiet_enabled: field('notify_quiet_enabled').checked, quiet_start: field('notify_quiet_start').value,
      quiet_end: field('notify_quiet_end').value, timezone: field('notify_timezone').value,
      urgent_immediate: field('notify_urgent_immediate').checked,
    }} : {}),
    ...Object.fromEntries(numeric.map(name => [name, Number(field(name).value)])),
    contacts: [...rows.children].map(row => ({ number: row.querySelector('[data-number]').value,
      label: row.querySelector('[data-label]').value, action: row.querySelector('select').value })) };
}
const dirty = () => snapshot && JSON.stringify(value()) !== baseline;
const discard = () => !dirty() || window.confirm('Discard unsaved secretary changes?');
installSecretarySimulator(() => snapshot ? value() : null);
function controls() {
  fields.disabled = busy || !snapshot;
  field('triage_mode').disabled = busy || !snapshot || !Object.hasOwn(snapshot.settings, 'triage_mode');
  document.querySelector('#secretary-save').disabled = busy || !dirty();
  document.querySelector('#secretary-reload').disabled = busy;
  document.querySelector('#secretary-close').disabled = busy;
  document.querySelector('#secretary-state').textContent = { off: 'Off', auto: 'Auto · when busy', active: 'On · manual' }[field('mode').value] || 'Off';
}
function addRow(rule = { number: '', label: '', action: 'summary_only' }) {
  const row = document.createElement('div'); row.className = 'secretary-contact';
  const numberLabel = document.createElement('label'); numberLabel.textContent = 'Number';
  const number = document.createElement('input'); number.type = 'tel'; number.required = true;
  number.maxLength = 30; number.dataset.number = ''; number.value = rule.number; number.placeholder = '08… / +62…';
  numberLabel.append(number);
  const label = document.createElement('label'); label.textContent = 'Name / note';
  const input = document.createElement('input'); input.maxLength = 80; input.dataset.label = ''; input.value = rule.label;
  label.append(input);
  const actionLabel = document.createElement('label'); actionLabel.textContent = 'Action';
  const select = document.createElement('select');
  for (const [key, text] of [['ignore', 'Ignore completely'], ['summary_only', 'Summary only'], ['secretary', 'Let Lily reply']]) {
    const option = document.createElement('option'); option.value = key; option.textContent = text; select.append(option);
  }
  select.value = rule.action; actionLabel.append(select);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost-button';
  remove.textContent = 'Remove'; remove.addEventListener('click', () => { row.remove(); controls(); });
  row.append(numberLabel, label, actionLabel, remove); rows.append(row);
}
function render(data) {
  snapshot = data;
  const notifications = data.settings.notifications;
  document.querySelector('#inbox-notification-settings').hidden = !notifications;
  if (notifications) {
    for (const channel of ['wa', 'mobile', 'hud']) field('notify_' + channel).checked = notifications.channels.includes(channel);
    for (const key of ['mode', 'digest_minutes', 'quiet_start', 'quiet_end', 'timezone']) field('notify_' + key).value = notifications[key];
    for (const key of ['quiet_enabled', 'urgent_immediate']) field('notify_' + key).checked = notifications[key];
  }
  for (const name of ['mode', 'default_action', ...numeric]) field(name).value = data.settings[name];
  field('triage_mode').value = data.settings.triage_mode || 'shadow';
  document.querySelector('#secretary-triage-note').textContent = Object.hasOwn(data.settings, 'triage_mode')
    ? 'Delivery and uncertain messages never get automatic replies. Promotions remain in the inbox. Sorting starts in preview mode.'
    : 'Update Core to use sorting controls. Current Secretary settings still work.';
  field('system_prompt').value = data.settings.system_prompt || data.default_prompt;
  rows.replaceChildren(); data.settings.contacts.forEach(addRow);
  baseline = JSON.stringify(value());
  document.querySelector('#secretary-target').textContent = `Configured Core: ${data.core_url || 'connected'} · Personal WhatsApp`;
}
async function request(payload) {
  const response = await fetch('/api/wa/secretary/settings', payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IRIS-CSRF': document.querySelector('meta[name="iris-csrf"]').content },
    body: JSON.stringify(payload),
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Secretary settings are unavailable.');
  return data;
}
async function load() {
  busy = true; controls(); status.textContent = 'Loading…';
  try { render(await request()); status.textContent = 'Loaded. Save only when you are ready to apply changes.'; }
  catch (error) { snapshot = null; status.textContent = error.message; }
  finally { busy = false; controls(); }
}
async function refreshRuntimeStatus() {
  try {
    const response = await fetch('/api/wa/secretary/status');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'WhatsApp status is unavailable.');
    const runtime = data.runtime || {};
    let message;
    if (!data.configuration_fresh) {
      message = 'Secretary settings are stale on WhatsApp. Replies are paused until its settings refresh.';
    } else if (!data.wa_client_ready) {
      const stateLabel = data.wa_client_state || 'unknown';
      message = `WhatsApp is not ready (${stateLabel}). Secretary cannot send replies.`;
    } else {
      const mode = data.mode === 'active' ? 'On' : data.mode === 'auto' ? 'Auto' : 'Off';
      message = `WhatsApp connected · Secretary ${mode} · ${runtime.send_attempts_last_hour || 0}/${runtime.global_send_limit_per_hour || 30} replies this hour`;
      if (runtime.uncertain_sends_last_hour) message += ` · ${runtime.uncertain_sends_last_hour} uncertain send${runtime.uncertain_sends_last_hour === 1 ? '' : 's'} held; not retried`;
      if (runtime.last_rate_limited_scope) message += ` · Recent ${runtime.last_rate_limited_scope} limit reached`;
    }
    runtimeStatus.textContent = message;
  } catch (error) {
    runtimeStatus.textContent = `${error.message} Check that the Core and personal WA vessel are reachable.`;
  }
}
function startRuntimePolling() {
  stopRuntimePolling();
  void refreshRuntimeStatus();
  runtimePoller = setInterval(() => void refreshRuntimeStatus(), 10000);
}
function stopRuntimePolling() {
  if (runtimePoller) clearInterval(runtimePoller);
  runtimePoller = null;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !snapshot || !form.reportValidity()) return;
  if (value().notifications?.channels.length === 0) { status.textContent = 'Choose at least one notification destination.'; return; }
  busy = true; const payload = { revision: snapshot.revision, settings: value() }; controls();
  status.textContent = 'Saving…';
  try { render(await request(payload)); status.textContent = 'Saved to Core. Connected WA reads changes within 5 seconds; an offline bridge remains unable to reply.'; }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
});
form.addEventListener('input', controls); form.addEventListener('change', controls);
document.querySelector('#edit-secretary').addEventListener('click', () => { dialog.showModal(); void load(); startRuntimePolling(); });
dialog.addEventListener('close', stopRuntimePolling);
document.querySelector('#secretary-close').addEventListener('click', () => { if (!busy && discard()) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
document.querySelector('#secretary-reload').addEventListener('click', () => { if (discard()) void load(); });
document.querySelector('#secretary-stop').addEventListener('click', async () => {
  if (busy) return;
  busy = true; controls(); status.textContent = 'Stopping Secretary…';
  try {
    const latest = await request();
    render(await request({revision: latest.revision, settings: {...latest.settings, mode: 'off'}}));
    status.textContent = 'Secretary is off. WA reads this setting within 5 seconds.';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
});
document.querySelector('#secretary-default-prompt').addEventListener('click', () => { field('system_prompt').value = snapshot.default_prompt; controls(); });
document.querySelector('#secretary-add-contact').addEventListener('click', () => { if (rows.children.length < 300) { addRow(); rows.lastElementChild.querySelector('input').focus(); controls(); } });
installGoogleContacts({
  addContacts(contacts, action) {
    if (busy || !snapshot) throw new Error('Load secretary settings before adding contacts.');
    const normalize = input => {
      let n = input.replace(/\D/g, '');
      if (n.startsWith('00')) n = n.slice(2);
      else if (n.startsWith('0')) n = '62' + n.slice(1);
      return n;
    };
    const existing = new Set(value().contacts.map(contact => normalize(contact.number)));
    const fresh = contacts.filter(contact => !existing.has(contact.number));
    if (rows.children.length + fresh.length > 300) throw new Error('A maximum of 300 contact rules is supported. Select fewer contacts.');
    for (const contact of fresh) addRow({ ...contact, action });
    controls();
    status.textContent = `${fresh.length} contact rules added. Existing rules kept. Save settings to apply.`;
    return fresh.length;
  },
});
