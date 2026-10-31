// Owner-only editor; remote credentials stay in the loopback server.
const dialog = document.querySelector('#prompt-editor');
const field = document.querySelector('#prompt-text');
const status = document.querySelector('#prompt-status');
let catalog = null;
let selected = null;
let busy = false;
const dirty = () => selected && field.value !== selected.text.replace(/\r\n?/g, '\n');
const discard = () => !dirty() || window.confirm('Discard unsaved prompt changes?');
async function request(payload) {
  const response = await fetch('/api/prompts', payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-IRIS-CSRF': document.querySelector('meta[name="iris-csrf"]').content },
    body: JSON.stringify(payload),
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Prompt request failed.');
  return data;
}
function controls() {
  document.querySelector('#prompt-save').disabled = busy || !selected || !dirty() || !field.value.trim();
  document.querySelector('#prompt-reset').disabled = busy || !selected;
  document.querySelector('#prompt-reload').disabled = busy;
  document.querySelector('#prompt-close').disabled = busy;
  field.disabled = busy || !selected;
  document.querySelectorAll('#prompt-list button').forEach(button => { button.disabled = busy; });
}
function select(id) {
  selected = catalog.templates.find(item => item.id === id) || catalog.templates[0];
  field.value = selected.text;
  document.querySelector('#prompt-label').textContent = selected.label;
  document.querySelector('#prompt-description').textContent = selected.description;
  document.querySelector('#prompt-default').textContent = selected.default;
  document.querySelector('#prompt-variables').textContent = selected.variables.length
    ? `Required variables: ${selected.variables.map(value => `{{${value}}}`).join(', ')}`
    : 'No template variables · Maximum 16,000 characters';
  const list = document.querySelector('#prompt-list');
  list.replaceChildren();
  for (const item of catalog.templates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${item.label}${item.customized ? ' •' : ''}`;
    button.setAttribute('aria-pressed', String(item.id === selected.id));
    button.addEventListener('click', () => { if (!busy && discard()) { select(item.id); status.textContent = ''; } });
    list.append(button);
  }
  controls();
}
async function load() {
  busy = true; controls(); status.textContent = 'Loading templates…';
  try {
    catalog = await request();
    document.querySelector('#prompt-target').textContent = `Editing Core: ${catalog.core_url} · Private overrides, not committed to Git.`;
    select(selected?.id);
    status.textContent = 'Core changes apply on the next request. WA fallback syncs within one minute while online.';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
}
async function save(reset) {
  if (busy || !selected) return;
  if (reset && !window.confirm(`Reset ${selected.label} to its original template?`)) return;
  busy = true; controls(); status.textContent = 'Saving…';
  try {
    catalog = await request({ id: selected.id, text: reset ? null : field.value, revision: catalog.revision });
    select(selected.id);
    status.textContent = reset ? 'Default restored.' : 'Saved. New requests use this template.';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
}
document.querySelector('#edit-prompts').addEventListener('click', () => { dialog.showModal(); void load(); });
document.querySelector('#prompt-close').addEventListener('click', () => { if (!busy && discard()) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
document.querySelector('#prompt-reload').addEventListener('click', () => { if (discard()) void load(); });
document.querySelector('#prompt-reset').addEventListener('click', () => void save(true));
document.querySelector('#prompt-save').addEventListener('click', () => void save(false));
field.addEventListener('input', () => { controls(); status.textContent = dirty() ? 'Unsaved changes' : ''; });
