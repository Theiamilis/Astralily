// Shared dialog frame: navigation stays above the scrolling content, actions below.
(() => {
  function prepare(dialog, { parent = 'overview', back = null } = {}) {
    if (dialog.classList.contains('launcher-dialog')) return;
    const host = dialog.querySelector(':scope > form') || dialog;
    const header = host.querySelector('.prompt-header');
    const footer = host.querySelector('.prompt-footer, .setup-footer');
    const close = header.querySelector('button');
    const backButton = back || document.createElement('button');
    backButton.type = 'button';
    backButton.classList.add('ghost-button', 'dialog-back');
    backButton.textContent = '← Back';
    backButton.setAttribute('aria-label', `Back to ${parent}`);
    backButton.title = `Back to ${parent}`;
    close.classList.add('ghost-button', 'dialog-close');
    close.textContent = 'Close ×';
    header.prepend(backButton);

    // Delegate to each editor's existing close guard (busy state / unsaved changes).
    if (!back) {
      backButton.addEventListener('click', () => { if (!close.disabled) close.click(); });
      const sync = () => { backButton.disabled = close.disabled; };
      new MutationObserver(sync).observe(close, { attributes: true, attributeFilter: ['disabled'] });
      sync();
    }

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const status = footer.querySelector('[role="status"], [role="alert"]');
    for (const child of [...footer.children]) if (child !== status) actions.append(child);
    const message = status || document.createElement('span');
    message.classList.add('dialog-status');
    footer.replaceChildren(message, actions);
    footer.classList.add('dialog-footer');
    footer.remove();

    const body = document.createElement('div');
    body.className = 'dialog-body';
    for (const child of [...host.children]) if (child !== header) body.append(child);
    host.append(body, footer);
    dialog.classList.add('launcher-dialog');
  }

  window.IRISDialogs = { prepare };
  for (const dialog of document.querySelectorAll('dialog')) {
    prepare(dialog, {
      parent: dialog.id === 'client-editor' ? 'Devices' : 'overview',
      back: dialog.id === 'setup-dialog' ? document.querySelector('#setup-back') : null,
    });
  }
})();

const csrf = document.querySelector('meta[name="iris-csrf"]').content;
const nativeHost = new URLSearchParams(window.location.search).get('native') === '1';
const themeToggle = document.querySelector('#theme-toggle');

function getNativeWindow() {
  if (!nativeHost) return null;
  try {
    return window.__TAURI__?.window?.getCurrentWindow?.() || null;
  } catch (reason) {
    return null;
  }
}

function nativeWindowAction(method) {
  try {
    const nativeWindow = getNativeWindow();
    const action = nativeWindow?.[method]?.();
    if (action) action.catch(() => {});
  } catch (reason) {
    // Browser mode or an older native build can safely ignore custom controls.
  }
}

function applyTheme(theme) {
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  const light = resolved === 'light';
  themeToggle?.setAttribute('aria-pressed', String(light));
  themeToggle?.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  const label = themeToggle?.querySelector('[data-theme-label]');
  if (label) label.textContent = light ? 'DARK MODE' : 'LIGHT MODE';
  if (nativeHost) {
    try {
      const nativeWindow = getNativeWindow();
      const nativeTheme = nativeWindow?.setTheme?.(resolved);
      if (nativeTheme) nativeTheme.catch(() => {});
    } catch (reason) {
      // Browser mode and older native builds simply keep their default title bar.
    }
  }
  try {
    window.localStorage.setItem('iris-theme', resolved);
  } catch (reason) {
    // The native webview may disable storage in a locked-down profile.
  }
}

let savedTheme = 'dark';
try {
  savedTheme = window.localStorage.getItem('iris-theme') || 'dark';
} catch (reason) {
  // Fall back to dark mode when storage is unavailable.
}
applyTheme(savedTheme);

if (nativeHost) {
  document.documentElement.dataset.host = 'native';
  document.querySelector('#quit-launcher').textContent = 'Hide to tray';
}

const state = {
  bootstrap: null,
  step: 0,
  jobId: null,
  jobStatus: null,
  pollTimer: null,
  setupSaving: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    headers['X-IRIS-CSRF'] = csrf;
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, duration = 3800) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove('show'), duration);
}

function setBusy(busy) {
  $$('#launch-all, #stop-all, .service-controls button').forEach((button) => {
    button.disabled = busy;
  });
  $('#launch-all span').textContent = busy ? 'Working…' : 'Launch constellation';
}

function formatDate() {
  const now = new Date();
  $('#date-line').textContent = now.toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).toUpperCase();
}

function renderServices(services) {
  const grid = $('#service-grid');
  grid.innerHTML = services.map((service, index) => `
    <article class="service-card" data-service="${escapeHtml(service.id)}">
      <span class="service-number">0${index + 1}</span>
      <span class="service-state ${escapeHtml(service.state)}"><i></i>${escapeHtml(service.state)}</span>
      <h3>${escapeHtml(service.label)}</h3>
      <p>${escapeHtml(service.description)}</p>
      <div class="service-meta">${escapeHtml(service.detail)}</div>
      ${service.controllable ? `<div class="service-controls">
          <button type="button" data-action="start" data-target="${escapeHtml(service.id)}">Start</button>
          <button type="button" data-action="restart" data-target="${escapeHtml(service.id)}">Restart</button>
          <button type="button" data-action="stop" data-target="${escapeHtml(service.id)}">Stop</button>
        </div>` : `<div class="service-location">${service.location === 'disabled' ? 'NOT USED IN THIS PROFILE' : 'MANAGED ON REMOTE HOST'}</div>`}
    </article>
  `).join('');

  $$('.service-controls button', grid).forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.target, button.dataset.action));
  });

  const active = services.filter((service) => service.state !== 'disabled');
  const online = active.filter((service) => service.state === 'online').length;
  $('#online-count').textContent = `${online}/${active.length}`;
  services.forEach((service) => {
    const star = $(`[data-orbit-service="${service.id}"]`);
    if (star) star.className = `orbit-star star-${service.id === 'voice' ? 'a' : service.id === 'private' ? 'b' : 'c'} ${service.state}`;
  });
  const globalDot = $('#global-dot');
  const globalLabel = $('#global-label');
  if (online === active.length) {
    globalDot.style.background = 'var(--acid)';
    globalLabel.textContent = 'ALL SIGNALS ONLINE';
  } else if (services.some((service) => service.state !== 'offline')) {
    globalDot.style.background = 'var(--amber)';
    globalLabel.textContent = 'PARTIAL SIGNAL';
  } else {
    globalDot.style.background = 'var(--danger)';
    globalLabel.textContent = 'CONSTELLATION ASLEEP';
  }
}

function animateConstellation() {
  const panel = $('.orbit-panel');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!panel) return;

  const nodes = [
    { service: 'voice', orbit: '.orbit-one', phase: -0.35, speed: 0.00011 },
    { service: 'private', orbit: '.orbit-two', phase: 2.15, speed: -0.000085 },
    { service: 'core', orbit: '.orbit-three', phase: 4.35, speed: 0.00014 },
  ];

  // Use the drawn ellipse's border centerline; labels never affect dot geometry.
  function measure() {
    nodes.forEach(node => {
      node.element = panel.querySelector(`[data-orbit-service="${node.service}"]`);
      const style = getComputedStyle(panel.querySelector(node.orbit));
      node.radiusX = (parseFloat(style.width) - parseFloat(style.borderLeftWidth)) / 2;
      node.radiusY = (parseFloat(style.height) - parseFloat(style.borderTopWidth)) / 2;
      node.radians = (parseFloat(style.getPropertyValue('--orbit-angle')) || 0) * Math.PI / 180;
    });
  }

  const frame = (timestamp) => {
    const centerX = panel.clientWidth / 2;
    const centerY = panel.clientHeight / 2;
    nodes.forEach((node) => {
      const element = node.element;
      if (!element) return;
      const angle = node.phase + timestamp * node.speed;
      const radians = node.radians;
      const ellipseX = Math.cos(angle) * node.radiusX;
      const ellipseY = Math.sin(angle) * node.radiusY;
      const x = ellipseX * Math.cos(radians) - ellipseY * Math.sin(radians);
      const y = ellipseX * Math.sin(radians) + ellipseY * Math.cos(radians);
      element.style.left = `${centerX + x}px`;
      element.style.top = `${centerY + y}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.transform = 'translate(-50%, -50%)';
    });
    if (!prefersReducedMotion.matches) window.requestAnimationFrame(frame);
  };

  new ResizeObserver(() => {
    measure();
    if (prefersReducedMotion.matches) frame(0);
  }).observe(panel);
  measure();
  window.requestAnimationFrame(frame);
}

function renderChecks(checks) {
  $('#check-list').innerHTML = checks.map((check) => `
    <div class="check-row ${check.ready ? 'ready' : ''}">
      <i></i>
      <span><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small></span>
      <em>${check.ready ? 'READY' : check.required ? 'NEEDS ATTENTION' : 'ON FIRST START'}</em>
    </div>
  `).join('');
  const requiredReady = checks.filter((check) => check.required).every((check) => check.ready);
  const readiness = $('#readiness');
  readiness.textContent = requiredReady ? 'READY FOR FIRST LIGHT' : 'SETUP NEEDS ATTENTION';
  readiness.classList.toggle('ready', requiredReady);
}

function renderLogs(logs, job = null) {
  const sections = [];
  if (job?.output) sections.push(`--- LAST LAUNCHER ACTION ---\n${job.output}`);
  if (job?.error) sections.push(`--- ACTION ERROR ---\n${job.error}`);
  if (logs) sections.push(logs);
  $('#activity-log').textContent = sections.join('\n\n') || 'No service logs yet. Start the constellation to create them.';
}

function populateSetup(config) {
  const form = $('#setup-form');
  for (const key of ['core_url', 'provider_base', 'brain_model', 'voice_service_url', 'voice_provider', 'voice_profile', 'live2d_model_url', 'realm_variant']) {
    const input = form.elements.namedItem(key);
    if (input) input.value = config[key] || '';
  }
  for (const [name, value] of [['brain_provider', config.brain_provider], ['voice_mode', config.voice_mode]]) {
    const radio = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }
  $('#owner-token-status').textContent = config.owner_token_aligned
    ? 'Configured and synchronized. Leave blank to keep it.'
    : 'Core and Realm tokens are missing or do not match.';
  $('#provider-key-status').textContent = config.provider_api_key_configured
    ? 'A key is already configured. Leave blank to keep it.'
    : 'No key configured. Local LM Studio normally does not need one.';
}

function collectSetup() {
  const form = $('#setup-form');
  const data = Object.fromEntries(new FormData(form).entries());
  return data;
}

function renderSetupSummary() {
  const data = collectSetup();
  const labels = {
    core_url: 'Core route',
    brain_provider: 'Brain provider',
    brain_model: 'Model',
    voice_mode: 'Voice mode',
    voice_profile: 'Voice profile',
    realm_variant: 'Room style',
  };
  $('#setup-summary').innerHTML = Object.entries(labels).map(([key, label]) => `
    <div class="summary-item"><small>${label}</small><b>${escapeHtml(data[key] || 'Not set')}</b></div>
  `).join('');
}

function showSetupStep(step) {
  state.step = Math.max(0, Math.min(3, step));
  $$('.setup-step').forEach((element) => element.classList.toggle('active', Number(element.dataset.step) === state.step));
  $$('[data-step-marker]').forEach((element) => {
    const marker = Number(element.dataset.stepMarker);
    element.classList.toggle('active', marker === state.step);
    element.classList.toggle('complete', marker < state.step);
  });
  $('#setup-progress').style.width = `${(state.step + 1) * 25}%`;
  const backLabel = state.step === 0 ? 'Back to overview' : 'Back to previous step';
  $('#setup-back').setAttribute('aria-label', backLabel);
  $('#setup-back').title = backLabel;
  $('#setup-next span').textContent = state.step === 3 ? 'Save configuration' : 'Continue';
  $('#setup-error').textContent = '';
  if (state.step === 3) renderSetupSummary();
  $('#setup-dialog .dialog-body').scrollTop = 0;
}

function stepInputsValid(step) {
  const section = $(`.setup-step[data-step="${step}"]`);
  const inputs = $$('input, select', section);
  for (const input of inputs) {
    if (!input.checkValidity()) {
      input.reportValidity();
      return false;
    }
  }
  return true;
}

async function saveSetup() {
  const button = $('#setup-next');
  const error = $('#setup-error');
  button.disabled = true;
  state.setupSaving = true;
  $('#setup-back').disabled = true;
  $('#close-setup').disabled = true;
  error.textContent = '';
  try {
    const payload = await api('/api/setup', { method: 'POST', body: JSON.stringify(collectSetup()) });
    state.bootstrap.config = payload.config;
    state.bootstrap.checks = payload.checks;
    renderChecks(payload.checks);
    $('#setup-dialog').close();
    toast('Configuration saved. The constellation is ready to launch.');
  } catch (reason) {
    error.textContent = reason.message;
  } finally {
    button.disabled = false;
    state.setupSaving = false;
    $('#setup-back').disabled = false;
    $('#close-setup').disabled = false;
  }
}

function openSetup() {
  populateSetup(state.bootstrap.config);
  showSetupStep(0);
  $('#setup-dialog').showModal();
}

async function runAction(target, action) {
  if (action === 'stop' && !window.confirm(`Stop ${target === 'all' ? 'the local constellation' : target}?`)) return;
  setBusy(true);
  try {
    const payload = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ target, action }),
    });
    state.jobId = payload.job.id;
    state.jobStatus = 'running';
    renderLogs(state.bootstrap.logs, payload.job);
    toast(`${action} queued for ${target}. First launch can take a few minutes.`);
  } catch (reason) {
    setBusy(false);
    toast(reason.message, 6000);
  }
}

async function refreshStatus() {
  try {
    const payload = await api('/api/status');
    renderServices(payload.services);
    const job = payload.job;
    if (job) {
      renderLogs(state.bootstrap.logs, job);
      if (state.jobStatus === 'running' && job.status !== 'running') {
        toast(job.status === 'done' ? 'Launcher action completed.' : `Launcher action failed: ${job.error}`, 6000);
      }
      state.jobStatus = job.status;
      setBusy(job.status === 'running');
    } else {
      setBusy(false);
    }
  } catch (reason) {
    $('#global-label').textContent = 'LAUNCHER LINK LOST';
  }
}

async function refreshLogs() {
  try {
    const payload = await api('/api/logs');
    state.bootstrap.logs = payload.logs;
    renderLogs(payload.logs, state.bootstrap.job);
  } catch (reason) {
    toast(reason.message);
  }
}

async function initialize() {
  formatDate();
  try {
    state.bootstrap = await api('/api/bootstrap');
    renderServices(state.bootstrap.services);
    renderChecks(state.bootstrap.checks);
    renderLogs(state.bootstrap.logs, state.bootstrap.job);
    populateSetup(state.bootstrap.config);
    state.jobStatus = state.bootstrap.job?.status || null;
    setBusy(state.jobStatus === 'running');
    if (!state.bootstrap.config.setup_complete) openSetup();
    state.pollTimer = window.setInterval(refreshStatus, 3000);
  } catch (reason) {
    toast(`Launcher initialization failed: ${reason.message}`, 8000);
  }
}

$('#launch-all').addEventListener('click', () => runAction('all', 'start'));
$('#stop-all').addEventListener('click', () => runAction('all', 'stop'));
$('#open-realm').addEventListener('click', async () => {
  if (!nativeHost) {
    window.open('http://127.0.0.1:5230/', '_blank', 'noopener');
    return;
  }
  try {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'private' }) });
  } catch (reason) {
    toast(reason.message);
  }
});
$('#refresh-status').addEventListener('click', refreshStatus);
$('#refresh-logs').addEventListener('click', refreshLogs);
$('#edit-setup').addEventListener('click', openSetup);
themeToggle?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
document.querySelector('.topbar')?.addEventListener('pointerdown', (event) => {
  if (!nativeHost || event.button !== 0 || event.target.closest('button, a, input, select')) return;
  nativeWindowAction('startDragging');
});
$('#window-minimize')?.addEventListener('click', () => nativeWindowAction('minimize'));
$('#window-maximize')?.addEventListener('click', () => nativeWindowAction('toggleMaximize'));
$('#window-close')?.addEventListener('click', () => nativeWindowAction('close'));
$('#close-setup').addEventListener('click', () => $('#setup-dialog').close());
$('#setup-back').addEventListener('click', () => {
  if (state.setupSaving) return;
  if (state.step === 0) $('#close-setup').click();
  else showSetupStep(state.step - 1);
});
$('#setup-dialog').addEventListener('cancel', event => { if (state.setupSaving) event.preventDefault(); });
$('#setup-next').addEventListener('click', () => {
  if (!stepInputsValid(state.step)) return;
  if (state.step < 3) showSetupStep(state.step + 1);
  else saveSetup();
});
$('#quit-launcher').addEventListener('click', async () => {
  if (nativeHost) {
    try {
      await window.__TAURI__.window.getCurrentWindow().hide();
    } catch (reason) {
      toast('Use the window close button to hide IRIS to the tray.');
    }
    return;
  }
  if (!window.confirm('Quit IRIS Launcher? Running Lily services will stay online.')) return;
  try {
    await api('/api/quit', { method: 'POST', body: '{}' });
    document.body.innerHTML = '<main class="section"><p class="section-index">IRIS LAUNCHER</p><h2>Launcher closed.</h2><p class="hero-lede">Your running Lily services were left untouched. You can close this tab.</p></main>';
  } catch (reason) {
    toast(reason.message);
  }
});

initialize();
animateConstellation();
