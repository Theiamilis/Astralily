const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretary, parseSecretaryCommand } = require('../secretary');

function fixture(t, changes = {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-secretary-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    let clock = 100000;
    let presence = { status: 'available' };
    const jobs = new Map();
    const sent = [], requests = [], summaries = [];
    const options = {
        filePath: path.join(folder, 'state.json'), initialMode: 'auto', ownerName: 'Lily User',
        now: () => clock, getPresence: () => presence, allowed: () => true,
        schedule: (fn, ms) => { const id = Symbol(); jobs.set(id, { fn, ms }); return id; },
        cancel: (id) => jobs.delete(id),
        generate: async (request) => { requests.push(request); return { reply: 'Ada yang mau dititipkan?', summary: 'Kontak menyapa.', needs_owner: false }; },
        send: async (chat, text, valid) => { if (!valid()) return false; sent.push({ chat, text }); return true; },
        onSummary: async (...args) => summaries.push(args),
        ...changes,
    };
    const s = createSecretary(options);
    const details = { decision: 'routine', name: 'Contact', language: 'id' };
    return { s, options, details, sent, jobs, requests, summaries,
        busy: () => { presence = { status: 'busy' }; },
        available: () => { presence = { status: 'available' }; s.presenceChanged(); },
        advance: (ms) => { clock += ms; },
    };
}

test('auto requires owner busy, manual on/off overrides availability and persists', async (t) => {
    const f = fixture(t);
    assert.equal(f.s.receive('a', 'halo', f.details), false);
    f.busy();
    assert.equal(f.s.enabled(), true);
    f.s.setMode('off');
    assert.equal(f.s.enabled(), false);
    f.available();
    f.s.setMode('active');
    assert.equal(f.s.enabled(), true);
    const restored = createSecretary(f.options);
    assert.equal(restored.mode(), 'active');
});

test('shadow, off, public profile, and excluded contacts never generate or send', async (t) => {
    for (const change of [{ initialMode: 'shadow' }, { initialMode: 'off' },
        { initialMode: 'active', personal: false }, { initialMode: 'active', allowed: () => false }]) {
        const f = fixture(t, change);
        f.busy();
        f.s.receive('a', 'hello', f.details);
        await f.s.flush('a');
        assert.equal(f.requests.length, 0);
        assert.equal(f.sent.length, 0);
    }
});

test('first reply is delayed and followups retain only the current contact history', async (t) => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'halo', f.details);
    assert.equal([...f.jobs.values()][0].ms, 60000);
    await f.s.flush('a');
    assert.equal(f.requests[0].introduced, false);
    assert.equal(f.s.isOwnReply('a', f.sent[0].text), true);
    f.s.receive('a', 'mau titip pesan', f.details);
    assert.ok([...f.jobs.values()].some((job) => job.ms === 8000));
    await f.s.flush('a');
    assert.equal(f.requests[1].introduced, true);
    assert.equal(f.requests[1].history[0].text, 'halo');
    f.s.receive('b', 'halo juga', f.details);
    await f.s.flush('b');
    assert.deepEqual(f.requests[2].history, []);
});

test('personal secretary signs each sent reply once without exceeding the reply limit', async (t) => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'halo', f.details);
    await f.s.flush('a');
    assert.equal(f.sent[0].text, 'Ada yang mau dititipkan?\n\n~ Lily');

    const g = fixture(t, { generate: async () => ({ reply: 'Halo lagi.\n\n~ Lily', summary: 'Reply.', needs_owner: false }) });
    g.busy();
    g.s.receive('b', 'halo', g.details);
    await g.s.flush('b');
    assert.equal(g.sent[0].text, 'Halo lagi.\n\n~ Lily');

    const h = fixture(t, { generate: async () => ({ reply: 'a'.repeat(700), summary: 'Reply.', needs_owner: false }) });
    h.busy();
    h.s.receive('c', 'halo', h.details);
    await h.s.flush('c');
    assert.equal(h.sent[0].text.length, 700);
    assert.ok(h.sent[0].text.endsWith('\n\n~ Lily'));
});

test('owner reply cancels queued work and survives a restart', async (t) => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'halo', f.details);
    f.s.ownerReplied('a');
    await f.s.flush('a');
    assert.equal(f.sent.length, 0);
    assert.equal(f.s.receive('a', 'masih ada?', f.details), false);
    const restored = createSecretary(f.options);
    assert.equal(restored.receive('a', 'halo lagi', f.details), false);
    f.advance(1800001);
    assert.equal(restored.receive('a', 'halo lagi', f.details), true);
});

test('owner takeover, off, and availability changes cancel an in-flight model answer', async (t) => {
    for (const action of ['owner', 'off', 'available']) {
        let release;
        const f = fixture(t, { generate: () => new Promise((resolve) => { release = resolve; }) }); f.busy();
        f.s.receive('a', 'halo', f.details);
        const running = f.s.flush('a');
        if (action === 'owner') f.s.ownerReplied('a');
        if (action === 'off') f.s.setMode('off');
        if (action === 'available') f.available();
        release({ reply: 'balasan lama', summary: 'test', needs_owner: false });
        await running;
        assert.equal(f.sent.length, 0, action);
    }
});

test('owner takeover during typing is checked immediately before send', async (t) => {
    let f;
    f = fixture(t, { send: async (_chat, _text, valid) => {
        f.s.ownerReplied('a');
        assert.equal(valid(), false);
        return false;
    } }); f.busy();
    f.s.receive('a', 'halo', f.details);
    await f.s.flush('a');
    assert.equal(f.s.isOwnReply('a', 'Ada yang mau dititipkan?'), false);
});

test('sensitive new message cancels a previously queued routine acknowledgement', async (t) => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'halo', f.details);
    f.s.receive('a', 'kode otp', { ...f.details, decision: 'hold' });
    await f.s.flush('a');
    assert.equal(f.sent.length, 0);
});

test('provider outage sends nothing and an uncertain send is not retried', async (t) => {
    const f = fixture(t, { generate: async () => { throw new Error('offline'); } }); f.busy();
    f.s.receive('a', 'tolong hubungi', f.details);
    await f.s.flush('a');
    assert.equal(f.sent.length, 0);
    assert.equal(f.s.runtimeStatus().provider_failures, 1);
    let attempts = 0;
    const g = fixture(t, { send: async () => { attempts++; throw new Error('lost response'); } }); g.busy();
    g.s.receive('a', 'halo', g.details);
    await g.s.flush('a');
    g.s.receive('a', 'halo lagi', g.details);
    await g.s.flush('a');
    assert.equal(attempts, 1);
    assert.equal(g.s.runtimeStatus().uncertain_sends_last_hour, 1);
    const restored = createSecretary(g.options);
    assert.equal(restored.runtimeStatus().uncertain_sends_last_hour, 1);
    assert.equal(restored.receive('a', 'new message after restart', g.details), false);
    await restored.flush('a');
    assert.equal(attempts, 1);
});

test('hourly contact and global send limits persist and hold later replies for review', async t => {
    const f = fixture(t); f.busy();
    const settings = { mode: 'active', first_reply_seconds: 60, followup_seconds: 8,
        handoff_minutes: 30, conversation_minutes: 15, max_replies: 6, summary_delay_seconds: 30,
        per_contact_send_limit_per_hour: 1, global_send_limit_per_hour: 2 };
    f.s.configure(settings);
    f.s.receive('a', 'hello one', f.details); await f.s.flush('a');
    f.s.receive('a', 'hello two', f.details); await f.s.flush('a');
    f.s.receive('b', 'hello three', f.details); await f.s.flush('b');
    f.s.receive('c', 'hello four', f.details); await f.s.flush('c');
    const runtime = f.s.runtimeStatus();
    assert.equal(f.sent.length, 2);
    assert.equal(runtime.send_attempts_last_hour, 2);
    assert.equal(runtime.per_contact_send_limit_per_hour, 1);
    assert.equal(runtime.global_send_limit_per_hour, 2);
    assert.equal(runtime.last_rate_limited_scope, 'global');
    assert.equal(f.summaries.length, 0);
    assert.ok(f.jobs.size >= 2);
    const restored = createSecretary(f.options);
    assert.equal(restored.runtimeStatus().send_attempts_last_hour, 2);
});

test('a recent duplicate or echoed Lily reply is held to prevent a reply loop', async t => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'hello', f.details); await f.s.flush('a');
    const echoed = f.sent[0].text;
    assert.equal(f.s.receive('a', echoed, f.details), true);
    await f.s.flush('a');
    assert.equal(f.requests.length, 1);
    assert.equal(f.sent.length, 1);
});

test('malformed provider output and forwarding claims are held for owner review', async t => {
    for (const result of [{reply: 'halo'}, {reply: 'Aku akan sampaikan ke Lily User.', summary: 'Pesan', needs_owner: false}]) {
        const f = fixture(t, {generate: async () => result}); f.busy();
        f.s.receive('a', 'halo', f.details);
        await f.s.flush('a');
        assert.equal(f.sent.length, 0);
        assert.equal(f.summaries.length, 0);
        assert.equal(f.jobs.size, 1);
    }
});

test('direct opt-out stays silent and never calls the model even during provider cooldown', async t => {
    let calls = 0;
    const f = fixture(t, {generate: async () => { calls++; throw new Error('offline'); }}); f.busy();
    for (const chat of ['a', 'b', 'c']) {
        f.s.receive(chat, 'halo', f.details);
        await f.s.flush(chat);
    }
    assert.equal(f.s.runtimeStatus().provider_cooling_down, true);
    f.s.receive('d', 'jangan dibales ya', f.details);
    await f.s.flush('d');
    assert.equal(calls, 3);
    assert.equal(f.sent.length, 0);
    assert.equal(f.s.runtimeStatus().provider_cooling_down, true);
});

test('six replies yield to the owner instead of looping forever', async (t) => {
    const f = fixture(t); f.busy();
    for (let n = 0; n < 8; n++) {
        f.s.receive('a', `pesan ${n}`, f.details);
        await f.s.flush('a');
    }
    assert.equal(f.sent.length, 6);
});

test('mode commands accept natural aliases but not negated or quoted instructions', () => {
    assert.equal(parseSecretaryCommand('Lily aktifin mode sekretaris').mode, 'active');
    assert.equal(parseSecretaryCommand('lily sekretaris off').mode, 'off');
    assert.equal(parseSecretaryCommand('/secretary auto').mode, 'auto');
    for (const text of ['jangan aktifin sekretaris', 'gimana aktifin sekretaris?', '"sekretaris on"']) {
        assert.equal(parseSecretaryCommand(text), null);
    }
});

test('launcher configuration cancels pending work and applies timing without restart', async t => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'hello', f.details);
    const settings = { mode: 'off', first_reply_seconds: 120, followup_seconds: 12,
        handoff_minutes: 10, conversation_minutes: 20, max_replies: 2, summary_delay_seconds: 15,
        per_contact_send_limit_per_hour: 6, global_send_limit_per_hour: 30 };
    f.s.configure(settings);
    await f.s.flush('a'); assert.equal(f.sent.length, 0);
    f.s.configure({ ...settings, mode: 'auto' });
    f.s.receive('a', 'hello again', f.details);
    assert.ok([...f.jobs.values()].some(job => job.ms === 120000));
    await f.s.flush('a');
    f.s.receive('a', 'thanks', f.details); await f.s.flush('a');
    f.s.receive('a', 'again', f.details); await f.s.flush('a');
    assert.equal(f.sent.length, 2);
});

test('messages received during generation replace stale reply without losing the first message', async t => {
    let release;
    const requests = [];
    const f = fixture(t, { generate: request => {
        requests.push(request);
        if (requests.length === 1) return new Promise(resolve => { release = resolve; });
        return Promise.resolve({reply: 'combined', summary: 'combined', needs_owner: true});
    } });
    f.busy();
    f.s.receive('a', 'besok jadi?', f.details);
    const running = f.s.flush('a');
    f.s.receive('a', 'jam berapa?', f.details);
    release({reply: 'outdated', summary: 'old', needs_owner: false});
    await running;
    assert.equal(f.sent.length, 0);
    assert.equal(f.jobs.size, 1);
    await f.s.flush('a');
    assert.equal(requests[1].message, 'besok jadi?\njam berapa?');
    assert.equal(f.sent[0].text, 'combined\n\n~ Lily');
});

test('owner takeover discards both in-flight and newly queued messages', async t => {
    let release;
    const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve; }) });
    f.busy();
    f.s.receive('a', 'hello', f.details);
    const running = f.s.flush('a');
    f.s.receive('a', 'more', f.details);
    f.s.ownerReplied('a');
    release({reply: 'old', summary: 'old', needs_owner: false});
    await running;
    await f.s.flush('a');
    assert.equal(f.sent.length, 0);
    assert.equal(f.jobs.size, 0);
});

test('outgoing echo is consumed once so identical owner text still triggers takeover', async t => {
    const f = fixture(t); f.busy();
    f.s.receive('a', 'hello', f.details);
    await f.s.flush('a');
    assert.equal(f.s.isOwnReply('a', f.sent[0].text), true);
    assert.equal(f.s.isOwnReply('a', f.sent[0].text), false);
});

test('sent reply is recorded immediately for review without waiting for summary notification', async t => {
    const records = [];
    const f = fixture(t, {onReply: (...args) => records.push(args)}); f.busy();
    f.s.receive('a', 'hello', f.details);
    await f.s.flush('a');
    f.s.setMode('off');
    assert.equal(records.length, 1);
    assert.equal(records[0][1].reply, f.sent[0].text);
    assert.equal(f.summaries.length, 0);
});
