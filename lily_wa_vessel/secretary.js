const fs = require('fs');
const { atomicWriteJson } = require('./wa_policy');

const MODES = new Set(['off', 'shadow', 'active', 'auto']);
const BUSY = new Set(['busy', 'at_office', 'sleeping', 'gaming', 'away']);
const SEND_WINDOW_MS = 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 90 * 1000;
const NO_REPLY = /^(?:(?:tolong|please)\s+)?(?:(?:jangan|(?:gak|nggak|ga|gk|ngga|tidak|tak)\s+(?:usah|perlu))\s+(?:di\s*)?(?:balas|bales|jawab)|(?:do not|don't|dont)\s+(?:reply|respond)|no\s+(?:reply|response)\s+needed)(?:\s|[,.!?]|$)/i;
const CLAIMS_FORWARDING = /(?:\b(?:aku|lily|kami)\b.{0,35}\b(?:sudah|akan|nanti|telah)\b.{0,20}\b(?:sampaikan|teruskan|kirim|forward)\b|\b(?:sudah|telah)\b.{0,12}\b(?:aku|lily|kami)\b.{0,20}\b(?:sampaikan|teruskan|kirim|forward)\b|\b(?:pesan(?:mu|nya)?|message)\b.{0,25}\b(?:sudah|telah|has been)\b.{0,15}\b(?:disampaikan|diteruskan|dikirim|forwarded|sent)\b|\bi\s+(?:will|have)\s+(?:passed|pass|forwarded|forward|sent|send)\b)/i;
const SECRETARY_SIGNATURE = '\n\n~ Lily';

function signSecretaryReply(value) {
    const body = String(value || '').trim().replace(/\s*~\s*Lily\s*$/i, '').trimEnd();
    if (!body) return '';
    return `${body.slice(0, 700 - SECRETARY_SIGNATURE.length).trimEnd()}${SECRETARY_SIGNATURE}`;
}

function parseSecretaryCommand(message) {
    const text = String(message || '').trim().toLowerCase().replace(/[.!]+$/, '')
        .replace(/^lily[,\s]+/, '').replace(/^\//, '').replace(/\s+/g, ' ');
    let match = text.match(/^(?:mode )?(?:secretary|sekretaris)(?: mode)? (on|off|auto|status|aktif|mati|otomatis)$/);
    if (!match) {
        match = text.match(/^(aktifkan|aktifin|nyalain|matikan|matiin|stop) (?:mode )?(?:secretary|sekretaris)$/);
        if (!match) return null;
    }
    const value = match[1];
    const mode = ['on', 'aktif', 'aktifkan', 'aktifin', 'nyalain'].includes(value) ? 'active'
        : ['off', 'mati', 'matikan', 'matiin', 'stop'].includes(value) ? 'off'
        : ['auto', 'otomatis'].includes(value) ? 'auto' : 'status';
    return { type: 'secretary_mode', mode };
}

function createSecretary(options) {
    const now = options.now || Date.now;
    const schedule = options.schedule || setTimeout;
    const cancel = options.cancel || clearTimeout;
    let delay = options.delayMs ?? 60000;
    let followupDelay = options.followupDelayMs ?? 8000;
    let cooldown = options.cooldownMs ?? 1800000;
    let windowMs = 15 * 60000;
    let maxReplies = 6;
    let perContactSendLimit = 6;
    let globalSendLimit = 30;
    let summaryDelay = 30000;
    const pending = new Map();
    const generations = new Map();
    const ownReplies = new Map();
    const summaryTimers = new Map();
    const inFlight = new Set();
    let providerFailures = 0;
    let providerOpenUntil = 0;
    let state;
    try { state = JSON.parse(fs.readFileSync(options.filePath, 'utf8')); } catch { state = {}; }
    state.mode = MODES.has(state.mode) ? state.mode : (MODES.has(options.initialMode) ? options.initialMode : 'shadow');
    state.last_reply_at = state.last_reply_at || {};
    state.threads = state.threads || {};
    state.send_attempts = Array.isArray(state.send_attempts) ? state.send_attempts.filter(attempt =>
        attempt && typeof attempt.chat_id === 'string' && Number.isFinite(Number(attempt.at))
        && ['reserved', 'sent', 'uncertain'].includes(attempt.status)).map(attempt =>
        attempt.status === 'reserved' ? { ...attempt, status: 'uncertain' } : attempt) : [];
    let lastRateLimitedScope = null;
    let lastRateLimitedAt = null;

    function pruneSendAttempts() {
        state.send_attempts = state.send_attempts.filter(attempt => now() - Number(attempt.at) < SEND_WINDOW_MS)
            .slice(-500);
    }

    function sendBudget(chatId) {
        pruneSendAttempts();
        const contactCount = state.send_attempts.filter(attempt => attempt.chat_id === chatId).length;
        return { contactCount, globalCount: state.send_attempts.length };
    }

    function reserveSend(chatId) {
        const budget = sendBudget(chatId);
        if (budget.contactCount >= perContactSendLimit) {
            lastRateLimitedScope = 'contact';
            lastRateLimitedAt = now();
            return null;
        }
        if (budget.globalCount >= globalSendLimit) {
            lastRateLimitedScope = 'global';
            lastRateLimitedAt = now();
            return null;
        }
        const attempt = { chat_id: chatId, at: now(), status: 'reserved' };
        state.send_attempts.push(attempt);
        save();
        return attempt;
    }

    function releaseSend(attempt) {
        const index = state.send_attempts.indexOf(attempt);
        if (index >= 0) state.send_attempts.splice(index, 1);
        save();
    }

    function finishSend(attempt, status) {
        attempt.status = status;
        save();
    }

    function normalizeMessage(value) {
        return String(value || '').normalize('NFKC').toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    function isRecentDuplicate(current, message) {
        const normalized = normalizeMessage(message);
        if (!normalized) return false;
        for (let index = current.history.length - 1; index >= 0; index -= 1) {
            const turn = current.history[index];
            if (!Number.isFinite(Number(turn.at)) || now() - Number(turn.at) > DUPLICATE_WINDOW_MS) continue;
            if ((turn.role === 'contact' || turn.role === 'lily') && normalizeMessage(turn.text) === normalized) return true;
            if (turn.role === 'contact') break;
        }
        return false;
    }

    function save() {
        const recent = Object.entries(state.threads).filter(([, t]) => now() - Number(t.updated_at || 0) < 86400000)
            .sort((a, b) => b[1].updated_at - a[1].updated_at).slice(0, 100);
        state.threads = Object.fromEntries(recent);
        atomicWriteJson(options.filePath, state);
    }
    function enabled() {
        return options.personal !== false && (!options.configurationFresh || options.configurationFresh()) && (state.mode === 'active'
            || (state.mode === 'auto' && BUSY.has(options.getPresence()?.status)));
    }
    function stop(chatId) {
        const item = pending.get(chatId);
        if (item?.timer) cancel(item.timer);
        pending.delete(chatId);
        generations.set(chatId, (generations.get(chatId) || 0) + 1);
    }
    function thread(chatId) {
        let value = state.threads[chatId];
        if (!value || now() - Number(value.updated_at || 0) > windowMs) {
            value = { history: [], turns: 0, updated_at: now(), handoff_until: Number(value?.handoff_until || 0) };
            state.threads[chatId] = value;
        }
        return value;
    }
    function eligible(chatId) {
        return enabled() && options.allowed(chatId) && Number(thread(chatId).handoff_until || 0) <= now();
    }
    function recordSummary(chatId, value, details) {
        if (summaryTimers.has(chatId)) cancel(summaryTimers.get(chatId));
        const timer = schedule(() => {
            summaryTimers.delete(chatId);
            Promise.resolve(options.onSummary(chatId, value, details)).catch(() => {});
        }, value.needs_owner ? 1000 : summaryDelay);
        summaryTimers.set(chatId, timer);
    }
    async function flush(chatId) {
        if (inFlight.has(chatId)) return;
        const item = pending.get(chatId);
        if (!item) return;
        if (item.timer) cancel(item.timer);
        pending.delete(chatId);
        if (!eligible(chatId)) return;
        const current = thread(chatId);
        const generation = generations.get(chatId) || 0;
        const valid = () => eligible(chatId) && generation === (generations.get(chatId) || 0) && !pending.has(chatId);
        const retainUnanswered = () => {
            const next = pending.get(chatId);
            if (next && eligible(chatId) && generation === (generations.get(chatId) || 0)) {
                next.message = [item.message, next.message].join('\n').slice(-2400);
            }
        };
        inFlight.add(chatId);
        let sendAttempt = null;
        let deliveryStarted = false;
        let deliveryConfirmed = false;
        try {
            let result;
            const request = { message: item.message.slice(-2400), history: current.history.slice(-12),
                introduced: Boolean(item.details.introduced || current.turns),
                contact_name: item.details.name || 'Contact', owner_name: options.ownerName,
                owner_busy: BUSY.has(options.getPresence()?.status), language: item.details.language || 'id' };
            try {
                const silent = NO_REPLY.test(request.message.trim());
                if (silent) result = { reply: '', summary: '', needs_owner: false };
                else {
                    if (providerOpenUntil > now()) throw new Error('Secretary provider cooling down');
                    result = await options.generate(request);
                }
                if (!result || typeof result.reply !== 'string' || typeof result.summary !== 'string'
                    || typeof result.needs_owner !== 'boolean' || result.reply.length > 700 || result.summary.length > 500
                    || (!result.summary.trim() && result.reply.trim())) throw new Error('Invalid secretary result');
                if (!silent) providerFailures = 0;
            } catch {
                providerFailures += 1;
                if (providerFailures >= 3) providerOpenUntil = now() + 60000;
                result = { reply: '', summary: `Secretary reply unavailable; owner review needed. Message: ${item.message.slice(0, 420)}`,
                    needs_owner: true };
            }
            if (!valid()) { retainUnanswered(); return; }
            if (!result || typeof result.reply !== 'string') return;
            if (!result.reply.trim()) {
                current.history.push({ role: 'contact', text: item.message.slice(-2400), at: now() });
                current.history = current.history.slice(-12);
                current.updated_at = now();
                save();
                if (result.needs_owner) recordSummary(chatId, result, item.details);
                return;
            }
            if (CLAIMS_FORWARDING.test(result.reply)) {
                recordSummary(chatId, { summary: 'Reply draft claimed unverified forwarding; owner review needed.', needs_owner: true }, item.details);
                return;
            }
            const reply = signSecretaryReply(result.reply);
            sendAttempt = reserveSend(chatId);
            if (!sendAttempt) {
                recordSummary(chatId, { summary: `Automatic reply held by the ${lastRateLimitedScope} hourly send limit; owner review needed.`, needs_owner: true }, item.details);
                return;
            }
            // Mark before awaiting send: whatsapp-web.js can emit message_create first.
            ownReplies.set(chatId, { text: reply, expires: now() + 60000 });
            deliveryStarted = true;
            const sent = await options.send(chatId, reply, valid);
            deliveryStarted = false;
            if (sent === false) { ownReplies.delete(chatId); releaseSend(sendAttempt); sendAttempt = null; retainUnanswered(); return; }
            deliveryConfirmed = true;
            finishSend(sendAttempt, 'sent');
            sendAttempt = null;
            const sentAt = now();
            current.history.push({ role: 'contact', text: item.message.slice(-2400), at: sentAt }, { role: 'lily', text: reply, at: sentAt });
            current.history = current.history.slice(-12);
            current.turns += 1;
            current.updated_at = now();
            state.last_reply_at[chatId] = now();
            save();
            if (options.onReply) options.onReply(chatId, { ...result, reply }, item.details);
            recordSummary(chatId, result, item.details);
        } catch {
            // Do not retry an uncertain send; WhatsApp may already have delivered it.
            if (sendAttempt) {
                if (deliveryStarted) finishSend(sendAttempt, 'uncertain');
                else if (!deliveryConfirmed) releaseSend(sendAttempt);
            }
            current.handoff_until = now() + cooldown;
            current.updated_at = now();
            save();
            recordSummary(chatId, { summary: item.message.slice(0, 500), needs_owner: true }, item.details);
        } finally {
            inFlight.delete(chatId);
            if (pending.has(chatId)) {
                const next = pending.get(chatId);
                if (next.timer) cancel(next.timer);
                next.timer = schedule(() => void flush(chatId), followupDelay);
            }
        }
    }
    return {
        enabled, eligible, flush,
        mode: () => state.mode,
        runtimeStatus: () => {
            const budget = sendBudget('');
            return { pending: pending.size, in_flight: inFlight.size,
            oldest_pending_ms: pending.size ? Math.max(...[...pending.values()].map(item => Math.max(0, now() - item.queuedAt))) : 0,
            provider_cooling_down: providerOpenUntil > now(), provider_failures: providerFailures,
            send_attempts_last_hour: budget.globalCount,
            uncertain_sends_last_hour: state.send_attempts.filter(attempt => attempt.status === 'uncertain').length,
            per_contact_send_limit_per_hour: perContactSendLimit,
            global_send_limit_per_hour: globalSendLimit,
            last_rate_limited_scope: lastRateLimitedScope,
            last_rate_limited_at: lastRateLimitedAt };
        },
        configure(settings) {
            delay = settings.first_reply_seconds * 1000;
            followupDelay = settings.followup_seconds * 1000;
            cooldown = settings.handoff_minutes * 60000;
            windowMs = settings.conversation_minutes * 60000;
            maxReplies = settings.max_replies;
            perContactSendLimit = settings.per_contact_send_limit_per_hour || 6;
            globalSendLimit = settings.global_send_limit_per_hour || 30;
            summaryDelay = settings.summary_delay_seconds * 1000;
            this.setMode(settings.mode);
        },
        setMode(mode) {
            if (!MODES.has(mode)) throw new Error('Unknown secretary mode');
            state.mode = mode;
            for (const chatId of new Set([...pending.keys(), ...inFlight])) stop(chatId);
            save();
        },
        presenceChanged() {
            if (!enabled()) for (const chatId of new Set([...pending.keys(), ...inFlight])) stop(chatId);
        },
        ownerReplied(chatId) {
            stop(chatId);
            const current = thread(chatId);
            current.handoff_until = now() + cooldown;
            current.updated_at = now();
            save();
        },
        isOwnReply(chatId, text) {
            const value = ownReplies.get(chatId);
            if (!value || value.expires < now()) { ownReplies.delete(chatId); return false; }
            if (value.text !== String(text || '').trim()) return false;
            ownReplies.delete(chatId);
            return true;
        },
        receive(chatId, message, details = {}) {
            if (details.decision !== 'routine' || !eligible(chatId)) { stop(chatId); return false; }
            const current = thread(chatId);
            if (isRecentDuplicate(current, message)) {
                recordSummary(chatId, { summary: 'Repeated or echoed message held to prevent a reply loop; owner review needed.', needs_owner: true }, details);
                return true;
            }
            const last = Number(state.last_reply_at[chatId] || 0);
            if (current.turns >= maxReplies || (!current.turns && last && now() - last < cooldown)) {
                recordSummary(chatId, { summary: message.slice(0, 500), needs_owner: true }, details);
                return true;
            }
            const previous = pending.get(chatId);
            if (previous?.timer) cancel(previous.timer);
            const item = { message: [previous?.message, message].filter(Boolean).join('\n').slice(-2400), details,
                queuedAt: previous?.queuedAt || now() };
            pending.set(chatId, item);
            item.timer = schedule(() => void flush(chatId), current.turns ? followupDelay : delay);
            return true;
        },
    };
}

module.exports = { createSecretary, parseSecretaryCommand };
