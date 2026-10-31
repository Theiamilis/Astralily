// Owner-reviewed replies. Persist the sending claim before touching WhatsApp.
const { randomUUID } = require('crypto');
const { inboxSummary, needsAttention } = require('./inbox-summary');
function createInboxReview({ items, save, allowed, canReply = allowed, generate, send, handoff, now = Date.now }) {
    const locks = new Set();
    const pendingIncoming = new Map();
    function latest() {
        const seen = new Set();
        return items.filter(item => { if (seen.has(item.chatId)) return false; seen.add(item.chatId); return allowed(item.chatId); });
    }
    function current(id) {
        const item = latest().find(item => item.id === id);
        if (!item) throw new Error('Conversation changed or is excluded. Reload the inbox.');
        if (pendingIncoming.has(item.chatId)) throw new Error('A new message is being processed. Refresh shortly.');
        return item;
    }
    async function locked(id, action) {
        const item = current(id);
        if (locks.has(item.chatId)) throw new Error('This conversation is busy.');
        locks.add(item.chatId);
        try { return await action(item); } finally { locks.delete(item.chatId); }
    }
    return {
        list() { return latest().map(item => ({ id: item.id, name: item.name, phoneNumber: item.phoneNumber,
            summary: inboxSummary(item), message: item.originalMessage, createdAt: item.createdAt,
            category: item.category || 'uncertain', detectedCategory: item.detectedCategory || item.category || 'uncertain',
            detectedReason: item.detectedReason || item.policyReason || 'unknown',
            categorySource: item.categorySource || 'rule', confidence: item.confidence || 'low',
            policyReason: item.policyReason || 'unknown', triageMode: item.triageMode || 'shadow',
            secretaryReply: item.secretaryReply || '', secretaryRepliedAt: item.secretaryRepliedAt || '',
            needsOwner: needsAttention(item),
            canReply: Boolean(canReply(item.chatId)), processing: pendingIncoming.has(item.chatId),
            status: item.review?.status || 'pending', draft: item.review?.text || '', revision: item.review?.revision || '' })); },
        draft(id) { return locked(id, async item => {
            if (!canReply(item.chatId)) throw new Error('Contact rules do not allow replies.');
            if (['sending', 'uncertain', 'sent'].includes(item.review?.status)) throw new Error('Check delivery in WhatsApp before continuing.');
            const before = item.review?.revision;
            handoff(item.chatId);
            const result = await generate(item);
            current(id);
            if (before !== item.review?.revision) throw new Error('Conversation changed while drafting. Reload.');
            const text = String(result.reply || '').trim().slice(0, 2000);
            if (!text) throw new Error('No draft was generated.');
            if (!canReply(item.chatId)) throw new Error('Contact rules changed. Reload.');
            item.review = { status: 'draft', text, revision: randomUUID(), at: now() };
            save(); return item.review;
        }); },
        approve(id, revision, text) { return locked(id, async item => {
            if (!canReply(item.chatId)) throw new Error('Contact rules do not allow replies.');
            if (!revision || item.review?.revision !== revision || item.review.status !== 'draft') throw new Error('Draft changed or was already submitted. Reload.');
            if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Reply must contain 1–2000 characters.');
            if (now() - item.review.at > 15 * 60000) throw new Error('Draft expired. Generate a fresh draft.');
            handoff(item.chatId);
            current(id);
            item.review = { ...item.review, text: text.trim(), status: 'sending' }; save();
            try { await send(item.chatId, item.review.text); item.review.status = 'sent'; }
            catch { item.review.status = 'uncertain'; save(); throw new Error('Delivery is uncertain. Check WhatsApp; this reply will not be retried.'); }
            save(); return item.review;
        }); },
        resolve(id) { return locked(id, async item => {
            if (['sending', 'uncertain'].includes(item.review?.status)) throw new Error('Check uncertain delivery in WhatsApp first.');
            item.review = { status: 'resolved', revision: randomUUID(), at: now() }; save(); return item.review;
        }); },
        correct(id, category) { return locked(id, async item => {
            if (!['personal', 'promotion', 'delivery', 'sensitive_delivery', 'uncertain'].includes(category))
                throw new Error('Unknown category.');
            handoff(item.chatId);
            if (!item.detectedCategory) item.detectedCategory = item.category || 'uncertain';
            if (!item.detectedReason) item.detectedReason = item.policyReason || 'unknown';
            item.category = category;
            item.categorySource = 'owner';
            item.correctedAt = now();
            // Corrections are labels for review; they never trigger a delayed auto-reply.
            item.policyDecision = 'hold';
            item.policyReason = 'owner_correction';
            save(); return {category, categorySource: item.categorySource};
        }); },
        ownerReplied(chatId) {
            const item = items.find(item => item.chatId === chatId);
            if (item && !['sending', 'sent', 'uncertain'].includes(item.review?.status)) {
                item.review = { status: 'resolved', revision: randomUUID(), at: now() }; save();
            }
        },
        incoming(chatId) {
            const item = items.find(item => item.chatId === chatId);
            if (!item) return;
            pendingIncoming.set(chatId, randomUUID());
            if (pendingIncoming.size > 100) pendingIncoming.delete(pendingIncoming.keys().next().value);
            if (item && !['sending', 'uncertain'].includes(item.review?.status)) {
                item.review = { status: 'stale', revision: randomUUID(), at: now() }; save();
            }
        },
        captureVersion(chatId) { return pendingIncoming.get(chatId); },
        captured(chatId, version) { if (pendingIncoming.get(chatId) === version) pendingIncoming.delete(chatId); },
    };
}
module.exports = { createInboxReview };
