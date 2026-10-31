const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInboxDelivery, quietNow, DEFAULTS } = require('../inbox-delivery');
const { inboxSummary } = require('../inbox-summary');

function harness(t, notifications = {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-delivery-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const h = { time: Date.parse('2026-09-25T05:00:00Z'), items: [], wa: [], hud: [], blocked: new Set(), fresh: true, online: true,
        settings: {notifications: {...DEFAULTS, ...notifications}}, filePath: path.join(folder, 'ledger.json') };
    h.add = (id, extra = {}) => { const item = {id, chatId: id + '@c.us', name: id, summary: 'old', secretarySummary: 'latest', ...extra}; h.items.unshift(item); return item; };
    h.open = (overrides = {}) => createInboxDelivery({filePath: h.filePath, items: () => h.items,
        settings: () => h.fresh ? h.settings : null, allowed: id => !h.blocked.has(id), now: () => h.time,
        ready: () => h.online, sendWa: async value => h.wa.push(value), sendHud: async value => h.hud.push(value), ...overrides});
    h.delivery = h.open(); return h;
}

test('every selected channel gets the same canonical summary; repeated enqueue is deduplicated', async t => {
    const h = harness(t, {channels: ['wa', 'hud', 'mobile']}); const item = h.add('a');
    h.delivery.enqueue(item); await h.delivery.tick();
    assert.equal(h.wa[0].text, 'a: latest'); assert.equal(h.wa[0].text, h.hud[0].text);
    assert.equal(h.delivery.notifications()[0].text, h.wa[0].text);
    assert.deepEqual(h.delivery.forItem(item).notificationStatus,
        {wa: 'sent', hud: 'published', mobile: 'ready'});
    h.delivery.enqueue(item); await h.delivery.tick(); assert.equal(h.wa.length, 1);
    assert.equal(inboxSummary({...item, secretarySummary: ''}), 'old');
    h.delivery = h.open(); h.delivery.enqueue(item); await h.delivery.tick(); assert.equal(h.wa.length, 1);
});

test('digest coalesces each chat and uses the latest summary when due', async t => {
    const h = harness(t, {mode: 'digest', digest_minutes: 10}); const a = h.add('a'), b = h.add('b');
    h.delivery.enqueue(a); h.delivery.enqueue(b); await h.delivery.tick(); assert.equal(h.wa.length, 0);
    a.secretarySummary = 'updated'; h.time += 600000; await h.delivery.tick();
    assert.equal(h.wa.length, 1); assert.match(h.wa[0].text, /a: updated/); assert.match(h.wa[0].text, /b: latest/);
});

test('quiet hours cover midnight in the selected timezone, release at end and allow urgent bypass', async t => {
    const h = harness(t, {quiet_enabled: true}); h.time = Date.parse('2026-09-25T16:00:00Z');
    const a = h.add('a'); h.delivery.enqueue(a); await h.delivery.tick(); assert.equal(h.wa.length, 0);
    const b = h.add('b', {category: 'delivery'}); h.delivery.enqueue(b); await h.delivery.tick(); assert.equal(h.wa.length, 1);
    h.time = Date.parse('2026-09-26T00:00:00Z'); await h.delivery.tick(); assert.equal(h.wa.length, 2);
    assert.equal(quietNow({...DEFAULTS, quiet_enabled: true, quiet_start: '09:00', quiet_end: '17:00'}, Date.parse('2026-09-25T05:00Z')), true);
});

test('urgent bypass can be disabled and stale settings pause all deliveries', async t => {
    const h = harness(t, {quiet_enabled: true, urgent_immediate: false}); h.time = Date.parse('2026-09-25T16:00Z');
    h.delivery.enqueue(h.add('a', {category: 'delivery'})); await h.delivery.tick(); assert.equal(h.wa.length, 0);
    h.time += 12*3600000; h.fresh = false; await h.delivery.tick(); assert.equal(h.wa.length, 0);
    h.fresh = true; await h.delivery.tick(); assert.equal(h.wa.length, 1);
});

test('channel choice, ignored and handled chats suppress queued notifications', async t => {
    const h = harness(t, {channels: ['mobile'], mode: 'digest', digest_minutes: 1});
    const a = h.add('a'), b = h.add('b'), c = h.add('c'); [a,b,c].forEach(h.delivery.enqueue);
    h.blocked.add(a.chatId); b.review = {status: 'resolved'}; h.time += 60000; await h.delivery.tick();
    assert.equal(h.wa.length + h.hud.length, 0); assert.equal(h.delivery.notifications().length, 1);
    assert.equal(h.delivery.notifications()[0].text, 'c: latest'); h.blocked.add(c.chatId); assert.deepEqual(h.delivery.notifications(), []);
});

test('reminder persists over restart, uses the latest chat, and fires only once at explicit time', async t => {
    const h = harness(t, {channels: ['mobile'], quiet_enabled: true}); const a = h.add('a');
    h.delivery.remind(a.id, new Date(h.time + 60000).toISOString(), 'Read attachment');
    assert(h.delivery.retainedChats().has(a.chatId)); h.delivery = h.open();
    h.add('new', {chatId: a.chatId, secretarySummary: 'new message'});
    h.time += 60000; await h.delivery.tick(); await h.delivery.tick();
    assert.equal(h.delivery.notifications().length, 1); assert.match(h.delivery.notifications()[0].text, /Read attachment\n\na:|Read attachment\n\nnew: new message/);
    h.delivery = h.open(); await h.delivery.tick(); assert.equal(h.delivery.notifications().length, 1);
});

test('rescheduling cancels old waiting reminder; handled chats and explicit cancel remove reminders', async t => {
    const h = harness(t); h.online = false; const a = h.add('a');
    h.delivery.remind(a.id, new Date(h.time + 1000).toISOString()); h.time += 1000; await h.delivery.tick();
    h.delivery.remind(a.id, new Date(h.time + 1000).toISOString()); h.online = true; await h.delivery.tick(); assert.equal(h.wa.length, 0);
    h.time += 1000; await h.delivery.tick(); assert.equal(h.wa.length, 1);
    h.delivery.cancel(a.id); assert.equal(h.delivery.forItem(a).reminder, null);
    h.delivery.remind(a.id, new Date(h.time + 1000).toISOString()); a.review = {status: 'resolved'};
    h.time += 1000; await h.delivery.tick(); assert.equal(h.wa.length, 1); assert.equal(h.delivery.forItem(a).reminder, null);
});

test('reminder validates date, note and newest item', t => {
    const h = harness(t); const a = h.add('a');
    for (const when of ['invalid', new Date(h.time).toISOString(), new Date(h.time + 400*86400000).toISOString()])
        assert.throws(() => h.delivery.remind(a.id, when));
    assert.throws(() => h.delivery.remind(a.id, new Date(h.time + 1000).toISOString(), 'x'.repeat(301)));
    h.add('b', {chatId: a.chatId}); assert.throws(() => h.delivery.remind(a.id, new Date(h.time + 1000).toISOString()));
});

test('uncertain sending is not repeated, including process death after claiming send', async t => {
    const h = harness(t); const a = h.add('a'); let calls = 0;
    h.delivery = h.open({sendWa: async () => { calls++; throw Error('timeout'); }});
    h.delivery.enqueue(a); await h.delivery.tick(); await h.delivery.tick(); assert.equal(calls, 1);
    assert.equal(h.delivery.forItem(a).notificationStatus.wa, 'uncertain');
    const disk = JSON.parse(fs.readFileSync(h.filePath)); disk.events[0].channels.wa = 'sending'; fs.writeFileSync(h.filePath, JSON.stringify(disk));
    h.delivery = h.open(); await h.delivery.tick(); assert.equal(h.wa.length, 0);
    assert.equal(h.delivery.forItem(a).notificationStatus.wa, 'uncertain');
});

test('overlapping ticks cannot send the same event twice', async t => {
    const h = harness(t); let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
    h.delivery = h.open({sendWa: async () => { calls++; await gate; }}); h.delivery.enqueue(h.add('a'));
    const first = h.delivery.tick(); await h.delivery.tick(); release(); await first; assert.equal(calls, 1);
});

test('reconnecting delivers the newest recap instead of stale notices for the same contact', async t => {
    const h = harness(t, {channels: ['wa', 'mobile']}); h.online = false;
    const first = h.add('first'); h.delivery.enqueue(first); await h.delivery.tick();
    const next = h.add('next', {chatId: first.chatId, secretarySummary: 'revised request'});
    h.delivery.enqueue(next); await h.delivery.tick();
    assert.equal(h.delivery.notifications().length, 1);
    h.online = true; await h.delivery.tick();
    assert.equal(h.wa.length, 1); assert.match(h.wa[0].text, /revised request/);
});

test('changing destinations during a send prevents the next deselected channel from sending', async t => {
    const h = harness(t, {channels: ['wa', 'hud']});
    h.delivery = h.open({sendWa: async () => { h.settings.notifications.channels = ['wa']; }});
    h.delivery.enqueue(h.add('a')); await h.delivery.tick(); assert.equal(h.hud.length, 0);
});

test('reconnecting and phone polling respect quiet hours for previously ready events', async t => {
    const h = harness(t, {channels: ['wa', 'hud', 'mobile'], quiet_enabled: true});
    h.online = false;
    h.delivery.enqueue(h.add('a')); await h.delivery.tick();
    assert.equal(h.delivery.notifications().length, 1);
    h.time = Date.parse('2026-09-25T16:00:00Z'); h.online = true;
    await h.delivery.tick();
    assert.equal(h.wa.length + h.hud.length, 0);
    assert.equal(h.delivery.notifications().length, 0);
    h.time = Date.parse('2026-09-26T00:00:00Z'); await h.delivery.tick();
    assert.equal(h.wa.length, 1); assert.equal(h.hud.length, 1);
    assert.equal(h.delivery.notifications().length, 1);
});

test('ready urgent events and explicit reminders can bypass quiet hours after reconnect', async t => {
    const h = harness(t, {channels: ['wa', 'mobile'], quiet_enabled: true});
    h.online = false;
    const a = h.add('a', {priority: 'high'}), b = h.add('b');
    h.delivery.enqueue(a); await h.delivery.tick();
    h.time = Date.parse('2026-09-25T16:00:00Z');
    h.delivery.remind(b.id, new Date(h.time + 1000).toISOString()); h.time += 1000;
    h.online = true; await h.delivery.tick();
    assert.equal(h.wa.length, 2); assert.equal(h.delivery.notifications().length, 2);
    assert.deepEqual(h.wa.map(e => e.kind), ['message', 'reminder']);
});

test('promotions in enforce mode stay quiet, while an explicit owner reminder is allowed', async t => {
    const h = harness(t); const item = h.add('a', {category: 'promotion', triageMode: 'enforce'});
    h.delivery.enqueue(item); await h.delivery.tick(); assert.equal(h.wa.length, 0);
    h.delivery.remind(item.id, new Date(h.time + 1000).toISOString()); h.time += 1000;
    await h.delivery.tick(); assert.equal(h.wa.length, 1); assert.equal(h.wa[0].kind, 'reminder');
});

test('storage failure prevents sending and a corrupt ledger never silently resets', async t => {
    const h = harness(t); const d = h.open({persist: () => { throw Error('disk full'); }});
    assert.throws(() => d.enqueue(h.add('a'))); await assert.rejects(d.tick()); assert.equal(h.wa.length, 0);
    fs.writeFileSync(h.filePath, '{broken'); assert.throws(() => h.open());
});
