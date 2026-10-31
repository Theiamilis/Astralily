const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function normalizeInternationalNumber(value, defaultCountryCode = '62') {
    let digits = (value || '').toString().replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && defaultCountryCode) digits = `${defaultCountryCode}${digits.slice(1)}`;
    return digits.length >= 8 && digits.length <= 16 ? digits : '';
}

function verifiedDirectPhoneNumber(chatId, contact = null, additionalIdentities = [], knownPhone = '') {
    const directId = String(chatId || '').trim();
    const lidNumber = /@lid$/i.test(directId)
        ? normalizeInternationalNumber(directId.split('@')[0]) : '';
    const candidates = [
        ...additionalIdentities.filter((identity) =>
            /^\+?\d+(?:@(c\.us|s\.whatsapp\.net))?$/i.test(String(identity || ''))),
        contact?.id?._serialized,
        directId,
        contact?.number,
        knownPhone,
    ];
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!/^\+?\d+(?:@(c\.us|s\.whatsapp\.net))?$/i.test(value)) continue;
        const number = normalizeInternationalNumber(value.split('@')[0]);
        if (number && number !== lidNumber) return number;
    }
    return '';
}

function defaultPolicy() {
    return { version: 1, circle: [], secretary_never_reply: [], updated_at: null };
}

function loadContactPolicy(filePath) {
    try {
        if (!fs.existsSync(filePath)) return defaultPolicy();
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const policy = defaultPolicy();
        for (const key of ['circle', 'secretary_never_reply']) {
            policy[key] = [...new Set((Array.isArray(parsed[key]) ? parsed[key] : [])
                .map((item) => normalizeInternationalNumber(item)).filter(Boolean))];
        }
        policy.updated_at = parsed.updated_at || null;
        return policy;
    } catch (error) {
        console.error('Failed to load WhatsApp contact policy:', error);
        return defaultPolicy();
    }
}

function createContactPolicyStore(filePath) {
    let policy = loadContactPolicy(filePath);
    const listName = (scope) => scope === 'circle' ? 'circle' : 'secretary_never_reply';
    const refresh = () => { policy = loadContactPolicy(filePath); };
    const save = () => {
        policy.updated_at = new Date().toISOString();
        atomicWriteJson(filePath, policy);
    };
    return {
        snapshot() { refresh(); return JSON.parse(JSON.stringify(policy)); },
        has(scope, value) {
            refresh();
            const number = normalizeInternationalNumber(value);
            return Boolean(number && policy[listName(scope)].includes(number));
        },
        add(scope, value) {
            refresh();
            const number = normalizeInternationalNumber(value);
            if (!number) return { ok: false, changed: false, number: '' };
            const key = listName(scope);
            if (policy[key].includes(number)) return { ok: true, changed: false, number };
            policy[key].push(number);
            policy[key].sort();
            save();
            return { ok: true, changed: true, number };
        },
        remove(scope, value) {
            refresh();
            const number = normalizeInternationalNumber(value);
            if (!number) return { ok: false, changed: false, number: '' };
            const key = listName(scope);
            const before = policy[key].length;
            policy[key] = policy[key].filter((item) => item !== number);
            if (policy[key].length !== before) save();
            return { ok: true, changed: policy[key].length !== before, number };
        },
    };
}

const SENSITIVE_RULES = [
    ['money', /\b(uang|duit|transfer|bayar|payment|invoice|tagihan|rekening|bank|pinjam|utang|harga|dp|deposit|refund)\b/i],
    ['otp', /\b(otp|one[ -]?time password|kode verifikasi|verification code|pin|password|kata sandi)\b/i],
    ['private_data', /\b(ktp|nik|passport|paspor|alamat lengkap|nomor kartu|cvv|data pribadi)\b/i],
    ['commitment', /\b(janji|deal|setuju|kontrak|tanda tangan|appointment|jadwal pasti|komitmen)\b/i],
    ['conflict', /\b(marah|bohong|selingkuh|masalah|ribut|lapor|ancam|kecewa|konflik)\b/i],
    ['legal', /\b(pengacara|polisi|somasi|hukum|legal|gugatan|sidang|pengadilan)\b/i],
];
const PROMO_RULES = [
    /\b(promo|diskon|sale|cashback|voucher|reseller|dropship|penawaran|flash sale|harga spesial|discount|coupon|special offer)\b/i,
    /\b(beli sekarang|order sekarang|limited offer|stok terbatas|gratis ongkir|klik link|buy now|shop now|limited time|free shipping)\b/i,
    /https?:\/\/(?:bit\.ly|s\.id|wa\.me|shopee\.|tokopedia\.|lazada\.|tiktok\.com\/)/i,
];
const DELIVERY_CONTEXT = /\b(paket|kiriman|pengiriman|kurir|resi|awb|parcel|package|shipment|delivery|pesanan|orderan|ekspedisi)\b/i;
const DELIVERY_STATUS = /\b(diantar|antar|dikirim|dalam perjalanan|gagal antar|diterima|sampai|tiba|pickup|ambil paket|out for delivery|delivered|failed delivery|arriving|shipped|delayed|attempted|ready for pickup|tracking|patokan|alamat pengiriman|jadwal ulang|reschedule)\b/i;
const DELIVERY_RISK = /\b(otp|kode verifikasi|pin|password|bayar|transfer|pembayaran|biaya tambahan|bea cukai|customs fee|ubah alamat|ganti alamat|change address|payment|pay now|cod)\b|https?:\/\/\S+/i;
const JP_DELIVERY_CONTEXT = /荷物|配送|配達|発送|宅配|注文/;
const JP_DELIVERY_STATUS = /配達中|お届け|発送済|再配達|到着|受け取り|追跡|持ち戻り/;
const JP_DELIVERY_RISK = /支払い|認証コード|住所変更|着払い/;
const JP_PROMO_RULES = [/割引|セール|クーポン/, /今すぐ購入|期間限定|送料無料|購入はこちら/];
const CLOSING_MESSAGES = /^(?:(?:ok|oke|okeh|okh|okay|sip|siap|iya|ya|yap|noted|mantap)(?:\s+(?:aman(?:\s+aja)?|aja|ya|yah))?|(?:nanti\s+(?:ku\s*kabari|aku\s+kabari|kabarin)|ku\s*kabari)(?:\s+(?:ya|yah))?|tunggu\s+hari\s+h\s+aja|(?:(?:oke|okeh|sip|siap)\s+)?(?:makasih|terima\s+kasih|thanks|thank\s+you)(?:\s+(?:ya|yah|lily))?)[.!\s]*$/i;

function classifyIncomingMessage(text, metadata = {}) {
    const message = (text || '').toString().trim();
    if (!message || /^\[(?:voice message|document attachment|sticker)\]\.?$/i.test(message)) {
        return { category: 'uncertain', confidence: 'low', decision: 'hold', reason: 'unreadable_content', priority: 'normal' };
    }
    const deliveryContext = DELIVERY_CONTEXT.test(message) || JP_DELIVERY_CONTEXT.test(message);
    const deliveryStatus = DELIVERY_STATUS.test(message) || JP_DELIVERY_STATUS.test(message);
    if (deliveryContext && (DELIVERY_RISK.test(message) || JP_DELIVERY_RISK.test(message))) {
        return { category: 'sensitive_delivery', confidence: 'high', decision: 'hold', reason: 'delivery_action_or_link', priority: 'high' };
    }
    if (deliveryContext && deliveryStatus) {
        return { category: 'delivery', confidence: 'high', decision: 'hold', reason: 'delivery_update', priority: 'high' };
    }
    for (const [reason, pattern] of SENSITIVE_RULES) {
        if (pattern.test(message)) return { category: 'uncertain', confidence: 'high', decision: 'hold', reason, priority: 'high' };
    }
    const promoSignals = [...PROMO_RULES, ...JP_PROMO_RULES].reduce((count, pattern) => count + (pattern.test(message) ? 1 : 0), 0);
    const forwarded = Boolean(metadata.isForwarded) || Number(metadata.forwardingScore || 0) > 0;
    const textLinks = message.match(/https?:\/\/[^\s]+/gi) || [];
    const metadataLinks = Array.isArray(metadata.links) ? metadata.links : [];
    const commercialLinks = [...metadataLinks, ...textLinks].some((link) => {
        const linkValue = typeof link === 'string' ? link : (link?.link || link?.url || '');
        return /(?:shopee|tokopedia|lazada|wa\.me|bit\.ly|s\.id)/i.test(String(linkValue));
    });
    if (promoSignals >= 2 && !deliveryContext && !deliveryStatus) {
        return { category: 'promotion', confidence: 'high', decision: 'quarantine', reason: 'clear_promotion', priority: 'normal' };
    }
    if (deliveryContext || deliveryStatus || forwarded || promoSignals === 1 || commercialLinks) {
        return { category: 'uncertain', confidence: 'low', decision: 'hold', reason: 'ambiguous_message', priority: 'normal' };
    }
    if (CLOSING_MESSAGES.test(message)) {
        return { category: 'personal', confidence: 'high', decision: 'no_reply', reason: 'conversation_closure', priority: 'normal' };
    }
    return { category: 'personal', confidence: 'high', decision: 'routine', reason: 'routine', priority: 'normal' };
}

function decideTriageRoute(classification, triageMode, explicitAction, effectiveAction = explicitAction || 'secretary') {
    const quietNotification = triageMode === 'enforce'
        && classification.category === 'promotion'
        && classification.confidence === 'high'
        && !explicitAction;
    return { quietNotification, allowAutomaticReply:
        classification.decision === 'routine' && effectiveAction === 'secretary' };
}

function buildSecretaryAcknowledgement(language, ownerName, introduced) {
    if (language === 'en') {
        return introduced
            ? `${ownerName} cannot reply right now. I have saved your message and will pass it along.`
            : `Hi, I am Lily, ${ownerName}'s assistant. ${ownerName} cannot reply right now, but I have saved your message and will pass it along.`;
    }
    return introduced
        ? `${ownerName} belum bisa membalas sekarang. Pesanmu sudah Lily simpan dan nanti Lily sampaikan.`
        : `Hai, aku Lily, asistennya ${ownerName}. ${ownerName} belum bisa membalas sekarang, tapi pesanmu sudah Lily simpan dan nanti Lily sampaikan.`;
}

module.exports = {
    atomicWriteJson,
    buildSecretaryAcknowledgement,
    classifyIncomingMessage,
    decideTriageRoute,
    createContactPolicyStore,
    loadContactPolicy,
    normalizeInternationalNumber,
    verifiedDirectPhoneNumber,
};
