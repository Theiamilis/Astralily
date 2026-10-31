export function installInboxReview() {
  const launch = document.createElement('button'); launch.type = 'button'; launch.className = 'icon-button'; launch.textContent = 'INBOX';
  document.querySelector('#edit-secretary').after(launch);
  const dialog = document.createElement('dialog'); dialog.className = 'prompt-editor inbox-review';
  dialog.setAttribute('aria-label', 'WhatsApp inbox review');
  dialog.innerHTML = `<header class="prompt-header"><div><p class="eyebrow">PERSONAL WHATSAPP</p><h2>Needs your attention.</h2></div><button type="button" data-close class="ghost-button">Close ×</button></header>
    <p class="step-intro">Review a contact’s latest message. Drafting does not send a reply or enable secretary mode.</p>
    <div class="review-toolbar"><label><input type="checkbox" data-filter> Needs decision only</label><label><input type="checkbox" data-promotions> Include promotions</label><label><input type="checkbox" data-handled> Include handled</label><button class="ghost-button" data-refresh>Refresh</button></div>
    <div class="review-grid"><nav aria-label="Conversations" data-list></nav><section data-detail><p>Select a conversation.</p></section></div>
    <footer class="prompt-footer"><span role="status" aria-live="polite"></span><div class="review-actions" data-review-actions></div></footer>`;
  document.body.append(dialog);
  window.IRISDialogs.prepare(dialog);
  const list = dialog.querySelector('[data-list]'), detail = dialog.querySelector('[data-detail]'), status = dialog.querySelector('[role=status]');
  let items = [], selected = null, busy = false;
  const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  async function request(action = '', payload) {
    const response = await fetch('/api/wa/review' + (action ? '/' + action : ''), payload ? {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-IRIS-CSRF': document.querySelector('meta[name=iris-csrf]').content}, body: JSON.stringify(payload),
    } : {});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Inbox unavailable.'); return data;
  }
  async function run(fn) {
    if (busy) return; busy = true; dialog.querySelectorAll('button').forEach(b => b.disabled = true); status.textContent = 'Working…';
    try { await fn(); status.textContent = 'Updated.'; } catch (error) { status.textContent = error.message; }
    finally { busy = false; dialog.querySelectorAll('button').forEach(b => b.disabled = false); }
  }
  function renderList() {
    list.replaceChildren();
    const visible = items.filter(i => (dialog.querySelector('[data-handled]').checked || !['sent', 'resolved'].includes(i.status))
      && (dialog.querySelector('[data-promotions]').checked || i.category !== 'promotion' || i.triageMode !== 'enforce')
      && (!dialog.querySelector('[data-filter]').checked || i.needsOwner));
    visible.sort((a,b) => Number(b.needsOwner) - Number(a.needsOwner));
    if (!visible.length) list.append(el('p', 'Nothing waiting in this view.'));
    for (const item of visible) {
      const button = el('button', ''); button.type = 'button'; button.className = 'review-contact';
      button.append(el('strong', item.name || item.phoneNumber), el('small', `${item.category.replaceAll('_', ' ')} · ${item.needsOwner ? 'Needs decision' : 'Pending review'} · ${new Date(item.createdAt).toLocaleString()}`), el('span', item.summary || item.message));
      button.onclick = () => { if (busy || !discard()) return; selected = item; renderDetail(); }; list.append(button);
    }
  }
  function discard() { const field = detail.querySelector('textarea'); return !field || field.value === (selected?.draft || '') || window.confirm('Discard your edited draft?'); }
  function renderDetail() {
    const actions = dialog.querySelector('[data-review-actions]');
    actions.replaceChildren();
    detail.replaceChildren(); if (!selected) { detail.append(el('p', 'Select a conversation.')); return; }
    const item = selected;
    detail.append(el('h3', item.name || 'Contact'), el('p', item.phoneNumber || ''), el('blockquote', item.message || ''), el('p', `Status: ${item.status}`));
    const route = el('p', `Category: ${item.category.replaceAll('_', ' ')} · ${item.confidence || "low"} confidence · ${item.policyReason.replaceAll('_', ' ')} · ${item.triageMode === 'shadow' ? 'preview only' : 'applied'}`);
    detail.append(route);
    if (item.categorySource === 'owner') detail.append(el('p', `You corrected this from ${item.detectedCategory.replaceAll('_', ' ')} (${item.detectedReason.replaceAll('_', ' ')}). This does not send a reply.`));
    const correction = el('label', 'Correct category');
    const choice = document.createElement('select');
    for (const [key, name] of [['personal', 'Personal'], ['promotion', 'Promotion'], ['delivery', 'Delivery'], ['sensitive_delivery', 'Sensitive delivery'], ['uncertain', 'Uncertain']]) {
      const option = document.createElement('option'); option.value = key; option.textContent = name; choice.append(option);
    }
    choice.value = item.category; correction.append(choice);
    const correct = el('button', 'Save category'); correct.type = 'button'; correct.className = 'ghost-button';
    correct.onclick = () => { if (!discard()) return; void run(async () => { await request('correct', {id:item.id, category:choice.value}); await load(item.id); }); };
    detail.append(correction, correct);
    if (item.summary) detail.append(el('h4', 'Summary'), el('p', item.summary));
    if (item.secretaryReply) detail.append(el('h4', 'Lily replied'), el('blockquote', item.secretaryReply));
    if (item.needsOwner) detail.append(el('p', 'Needs your decision.'));
    const delivery = Object.entries(item.notificationStatus || {}).map(([channel, value]) => `${channel}: ${value}`).join(' · ');
    if (delivery || item.notificationPending) detail.append(el('p', item.notificationPending ? 'Notification waiting for your delivery schedule.' : `Notifications · ${delivery}`));
    if (!['sent', 'resolved'].includes(item.status)) {
      const reminders = el('section', ''); reminders.className = 'review-reminder';
      reminders.append(el('h4', 'Remind me'));
      if (item.reminder) reminders.append(el('p', `${new Date(item.reminder.dueAt).toLocaleString()} · ${item.reminder.status}`));
      const whenLabel = el('label', 'Date & time on this device');
      const when = document.createElement('input'); when.type = 'datetime-local';
      const initial = new Date(item.reminder?.dueAt || Date.now() + 3600000);
      when.value = new Date(initial.getTime() - initial.getTimezoneOffset() * 60000).toISOString().slice(0,16);
      whenLabel.append(when);
      const noteLabel = el('label', 'Note (optional)'); const note = document.createElement('input'); note.maxLength = 300;
      note.value = item.reminder?.note || ''; note.placeholder = 'Send the revised file'; noteLabel.append(note);
      const schedule = el('button', item.reminder ? 'Reschedule' : 'Set reminder'); schedule.className = 'ghost-button';
      schedule.onclick = () => { if (!discard()) return; void run(async () => {
        const date = new Date(when.value); if (!Number.isFinite(date.getTime())) throw new Error('Choose a date and time.');
        await request('remind', {id:item.id, due_at:date.toISOString(), note:note.value}); await load(item.id);
      }); };
      reminders.append(whenLabel, noteLabel, schedule);
      if (item.reminder) {
        const cancel = el('button', 'Cancel reminder'); cancel.className = 'ghost-button';
        cancel.onclick = () => { if (discard()) void run(async () => { await request('cancel-reminder', {id:item.id}); await load(item.id); }); };
        reminders.append(cancel);
      }
      reminders.append(el('small', 'Only you are notified. Marking this chat handled cancels the reminder.'));
      detail.append(reminders);
    }
    if (item.processing) { detail.append(el('p', 'A new message is being processed. Refresh shortly.')); return; }
    if (['sending', 'uncertain'].includes(item.status)) { detail.append(el('p', 'Check delivery in WhatsApp. This submission will not be retried.')); return; }
    if (!item.canReply) detail.append(el('p', 'Contact rules allow review only. Replies are disabled.'));
    const label = el('label', 'Reply draft'); const input = document.createElement('textarea'); input.rows = 7; input.maxLength = 2000; input.value = item.draft || ''; input.disabled = !item.canReply; label.hidden = !item.canReply; label.append(input); detail.append(label);
    const draft = el('button', 'Generate draft'); draft.className = 'ghost-button';
    draft.onclick = () => { if (!discard()) return; void run(async () => { await request('draft', {id:item.id}); await load(item.id); }); };
    const send = el('button', 'Review & send'); send.className = 'primary-button';
    send.onclick = () => {
      const text = input.value.trim(); if (!text || !item.revision || item.status !== 'draft') { status.textContent = 'Generate a draft first, then edit it before sending.'; return; }
      if (!window.confirm(`Send to ${item.name || 'Contact'} (${item.phoneNumber})?\n\n${text}`)) return;
      void run(async () => { await request('approve', {id:item.id, revision:item.revision, text, confirm:true}); await load(); });
    };
    const done = el('button', 'Mark handled'); done.className = 'ghost-button';
    done.onclick = () => { if (!discard()) return; void run(async () => { await request('resolve', {id:item.id}); await load(); }); };
    if (item.canReply) actions.append(draft);
    actions.append(done);
    if (item.canReply) actions.append(send);
  }
  async function load(id) { const data = await request(); items = data.items || []; selected = items.find(i => i.id === id) || null; renderList(); renderDetail(); }
  launch.onclick = () => { dialog.showModal(); void run(() => load()); };
  dialog.querySelector('[data-refresh]').onclick = () => { if (discard()) void run(() => load()); };
  dialog.querySelector('[data-close]').onclick = () => { if (!busy && discard()) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
  dialog.querySelector('[data-filter]').onchange = renderList;
  dialog.querySelector('[data-promotions]').onchange = renderList;
  dialog.querySelector('[data-handled]').onchange = renderList;
}
