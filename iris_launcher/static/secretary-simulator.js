export function installSecretarySimulator(getSettings) {
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'ghost-button'; open.textContent = 'Try conversation';
  document.querySelector('#secretary-reload').before(open);
  const panel = document.createElement('dialog'); panel.className = 'prompt-editor';
  panel.setAttribute('aria-label', 'Secretary conversation simulator');
  panel.innerHTML = `<form data-form><header class="prompt-header"><div><p class="eyebrow">SECRETARY / LOCAL PREVIEW</p><h2>Try a conversation.</h2></div><button type="button" data-close class="ghost-button">Close ×</button></header>
    <p class="step-intro">Uses local LLM credentials and API tokens. Nothing is sent to WhatsApp. Timing is skipped; this previews replies and contact rules.</p>
    <p data-source class="step-intro"></p>
    <div class="secretary-timing"><label>Contact number<input data-number type="tel" value="08000000001" maxlength="30"></label>
    <label>Contact name<input data-name value="Test contact" maxlength="100"></label>
    <label>Your name<input data-owner-name value="Lily User" maxlength="80"></label>
    <label>Simulated mode<select data-mode><option value="active">On</option><option value="off">Off</option><option value="auto">Auto</option></select></label>
    <label>Language<select data-language><option value="id">Indonesian</option><option value="en">English</option></select></label>
    <label><input type="checkbox" data-busy checked> Owner is busy</label></div>
    <div data-history role="log" aria-live="polite" style="max-height:35vh;overflow:auto;padding:1rem;border:1px solid currentColor"></div>
    <label>Message<textarea data-message rows="3" maxlength="2400" required placeholder="Lily User ada? Mau titip pesan."></textarea></label>
    <footer class="prompt-footer"><span data-status role="status"></span><button type="button" data-reset class="ghost-button">Reset</button><button type="button" data-takeover class="ghost-button">Take over</button><button type="submit" class="primary-button">Preview reply</button></footer></form>`;
  document.body.append(panel); window.IRISDialogs.prepare(panel);
  const q = selector => panel.querySelector(selector);
  let settings, history = [], turns = 0, takeover = false, epoch = 0, pending = false;
  const append = (title, text) => {
    const box = document.createElement('div'), heading = document.createElement('strong'), body = document.createElement('p');
    heading.textContent = title; body.textContent = text; box.append(heading, body); q('[data-history]').append(box);
    box.scrollIntoView({block:'nearest'});
  };
  function reset() { epoch++; history = []; turns = 0; takeover = false; q('[data-history]').replaceChildren(); q('[data-status]').textContent = 'Fresh conversation.'; }
  open.onclick = () => {
    settings = getSettings(); reset();
    q('[data-source]').textContent = settings ? 'Using the current editor values, including unsaved changes. Simulated mode is separate.' : 'Core settings unavailable: using default rules and prompt. Inference still runs locally.';
    settings = settings || {}; panel.showModal();
  };
  q('[data-close]').onclick = () => { epoch++; panel.close(); };
  panel.addEventListener('cancel', () => epoch++);
  q('[data-reset]').onclick = reset;
  for (const selector of ['[data-number]', '[data-name]', '[data-owner-name]', '[data-language]', '[data-mode]', '[data-busy]']) q(selector).onchange = reset;
  q('[data-takeover]').onclick = () => { epoch++; takeover = true; append('Owner takeover', 'Lily will not reply until you reset this simulation.'); };
  q('[data-form]').onsubmit = async event => {
    event.preventDefault(); if (pending) return;
    const message = q('[data-message]').value.trim(); if (!message) return;
    const version = epoch; pending = true; q('[type=submit]').disabled = true;
    q('[data-status]').textContent = 'Preparing preview…'; append(q('[data-name]').value || 'Contact', message);
    try {
      const response = await fetch('/api/wa/secretary/simulate', {method:'POST', headers:{'Content-Type':'application/json', 'X-IRIS-CSRF':document.querySelector('meta[name=iris-csrf]').content},
        body:JSON.stringify({settings:{...settings, mode:q('[data-mode]').value}, number:q('[data-number]').value, takeover, turns,
          request:{message, history:history.slice(-12), introduced:turns > 0, contact_name:q('[data-name]').value || 'Contact', owner_name:q('[data-owner-name]').value.trim(), owner_busy:q('[data-busy]').checked, language:q('[data-language]').value}})});
      const data = await response.json(); if (version !== epoch) return;
      if (!response.ok) throw new Error(data.error || 'Simulation unavailable.');
      append('Decision', data.reason);
      if (data.reply) { append('Lily', data.reply); history.push({role:'contact',text:message}, {role:'lily',text:data.reply}); turns++; }
      if (data.summary) append(data.needs_owner ? 'Summary · needs owner' : 'Summary', data.summary);
      q('[data-message]').value = ''; q('[data-status]').textContent = data.used_model ? 'Preview complete · API used' : 'Rule checked · no API usage';
    } catch (error) { if (version === epoch) q('[data-status]').textContent = error.message; }
    finally { pending = false; q('[type=submit]').disabled = false; }
  };
}
