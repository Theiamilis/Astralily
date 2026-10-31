// Durable owner notifications and chat reminders. This module never replies to contacts.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { atomicWriteJson } = require('./wa_policy');
const { inboxSummary, isUrgent } = require('./inbox-summary');
const DAY = 86400000;
const DEFAULTS = { channels: ['wa'], mode: 'immediate', digest_minutes: 15,
    quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00', timezone: 'Asia/Jakarta', urgent_immediate: true };

function quietNow(settings, now) {
    if (!settings.quiet_enabled || settings.quiet_start === settings.quiet_end) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone,
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
    const { quiet_start: start, quiet_end: end } = settings;
    return start < end ? parts >= start && parts < end : parts >= start || parts < end;
}

function createInboxDelivery({ filePath, items, settings, allowed, sendWa, sendHud,
    ready = () => true, now = Date.now, persist = value => atomicWriteJson(filePath, value) }) {
    let state = { pending: {}, reminders: {}, events: [] }, running = false;
    if (filePath && fs.existsSync(filePath)) {
        // Do not silently reset a corrupt ledger: that could repeat a delivery.
        state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!state.pending || !state.reminders || !Array.isArray(state.events)) throw Error('Invalid inbox delivery ledger');
    }
    for (const event of state.events) for (const channel of Object.keys(event.channels)) {
        if (event.channels[channel] === 'sending') event.channels[channel] = 'uncertain';
    }
    const save = () => persist(state);
    const latest = chatId => items().find(item => item.chatId === chatId);
    const visible = item => item && allowed(item.chatId) && !['resolved', 'sent'].includes(item.review?.status);
    const config = () => {
        const value = settings();
        if (!value) return null;
        const result = { ...DEFAULTS, ...value.notifications };
        if (!Array.isArray(result.channels) || !result.channels.length
            || result.channels.some(c => !['wa', 'hud', 'mobile'].includes(c))) return null;
        try { quietNow({ ...result, quiet_enabled: true }, now()); } catch { return null; }
        return result;
    };
    const eventItems = event => event.chatIds.map(latest).filter(item => {
        if (!visible(item)) return false;
        if (event.kind === 'reminder') return true;
        if (item.category === 'promotion' && item.triageMode === 'enforce') return false;
        // A disconnected destination receives the newest recap, not a backlog per contact.
        const newer = state.events.slice(state.events.indexOf(event) + 1);
        return !newer.some(next => next.kind !== 'reminder' && next.chatIds.includes(item.chatId));
    });
    const quietHeld = (event, cfg) => event.kind !== 'reminder' && quietNow(cfg, now())
        && !(cfg.urgent_immediate && eventItems(event).every(isUrgent));
    function snapshotEvent(event) {
        const current = eventItems(event);
        const text = event.entries.filter(entry => current.some(item => item.chatId === entry.chatId))
            .map(entry => `${entry.name}: ${entry.summary}`).join('\n\n');
        return { id: event.id, itemId: current.length === 1 ? current[0].id : '', kind: event.kind,
            createdAt: new Date(event.at).toISOString(), title: event.kind === 'reminder' ? 'Chat reminder'
                : current.length > 1 ? `${current.length} conversations to catch up on` : 'Lily Inbox',
            text: (event.note ? `${event.note}\n\n${text}` : text).slice(0, 12000),
            channels: { ...event.channels } };
    }
    function record(current, kind, cfg, note = '') {
        const event = { id: randomUUID(), chatIds: current.map(item => item.chatId), kind, note,
            entries: current.map(item => ({chatId: item.chatId, itemId: item.id, name: String(item.name || 'Contact').slice(0, 100), summary: inboxSummary(item)})),
            at: now(), channels: Object.fromEntries([...new Set(cfg.channels)].map(c => [c, c === 'mobile' ? 'ready' : 'waiting'])) };
        state.events.push(event);
        return event;
    }
    async function tick() {
        if (running) return;
        running = true;
        try {
            const cfg = config();
            if (!cfg) return;
            state.events = state.events.filter(e => now() - e.at < 7 * DAY).slice(-200);
            const due = [];
            for (const [chatId, pending] of Object.entries(state.pending)) {
                const item = latest(chatId);
                if (!visible(item) || (item.category === 'promotion' && item.triageMode === 'enforce') || now() - pending.at > 7 * DAY) { delete state.pending[chatId]; continue; }
                const urgent = cfg.urgent_immediate && isUrgent(item);
                if (!urgent && (quietNow(cfg, now()) || (cfg.mode === 'digest' && now() - pending.at < cfg.digest_minutes * 60000))) continue;
                due.push(item); delete state.pending[chatId];
            }
            // Bound each digest so no channel has to cut away complete conversations.
            for (let offset = 0; offset < due.length; offset += 8) {
                record(due.slice(offset, offset + 8), due.length > 1 ? 'digest' : 'message', cfg);
            }
            for (const [chatId, reminder] of Object.entries(state.reminders)) {
                const item = latest(chatId);
                if (!visible(item)) { delete state.reminders[chatId]; continue; }
                if (reminder.status === 'scheduled' && reminder.dueAt <= now()) {
                    const event = record([item], 'reminder', cfg, reminder.note);
                    reminder.status = 'due'; reminder.eventId = event.id;
                }
            }
            save(); // Commit before any side effect; never replay an uncertain send.
            for (const event of state.events) {
                for (const channel of ['wa', 'hud']) {
                    if (event.channels[channel] !== 'waiting') continue;
                    const currentConfig = config();
                    if (!currentConfig) continue;
                    if (!currentConfig.channels.includes(channel) || !eventItems(event).length) {
                        event.channels[channel] = 'cancelled'; save(); continue;
                    }
                    if (quietHeld(event, currentConfig) || !ready(channel)) continue;
                    const payload = snapshotEvent(event);
                    event.channels[channel] = 'sending'; save();
                    try {
                        await (channel === 'wa' ? sendWa : sendHud)(payload);
                        // Core acknowledges publication, not display on a connected HUD.
                        event.channels[channel] = channel === 'hud' ? 'published' : 'sent';
                    } catch { event.channels[channel] = 'uncertain'; }
                    save();
                }
            }
        } finally { running = false; }
    }
    return {
        enqueue(item) {
            if (!visible(item)) return;
            if (state.events.some(event => event.kind !== 'reminder' && event.entries.some(entry =>
                entry.itemId === item.id && entry.summary === inboxSummary(item)))) return;
            state.pending[item.chatId] = { at: state.pending[item.chatId]?.at ?? now(), itemId: item.id };
            save();
        },
        remind(id, dueAt, note = '') {
            const item = items().find(i => i.id === id);
            const due = Date.parse(dueAt);
            if (!visible(item) || latest(item.chatId)?.id !== id) throw Error('Conversation changed or is handled. Refresh the inbox.');
            if (!Number.isFinite(due) || due <= now() || due > now() + 366 * DAY) throw Error('Choose a future reminder within one year.');
            if (typeof note !== 'string' || note.length > 300) throw Error('Reminder note is too long.');
            if (!state.reminders[item.chatId] && Object.keys(state.reminders).length >= 100) throw Error('Handle or cancel an existing reminder first (100 maximum).');
            for (const event of state.events.filter(e => e.kind === 'reminder' && e.chatIds.includes(item.chatId))) {
                for (const channel of Object.keys(event.channels)) if (['waiting', 'ready'].includes(event.channels[channel])) event.channels[channel] = 'cancelled';
            }
            state.reminders[item.chatId] = { dueAt: due, note: note.trim(), status: 'scheduled' };
            save(); return state.reminders[item.chatId];
        },
        cancel(id) {
            const item = items().find(i => i.id === id);
            if (!item) throw Error('Conversation is unavailable.');
            delete state.reminders[item.chatId];
            for (const event of state.events.filter(e => e.kind === 'reminder' && e.chatIds.includes(item.chatId))) {
                for (const channel of Object.keys(event.channels)) if (['waiting', 'ready'].includes(event.channels[channel])) event.channels[channel] = 'cancelled';
            }
            save(); return { cancelled: true };
        },
        forItem(item) {
            const events = state.events.filter(e => e.chatIds.includes(item.chatId));
            return { reminder: state.reminders[item.chatId] || null,
                notificationStatus: events.length ? { ...events[events.length - 1].channels } : {},
                notificationPending: Boolean(state.pending[item.chatId]) };
        },
        retainedChats() { return new Set([...Object.keys(state.reminders), ...Object.keys(state.pending)]); },
        notifications() {
            const cfg = config();
            if (!cfg?.channels.includes('mobile')) return [];
            return state.events.filter(e => e.channels.mobile === 'ready' && now() - e.at < 7 * DAY
                    && eventItems(e).length && !quietHeld(e, cfg))
                .map(snapshotEvent).reverse();
        },
        tick,
    };
}
module.exports = { createInboxDelivery, quietNow, DEFAULTS };
