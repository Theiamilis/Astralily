// One projection shared by review, dashboard, and every notification channel.
function inboxSummary(item) {
    return String(item?.secretarySummary || item?.summary || item?.originalMessage || '').trim().slice(0, 500);
}
function needsAttention(item) {
    return Boolean(item?.secretaryNeedsOwner || item?.priority === 'high' || item?.policyDecision === 'hold');
}
function isUrgent(item) {
    return Boolean(item?.secretaryNeedsOwner || item?.priority === 'high'
        || ['delivery', 'sensitive_delivery'].includes(item?.category));
}
module.exports = { inboxSummary, needsAttention, isUrgent };
