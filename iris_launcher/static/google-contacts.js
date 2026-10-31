export function installGoogleContacts({ addContacts }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'prompt-editor secretary-editor google-contacts-editor';
  dialog.setAttribute('aria-labelledby', 'google-contacts-title');
  dialog.innerHTML = `
    <header class="prompt-header"><div><p class="eyebrow">ADDRESS BOOK / GOOGLE</p>
      <h2 id="google-contacts-title">People, by name.</h2></div>
      <button type="button" class="ghost-button" data-close>Close</button></header>
    <p class="device-note">Read-only contacts on this PC. Choose who gets a rule; save it in Secretary settings. Connecting does not enable secretary mode.</p>
    <details data-setup><summary>First-time Google setup</summary>
      <ol class="device-note"><li>In Google Cloud, enable People API for your project.</li>
      <li>Configure the OAuth consent screen. If the app is in Testing, add your Google account as a test user.</li>
      <li>Create an OAuth client of type <strong>Desktop app</strong>, then download its JSON file.</li>
      <li>Import that file below, then connect your account in your default browser.</li></ol>
      <label>Desktop OAuth JSON<input data-file type="file" accept=".json,application/json"></label>
      <p class="device-note">Windows encrypts local credentials and cached contacts for your Windows account. Only names and numbers you select go to Core. Testing-mode Google tokens may expire after seven days.</p>
    </details>
    <div class="google-toolbar">
      <button class="primary-button" type="button" data-connect>Connect Google</button>
      <button class="ghost-button" type="button" data-sync>Sync contacts</button>
      <button class="ghost-button" type="button" data-disconnect>Disconnect</button>
    </div>
    <p data-status role="status" aria-live="polite" class="device-note"></p>
    <div class="google-picker" hidden>
      <label>Find a contact<input type="search" data-search placeholder="Name or phone number" autocomplete="off"></label>
      <div class="google-toolbar"><button type="button" class="ghost-button" data-select>Select shown</button>
        <button type="button" class="ghost-button" data-clear>Clear selection</button><span data-count class="device-note"></span></div>
      <div class="google-contact-list" data-list></div>
      <footer class="prompt-footer"><label>Rule for selected contacts<select data-action>
        <option value="summary_only">Summary only — never reply</option>
        <option value="ignore">Ignore completely</option><option value="secretary">Secretary — reply when enabled</option>
      </select></label><button type="button" class="primary-button" data-add>Add selected</button></footer>
    </div>`;
  document.body.append(dialog);
  window.IRISDialogs.prepare(dialog, { parent: 'Secretary' });
  const el = selector => dialog.querySelector(selector);
  let state = {}, busy = false, timer = null;
  const selected = new Set();
  let shown = [];
  async function request(action, body = {}) {
    const response = await fetch('/api/google-contacts' + (action ? '/' + action : ''), action ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IRIS-CSRF': document.querySelector('meta[name="iris-csrf"]').content },
      body: JSON.stringify(body),
    } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Google Contacts is unavailable.');
    return data;
  }
  function renderList() {
    const query = el('[data-search]').value.trim().toLocaleLowerCase();
    const all = (state.contacts || []).filter(c => (c.label + ' ' + c.number).toLocaleLowerCase().includes(query));
    shown = all.slice(0, 100);
    el('[data-list]').replaceChildren();
    for (const contact of shown) {
      const label = document.createElement('label'); label.className = 'google-contact-row';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(contact.number); check.disabled = busy;
      const text = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = contact.label;
      const number = document.createElement('small'); number.textContent = '+' + contact.number;
      text.append(name, number); label.append(check, text);
      check.addEventListener('change', () => { check.checked ? selected.add(contact.number) : selected.delete(contact.number); count(); });
      el('[data-list]').append(label);
    }
    if (!shown.length) {
      const empty = document.createElement('p'); empty.className = 'device-note';
      empty.textContent = state.synced_at ? 'No matching contacts with a usable phone number.' : 'Sync contacts to load your address book.';
      el('[data-list]').append(empty);
    }
    count(all.length);
  }
  function count(total) {
    if (total === undefined) total = (state.contacts || []).filter(c => (c.label + ' ' + c.number).toLocaleLowerCase().includes(el('[data-search]').value.trim().toLocaleLowerCase())).length;
    el('[data-count]').textContent = `${selected.size} selected · showing ${Math.min(total, 100)} of ${total}`;
    el('[data-add]').disabled = busy || !selected.size;
  }
  function render() {
    el('[data-connect]').disabled = busy || !state.configured || state.connected || state.pending;
    el('[data-sync]').disabled = busy || !state.connected;
    el('[data-disconnect]').disabled = busy;
    el('[data-file]').disabled = busy || state.connected || state.pending;
    el('[data-close]').disabled = busy;
    for (const key of ['select', 'clear', 'action', 'search']) el(`[data-${key}]`).disabled = busy;
    el('.google-picker').hidden = !state.connected;
    el('.prompt-footer').hidden = !state.connected;
    renderList();
  }
  function schedule() {
    clearTimeout(timer);
    if (dialog.open && state.pending) timer = setTimeout(() => void run(), 2000);
  }
  async function run(action, body) {
    if (busy) return;
    busy = true; render(); el('[data-status]').textContent = action === 'sync' ? 'Syncing names and phone numbers…' : 'Working…';
    try {
      state = await request(action, body);
      const available = new Set((state.contacts || []).map(c => c.number));
      for (const number of selected) if (!available.has(number)) selected.delete(number);
      el('[data-setup]').open = !state.configured;
      el('[data-status]').textContent = (state.notice || (state.connected ? 'Connected.' : 'Set up Google to get started.')) +
        (state.synced_at ? ` Last sync: ${new Date(state.synced_at * 1000).toLocaleString()}.` : '');
    } catch (error) { el('[data-status]').textContent = error.message; }
    finally { busy = false; render(); schedule(); }
  }
  el('[data-file]').addEventListener('change', async () => {
    const file = el('[data-file]').files[0]; if (!file) return;
    try {
      if (file.size > 32000) throw new Error('Choose a Google Desktop OAuth JSON smaller than 32 KB.');
      const data = JSON.parse(await file.text()); await run('configure', data);
    } catch { el('[data-status]').textContent = 'Could not import the file. Choose a valid Google Desktop OAuth JSON smaller than 32 KB.'; }
    finally { el('[data-file]').value = ''; }
  });
  el('[data-connect]').addEventListener('click', () => void run('connect'));
  el('[data-sync]').addEventListener('click', () => void run('sync'));
  el('[data-disconnect]').addEventListener('click', () => {
    if (window.confirm('Disconnect Google and clear its local credentials and contacts? Saved secretary rules will remain.')) void run('disconnect');
  });
  el('[data-search]').addEventListener('input', renderList);
  el('[data-select]').addEventListener('click', () => { shown.forEach(c => selected.add(c.number)); renderList(); });
  el('[data-clear]').addEventListener('click', () => { selected.clear(); renderList(); });
  el('[data-add]').addEventListener('click', () => {
    try {
      addContacts((state.contacts || []).filter(c => selected.has(c.number)), el('[data-action]').value);
      selected.clear(); dialog.close();
    } catch (error) { el('[data-status]').textContent = error.message; }
  });
  el('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => clearTimeout(timer));
  document.querySelector('#secretary-google-contacts').addEventListener('click', () => { dialog.showModal(); void run(); });
}
