require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const WA_PROFILE = (process.env.LILY_WA_PROFILE || 'personal').trim().toLowerCase();
if (!['personal', 'public'].includes(WA_PROFILE)) {
    throw new Error(`Invalid LILY_WA_PROFILE '${WA_PROFILE}'. Expected personal or public.`);
}
require('dotenv').config({ path: path.join(__dirname, `.env.${WA_PROFILE}`), override: true });
const { Client, LocalAuth } = require('whatsapp-web.js');
const { buildChromiumUserAgent, createNavigationResilientClient } = require('./wa_navigation');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createSecretary, parseSecretaryCommand } = require('./secretary');
const { createSecretaryConfig } = require('./secretary-config');
const { inboxSummary } = require('./inbox-summary');
const { createInboxDelivery } = require('./inbox-delivery');
const { verifyProfileIdentity } = require('./wa_profile');
const {
    atomicWriteJson,
    classifyIncomingMessage,
    decideTriageRoute,
    createContactPolicyStore,
    normalizeInternationalNumber,
    verifiedDirectPhoneNumber,
} = require('./wa_policy');

// Initialize Gemini API
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_API_KEY_PLACEHOLDER = ['YOUR', 'GEMINI', 'API', 'KEY'].join('_');
const genAI = GEMINI_API_KEY && GEMINI_API_KEY !== GEMINI_API_KEY_PLACEHOLDER
    ? new GoogleGenerativeAI(GEMINI_API_KEY)
    : null;
const GEMINI_ROUTER_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';
const LILY_CORE_URL = process.env.LILY_CORE_URL;
const LILY_OWNER_API_TOKEN = (process.env.LILY_OWNER_API_TOKEN || '').trim();
const LILY_CORE_ROUTER_URL = (
    process.env.LILY_CORE_ROUTER_URL
    || (LILY_CORE_URL ? `${LILY_CORE_URL.replace(/\/+$/, '')}/api/core/route-intent` : '')
).trim();
const IS_PERSONAL_PROFILE = WA_PROFILE === 'personal';
const IS_PUBLIC_PROFILE = WA_PROFILE === 'public';
const LILY_WA_PAIRING_NUMBER = (process.env.LILY_WA_PAIRING_NUMBER || '').replace(/\D/g, '');
const SECRETARY_MODE = (process.env.LILY_WA_SECRETARY_MODE || 'shadow').trim().toLowerCase();
const AUTO_REPLY_DELAY_MS = Math.max(1000, Number(process.env.LILY_WA_SECRETARY_DELAY_MS || 60 * 1000));
const AUTO_REPLY_COOLDOWN_MS = Math.max(1000, Number(process.env.LILY_WA_SECRETARY_COOLDOWN_MS || 30 * 60 * 1000));
const ALLOWED_TEST_NUMBER = process.env.ALLOWED_TEST_NUMBER || "";
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const PROFILE_RUNTIME_DIR = IS_PERSONAL_PROFILE ? RUNTIME_DIR : path.join(RUNTIME_DIR, WA_PROFILE);
const CONTACT_PROFILES_PATH = IS_PERSONAL_PROFILE ? path.join(__dirname, 'contact_profiles.json') : path.join(PROFILE_RUNTIME_DIR, 'contact_profiles.json');
const OWNER_MEMORY_PATH = path.join(__dirname, 'owner_memory.json');
const OWNER_PRESENCE_PATH = path.join(__dirname, 'owner_presence.json');
const EXTERNAL_INBOX_PATH = IS_PERSONAL_PROFILE ? path.join(__dirname, 'external_inbox.json') : path.join(PROFILE_RUNTIME_DIR, 'external_inbox.json');
const CONTACT_POLICY_PATH = path.join(RUNTIME_DIR, 'wa_contact_policy.json');
const PUBLIC_PROFILE_IDENTITY_PATH = path.join(RUNTIME_DIR, 'wa_public_identity.json');
const OWNER_ENGAGEMENT_PATH = path.join(RUNTIME_DIR, 'owner_engagement.json');
const SECRETARY_STATE_PATH = path.join(PROFILE_RUNTIME_DIR, 'secretary_state.json');
const OUTBOX_LEDGER_PATH = path.join(PROFILE_RUNTIME_DIR, 'outbox_ledger.json');
const CORE_WATCHDOG_PATH = path.join(RUNTIME_DIR, 'core_watchdog.json');
const PAIRING_QR_PATH = path.join(PROFILE_RUNTIME_DIR, 'pairing_qr.txt');
const CORE_STATUS_CACHE_MS = 15 * 1000;
const BRIDGE_CONTROL_PORT = Number(process.env.BRIDGE_CONTROL_PORT || 8091);
const BRIDGE_CONTROL_HOST = (process.env.BRIDGE_CONTROL_HOST || '127.0.0.1').trim() || '127.0.0.1';
const BRIDGE_CONTROL_TOKEN = (process.env.BRIDGE_CONTROL_TOKEN || '').trim();
const BRIDGE_CONTROL_MAX_BODY_BYTES = Math.max(
    1024,
    Number(process.env.LILY_WA_CONTROL_MAX_BODY_BYTES || 16 * 1024)
);
const BRIDGE_CONTROL_AUDIT_MAX_BYTES = Math.max(
    64 * 1024,
    Number(process.env.LILY_WA_CONTROL_AUDIT_MAX_BYTES || 5 * 1024 * 1024)
);
const BRIDGE_CONTROL_AUDIT_PATH = path.join(PROFILE_RUNTIME_DIR, 'control_security_audit.jsonl');
const bridgeControlRateBuckets = new Map();
const BRIDGE_CONTROL_CORS_ALLOW_ORIGINS = new Set(
    (process.env.LILY_WA_CONTROL_CORS_ALLOW_ORIGINS || 'http://127.0.0.1:5231,http://localhost:5231')
        .split(',')
        .map((value) => value.trim().replace(/\/$/, ''))
        .filter((value) => value && value !== '*')
);
const LILY_WA_PUBLIC_CONTROL_URL = (process.env.LILY_WA_PUBLIC_CONTROL_URL || 'http://127.0.0.1:8093').trim().replace(/\/+$/, '');
// Personal WA inbox forwarding to the desktop HUD is deliberately opt-in.
const LILY_WA_HUD_NOTIFICATIONS_ENABLED = (
    IS_PERSONAL_PROFILE
    && parseEnvBoolean(process.env.LILY_WA_HUD_NOTIFICATIONS_ENABLED, false)
);
const LILY_WA_HUD_VOICE_ENABLED = (
    LILY_WA_HUD_NOTIFICATIONS_ENABLED
    && parseEnvBoolean(process.env.LILY_WA_HUD_VOICE_ENABLED, false)
);
const LILY_WA_HUD_VOICE_LANGUAGE = (process.env.LILY_WA_HUD_VOICE_LANGUAGE || 'id').trim().toLowerCase();
const LILY_WA_HUD_VOICE_PROFILE = (process.env.LILY_WA_HUD_VOICE_PROFILE || 'id').trim();
const LILY_WA_HUD_VOICE_ROUTE = (process.env.LILY_WA_HUD_VOICE_ROUTE || '').trim().toLowerCase();
const LILY_WAKE_API_TOKEN = (process.env.LILY_WAKE_API_TOKEN || '').trim();
const INBOX_BACKFILL_ENABLED = (process.env.INBOX_BACKFILL_ENABLED || 'false').trim().toLowerCase() === 'true';
const INBOX_BACKFILL_CHAT_LIMIT = Number(process.env.INBOX_BACKFILL_CHAT_LIMIT || 12);
const INBOX_BACKFILL_MESSAGE_LIMIT = Number(process.env.INBOX_BACKFILL_MESSAGE_LIMIT || 1);
const INBOX_BACKFILL_START_DELAY_MS = Math.max(0, Number(process.env.INBOX_BACKFILL_START_DELAY_MS || 5000));
const INBOX_BACKFILL_RETRY_DELAY_MS = Math.max(1000, Number(process.env.INBOX_BACKFILL_RETRY_DELAY_MS || 15000));
const OPENCLAW_DELIVERY_POLL_MS = Number(process.env.OPENCLAW_DELIVERY_POLL_MS || 5000);
const OPENCLAW_DELIVERY_CONSUMER = `wa-${WA_PROFILE}`;
const OPENCLAW_OWNER_DELIVERY_TARGET = 'owner';
const OPENCLAW_RESULT_MAX_CHARS = Number(process.env.OPENCLAW_RESULT_MAX_CHARS || 3000);
const openClawSummarySentTaskIds = new Set();
const openClawFailureNotifiedTaskIds = new Set();
const WA_ATTACHMENT_MAX_BYTES = Number(process.env.WA_ATTACHMENT_MAX_BYTES || 20 * 1024 * 1024);
const WA_IMAGE_ATTACHMENT_MAX_BYTES = Number(process.env.WA_IMAGE_ATTACHMENT_MAX_BYTES || 15 * 1024 * 1024);
const WA_ATTACHMENT_CACHE_TTL_MS = Number(process.env.WA_ATTACHMENT_CACHE_TTL_MS || 10 * 60 * 1000);
const LILY_FILE_VESSEL_URL = (process.env.LILY_FILE_VESSEL_URL || '').trim().replace(/\/+$/, '');
const LILY_FILE_VESSEL_TOKEN = (process.env.LILY_FILE_VESSEL_TOKEN || '').trim();
const LILY_FILE_VESSELS_RAW = (process.env.LILY_FILE_VESSELS || '').trim();
const LILY_FILE_VESSEL_LABELS_RAW = (process.env.LILY_FILE_VESSEL_LABELS || '').trim();
const LILY_FILE_VESSEL_ALIASES_RAW = (process.env.LILY_FILE_VESSEL_ALIASES || '').trim();
const LILY_FILE_VESSEL_TOKENS_RAW = (process.env.LILY_FILE_VESSEL_TOKENS || '').trim();
const LILY_FILE_VESSEL_DEFAULT_KEY = (process.env.LILY_FILE_VESSEL_DEFAULT || process.env.LILY_FILE_VESSEL_DEVICE || '').trim();
const LILY_FINANCE_VESSEL_URL = (process.env.LILY_FINANCE_VESSEL_URL || '').trim().replace(/\/+$/, '');
const LILY_FINANCE_SERVICE_TOKEN = (process.env.LILY_FINANCE_SERVICE_TOKEN || process.env.LILY_FINANCE_TOKEN || '').trim();
const LILY_FINANCE_CONFIRM_TTL_MS = Number(process.env.LILY_FINANCE_CONFIRM_TTL_MS || 5 * 60 * 1000);
const LILY_FINANCE_IMAGE_FALLBACK_TTL_MS = Number(process.env.LILY_FINANCE_IMAGE_FALLBACK_TTL_MS || 10 * 60 * 1000);
const LILY_FINANCE_IMAGE_MAX_BYTES = Number(process.env.LILY_FINANCE_IMAGE_MAX_BYTES || 5 * 1024 * 1024);
const LILY_TOOL_HEALTH_URL = (process.env.LILY_TOOL_HEALTH_URL || 'http://127.0.0.1:8092/health').trim();
const LILY_VOICE_HEALTH_URL = (process.env.LILY_VOICE_HEALTH_URL || '').trim();
const LILY_VOICE_HEALTH_TOKEN = (process.env.LILY_VOICE_HEALTH_TOKEN || '').trim();
const LILY_STT_TRANSCRIBE_URL = (process.env.LILY_STT_TRANSCRIBE_URL || '').trim();
const LILY_STT_HEALTH_URL = (process.env.LILY_STT_HEALTH_URL || '').trim();
const LILY_STT_TOKEN = (process.env.LILY_STT_TOKEN || '').trim();
const LILY_STT_TIMEOUT_MS = Math.max(5000, Number(process.env.LILY_STT_TIMEOUT_MS || 60000));
const LILY_STT_MAX_AUDIO_BYTES = Number(process.env.LILY_STT_MAX_AUDIO_BYTES || 10 * 1024 * 1024);
const configuredWaAuthTimeoutMs = Number(process.env.LILY_WA_AUTH_TIMEOUT_MS || 120000);
const LILY_WA_AUTH_TIMEOUT_MS = Number.isFinite(configuredWaAuthTimeoutMs)
    ? Math.max(30000, Math.min(300000, configuredWaAuthTimeoutMs))
    : 120000;
const LILY_WA_WEB_VERSION = (process.env.LILY_WA_WEB_VERSION || '').trim();
const LILY_WA_USER_AGENT = resolvePuppeteerUserAgent();
const LILY_STATUS_CHECK_TIMEOUT_MS = Math.max(500, Number(process.env.LILY_STATUS_CHECK_TIMEOUT_MS || 1500));
const LILY_FILE_VESSEL_SEARCH_LIMIT = Number(process.env.LILY_FILE_VESSEL_SEARCH_LIMIT || 6);
const LILY_FILE_VESSEL_SEARCH_DEPTH = Number(process.env.LILY_FILE_VESSEL_SEARCH_DEPTH || 8);
const LILY_FILE_VESSEL_LIST_LIMIT = Math.max(1, Math.min(50, Number(process.env.LILY_FILE_VESSEL_LIST_LIMIT || 10)));
const LILY_FILE_SEND_CONFIRM_TTL_MS = Number(process.env.LILY_FILE_SEND_CONFIRM_TTL_MS || 5 * 60 * 1000);
const LILY_FILE_SEARCH_CONTEXT_TTL_MS = Number(process.env.LILY_FILE_SEARCH_CONTEXT_TTL_MS || 30 * 60 * 1000);
const configuredWaIntentRouterTimeoutMs = Number(process.env.LILY_WA_INTENT_ROUTER_TIMEOUT_MS || 2600);
const LILY_WA_INTENT_ROUTER_TIMEOUT_MS = Number.isFinite(configuredWaIntentRouterTimeoutMs)
    ? Math.max(500, configuredWaIntentRouterTimeoutMs)
    : 2600;
const configuredWaIntentRouterMinConfidence = Number(process.env.LILY_WA_INTENT_ROUTER_MIN_CONFIDENCE || 0.72);
const LILY_WA_INTENT_ROUTER_MIN_CONFIDENCE = Number.isFinite(configuredWaIntentRouterMinConfidence)
    ? Math.min(1, Math.max(0, configuredWaIntentRouterMinConfidence))
    : 0.72;
const OPENCLAW_WINDOWS_PATH_RE = /(^|[^A-Za-z0-9])([A-Za-z]:[\\/][^\s`"'<>|]+)/gm;
const OPENCLAW_UNIX_PATH_RE = /(^|[^:\w])(\/(?:[^/\s`"'<>]+\/)+[^/\s`"'<>]+)/gm;
const OWNER_ATTACHMENT_CACHE_DIR = path.join(RUNTIME_DIR, 'owner_attachments');

const expectedBridgeControlPort = IS_PUBLIC_PROFILE ? 8093 : 8091;
if (BRIDGE_CONTROL_PORT !== expectedBridgeControlPort) {
    throw new Error(
        `LILY_WA_PROFILE=${WA_PROFILE} must use BRIDGE_CONTROL_PORT=${expectedBridgeControlPort}; got ${BRIDGE_CONTROL_PORT}.`
    );
}

function parseEnvBoolean(value, fallback = false) {
    const normalized = (value || '').toString().trim().toLowerCase();
    if (!normalized) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function discoverPuppeteerExecutable() {
    const configured = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
    if (configured && fs.existsSync(configured)) return configured;

    const candidates = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ];
    const cacheRoot = path.join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome-headless-shell');
    try {
        for (const version of fs.readdirSync(cacheRoot).sort().reverse()) {
            candidates.push(path.join(
                cacheRoot,
                version,
                'chrome-headless-shell-linux64',
                'chrome-headless-shell',
            ));
        }
    } catch (_) {
        // Puppeteer will use its default resolution when no cache is available.
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolvePuppeteerUserAgent() {
    const configured = (process.env.LILY_WA_USER_AGENT || '').trim();
    if (configured) return configured;

    try {
        const puppeteerCoreEntry = require.resolve('puppeteer-core');
        const revisionsPath = path.join(path.dirname(puppeteerCoreEntry), 'revisions.js');
        const { PUPPETEER_REVISIONS } = require(revisionsPath);
        return buildChromiumUserAgent(PUPPETEER_REVISIONS.chrome);
    } catch (error) {
        console.warn('Could not derive the Puppeteer Chrome user-agent:', error?.message || error);
        return '';
    }
}

const PUPPETEER_EXECUTABLE_PATH = discoverPuppeteerExecutable();

// State to store incoming messages for aggregation
const sessionStats = {}; 
const INCOMING_MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const incomingMessageSeenAt = new Map();
// sessionStats[chatId] = { buffer, timer, processingPromise, autoReplyTimer, pendingMessage, messageCount, isOwner, hasVoiceMessage, hasIntroduced, lastRouteDecision, lastOwnerTextRequest }
const contactProfiles = loadContactProfiles();
const contactPolicy = createContactPolicyStore(CONTACT_POLICY_PATH);
const ownerMemory = loadOwnerMemory();
let ownerPresence;
const externalInbox = loadExternalInbox();
const secretaryConfig = createSecretaryConfig({
    cachePath: path.join(PROFILE_RUNTIME_DIR, 'secretary-settings-cache.json'),
    fetchSettings: async () => (await requestCore('get', `${LILY_CORE_URL}/api/wa/secretary/settings`, null, 4000, false)).data,
    onChange: (configuration) => secretary.configure(configuration),
});
const secretary = createSecretary({
    filePath: SECRETARY_STATE_PATH, initialMode: 'off', personal: IS_PERSONAL_PROFILE,
    configurationFresh: () => secretaryConfig.fresh(),
    ownerName: process.env.OWNER_NAME || 'Lily User', getPresence: getActiveOwnerPresence,
    delayMs: AUTO_REPLY_DELAY_MS, cooldownMs: AUTO_REPLY_COOLDOWN_MS,
    allowed: (chatId) => {
        const number = getPolicyPhoneNumber(chatId);
        return Boolean(number) && secretaryConfig.action(number) === 'secretary'
            && !contactPolicy.has('secretary_never_reply', number);
    },
    generate: async (payload) => {
        const response = await requestCore('post', `${LILY_CORE_URL}/api/wa/secretary/reply`, payload, 15000, false);
        return response.data;
    },
    send: async (chatId, text, stillAllowed) => {
        if (!waClientReady) return false;
        await setChatPresence(chatId);
        if (!waClientReady || !stillAllowed()) return false;
        await client.sendMessage(chatId, text);
        if (sessionStats[chatId]) sessionStats[chatId].hasIntroduced = true;
        markContactIntroduced(chatId);
        return true;
    },
    onReply: (chatId, result) => {
        const item = externalInbox.find(entry => entry.chatId === chatId);
        if (!item) return;
        item.secretarySummary = String(result.summary || '').slice(0, 500);
        item.secretaryNeedsOwner = Boolean(result.needs_owner);
        item.secretaryReply = result.reply;
        item.secretaryRepliedAt = new Date().toISOString();
        saveExternalInbox();
    },
    onSummary: async (chatId, result, details) => {
        if (secretaryConfig.action(getContactProfile(chatId)?.phoneNumber || chatId.split('@')[0]) === 'ignore') return;
        const summary = String(result.summary || '').slice(0, 500);
        const item = externalInbox.find((entry) => entry.chatId === chatId);
        if (item) {
            item.secretarySummary = summary;
            item.secretaryNeedsOwner = Boolean(result.needs_owner);
            saveExternalInbox();
        }
        if (item) queueInboxNotification(item);
    },
});
function reviewContactNumber(chatId) {
    return getContactProfile(chatId)?.phoneNumber || (/^\d+@c\.us$/.test(chatId) ? chatId.split('@')[0] : '');
}
function getPolicyPhoneNumber(chatId) {
    const sessionNumber = sessionStats[chatId]?.contactPhoneNumber;
    if (sessionNumber) return sessionNumber;
    return /^\d+@c\.us$/i.test(chatId)
        ? normalizeInternationalNumber(chatId.split('@')[0]) : '';
}
function reviewCanReply(chatId) {
    const number = reviewContactNumber(chatId);
    return Boolean(number) && secretaryConfig.fresh() && secretaryConfig.action(number) === 'secretary'
        && !contactPolicy.has('secretary_never_reply', number);
}
const inboxReview = require('./inbox-review').createInboxReview({
    items: externalInbox,
    save: () => atomicWriteJson(EXTERNAL_INBOX_PATH, externalInbox),
    allowed: chatId => IS_PERSONAL_PROFILE && secretaryConfig.fresh()
        && /^\d+@(c\.us|lid)$/.test(chatId)
        && Boolean(reviewContactNumber(chatId)) && secretaryConfig.action(reviewContactNumber(chatId)) !== 'ignore',
    canReply: reviewCanReply,
    generate: async item => {
        if (!reviewCanReply(item.chatId))
            throw new Error('This contact is configured for no replies.');
        return (await requestCore('post', `${LILY_CORE_URL}/api/wa/secretary/reply`, {
            contact_name: String(item.name || 'Contact').slice(0, 100), message: item.originalMessage.slice(0, 2400),
            owner_name: process.env.OWNER_NAME || 'Owner', history: [], introduced: false,
        }, 15000, false)).data;
    },
    handoff: chatId => secretary.ownerReplied(chatId),
    send: async (chatId, text) => {
        if (!waClientReady || !reviewCanReply(chatId)) throw new Error('Reply unavailable.');
        await client.sendMessage(chatId, text);
    },
});
const inboxDelivery = IS_PERSONAL_PROFILE ? createInboxDelivery({
    filePath: path.join(PROFILE_RUNTIME_DIR, 'inbox-delivery.json'), items: () => externalInbox,
    settings: () => secretaryConfig.settings(),
    allowed: chatId => secretaryConfig.action(getContactProfile(chatId)?.phoneNumber || chatId.split('@')[0]) !== 'ignore',
    ready: channel => channel !== 'wa' || Boolean(waClientReady && process.env.OWNER_NUMBER),
    sendWa: sendOwnerInboxNotification,
    sendHud: sendHudInboxNotification,
}) : null;
function queueInboxNotification(item) {
    if (!inboxDelivery || !item) return;
    inboxDelivery.enqueue(item);
    void inboxDelivery.tick().catch(() => console.warn('[INBOX] Notification delivery paused; check the ledger.'));
}
if (IS_PERSONAL_PROFILE) {
    setTimeout(() => void secretaryConfig.refresh(), 1000).unref();
    setInterval(() => void secretaryConfig.refresh(), 5000).unref();
    setInterval(() => void inboxDelivery.tick().catch(() => console.warn('[INBOX] Delivery unavailable.')), 15000).unref();
}
const modelRateLimits = {
    router: { rpm: 15, timestamps: [] },
    chat: { rpm: 10, timestamps: [] },
};
const coreStatusCache = { checkedAt: 0, isAvailable: false };
let openClawDeliveryPoller = null;
let isOpenClawDeliveryPollRunning = false;
let proactiveOwnerPoller = null;
let isProactiveOwnerPollRunning = false;
let ownerRoutinePoller = null;
let isOwnerRoutinePollRunning = false;
let waRuntimePoller = null;
let isWaRuntimeReportRunning = false;
let lastRoutineDelivery = null;
let coreWatchdogPoller = null;
let isCoreWatchdogRunning = false;
const pendingOutgoingProactiveWaiters = [];
let waClientReady = false;
let waClientState = 'starting';
let waClientStateUpdatedAt = new Date().toISOString();
const CORE_HTTP_AGENT = new http.Agent({ keepAlive: false });
const CORE_HTTPS_AGENT = new https.Agent({ keepAlive: false });
const ownerPendingPdfByChat = {};
const pendingFileSendByChat = new Map();
const lastFileSearchByChat = new Map();
const pendingFinanceDraftByChat = new Map();
const pendingFinanceImageFallbackByChat = new Map();
const lastFinanceSummaryByChat = new Map();
let ownerEngagement = loadOwnerEngagement();
const OWNER_FILE_SEND_PENDING_KEY = '__owner_file_send__';
const OWNER_FINANCE_DRAFT_PENDING_KEY = '__owner_finance_draft__';
const OWNER_FINANCE_IMAGE_FALLBACK_KEY = '__owner_finance_image_fallback__';
const OWNER_FINANCE_SUMMARY_CONTEXT_KEY = '__owner_finance_summary__';
const LILY_FINANCE_CONTEXT_TTL_MS = Number(process.env.LILY_FINANCE_CONTEXT_TTL_MS || 10 * 60 * 1000);
const LILY_WA_PROACTIVE_ENABLED = parseEnvBoolean(process.env.LILY_WA_PROACTIVE_ENABLED, true);
const LILY_WA_PROACTIVE_POLL_MS = Math.max(60 * 1000, Number(process.env.LILY_WA_PROACTIVE_POLL_MS || 15 * 60 * 1000));
const LILY_WA_PROACTIVE_MIN_IDLE_MS = Math.max(60 * 1000, Number(process.env.LILY_WA_PROACTIVE_MIN_IDLE_MS || 2 * 60 * 60 * 1000));
const LILY_WA_PROACTIVE_COOLDOWN_MS = Math.max(60 * 1000, Number(process.env.LILY_WA_PROACTIVE_COOLDOWN_MS || 6 * 60 * 60 * 1000));
const LILY_WA_PROACTIVE_MAX_PER_DAY = Math.max(1, Math.min(12, Number(process.env.LILY_WA_PROACTIVE_MAX_PER_DAY || 3)));
const LILY_WA_PROACTIVE_QUIET_START_HOUR = Math.max(0, Math.min(23, Number(process.env.LILY_WA_PROACTIVE_QUIET_START_HOUR || 23)));
const LILY_WA_PROACTIVE_QUIET_END_HOUR = Math.max(0, Math.min(23, Number(process.env.LILY_WA_PROACTIVE_QUIET_END_HOUR || 8)));
const LILY_WA_PROACTIVE_TIMEZONE = (process.env.LILY_WA_PROACTIVE_TIMEZONE || 'Asia/Jakarta').trim();
const LILY_WA_ROUTINES_ENABLED = parseEnvBoolean(process.env.LILY_WA_ROUTINES_ENABLED, true);
const LILY_WA_ROUTINE_POLL_MS = Math.max(
    60 * 1000,
    Number(process.env.LILY_WA_ROUTINE_POLL_MS || 5 * 60 * 1000),
);
const LILY_WA_CORE_WATCHDOG_ENABLED = parseEnvBoolean(process.env.LILY_WA_CORE_WATCHDOG_ENABLED, true);
const LILY_WA_CORE_WATCHDOG_POLL_MS = Math.max(
    30 * 1000,
    Number(process.env.LILY_WA_CORE_WATCHDOG_POLL_MS || 60 * 1000),
);
const LILY_WA_PROACTIVE_OWNER_NUMBER = normalizeInternationalNumber(process.env.LILY_WA_PROACTIVE_OWNER_NUMBER || '');
const LILY_WA_HUMANIZED_TIMING_ENABLED = parseEnvBoolean(process.env.LILY_WA_HUMANIZED_TIMING_ENABLED, true);
const LILY_WA_HUMANIZED_MIN_DELAY_MS = Math.max(0, Number(process.env.LILY_WA_HUMANIZED_MIN_DELAY_MS || 650));
const LILY_WA_HUMANIZED_MAX_DELAY_MS = Math.max(
    LILY_WA_HUMANIZED_MIN_DELAY_MS,
    Number(process.env.LILY_WA_HUMANIZED_MAX_DELAY_MS || 3200),
);
const LILY_WA_HUMANIZED_SPLIT_RATE = Math.max(0, Math.min(1, Number(process.env.LILY_WA_HUMANIZED_SPLIT_RATE || 0.28)));
const LILY_WA_STREAM_VOICE_TEST_ENABLED = (
    IS_PERSONAL_PROFILE
    && parseEnvBoolean(process.env.LILY_WA_STREAM_VOICE_TEST_ENABLED, false)
);
const FINANCE_BROAD_MERCHANT_RULE_DENYLIST = new Set([
    'alfamart',
    'alfamidi',
    'indomaret',
    'lazada',
    'shopee',
    'tokopedia',
]);
const FINANCE_ACCOUNT_ALIASES = [
    { account: 'mandiri', aliases: ['mandiri'] },
    { account: 'bca', aliases: ['bca'] },
    { account: 'gopay', aliases: ['gopay', 'go pay'] },
    { account: 'dana', aliases: ['dana'] },
    { account: 'cash', aliases: ['cash', 'tunai'] },
];
const FINANCE_SUMMARY_SUBJECT_PATTERN = /\b(?:saldo|balance|uang|duit|rekening|akun|mandiri|gopay|dana|cash|keuangan|finance)\b/i;
const FINANCE_SUMMARY_ACTION_PATTERN = /\b(?:berapa|cek|check|lihat|liat|show|summary|ringkasan|total|sisa)\b/i;
const FINANCE_INTERPRETER_HINT_PATTERN = /\b(?:saldo|balance|uang|duit|rekening|akun|finance|keuangan|bca|mandiri|gopay|go\s*pay|dana|cash|tunai|tf|transfer|kirim(?:in)?|bayar|beli|jajan|isi|top\s*up|gaji|income|expense|pengeluaran|pemasukan|tagihan|struk|admin|biaya|fee|langganan|subscription)\b/i;
const FINANCE_TRANSACTION_CUE_PATTERN = /\b(?:tf|transfer|kirim(?:in)?|bayar|beli|jajan|isi|top\s*up|gaji|income|expense|pengeluaran|pemasukan|admin|biaya|fee|tagihan|langganan|subscription)\b/i;
const FINANCE_AMOUNT_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:k|rb|ribu|jt|juta)?\b/i;
const FINANCE_KNOWN_CATEGORY_NAMES = new Set([
    'fuel',
    'food',
    'salary',
    'transport',
    'shopping',
    'internet',
    'subscription',
    'bank_fee',
    'bills',
    'entertainment',
    'health',
    'hardware',
    'transfer',
    'uncategorized',
]);
const FINANCE_RECENT_TRANSACTION_PATTERN = /\b(?:transaksi|transaction|riwayat|history)\b.*\b(?:terakhir|recent|last)\b|\b(?:terakhir|recent|last)\b.*\b(?:transaksi|transaction|riwayat|history)\b/i;
const FINANCE_TODAY_PATTERN = /\b(?:finance\s+today|today\s+finance|hari\s+ini|today)\b/i;
const FINANCE_MONTH_EXPENSE_PATTERN = /\b(?:pengeluaran|expense|expenses|keluar)\b.*\b(?:bulan\s+ini|this\s+month)\b/i;
const FINANCE_PERIOD_FOLLOWUP_PATTERNS = [
    /^(?:bulan|periode|period)\s+(?:apa|mana)(?:\s+(?:itu|tadi))?$/i,
    /^(?:itu|tadi)\s+(?:bulan|periode|period)\s+(?:apa|mana)$/i,
    /^(?:itu|tadi)\s+(?:buat\s+)?(?:bulan|periode|period)\s+(?:apa|mana)$/i,
];
const WA_OWNER_ROUTER_INTENTS = new Set([
    'chat',
    'finance_interpret',
    'finance_summary',
    'finance_recent_transactions',
    'finance_month_expense',
    'finance_period_followup',
    'file_search',
    'file_confirm',
    'file_cancel',
    'file_repeat_search',
    'home_control',
    'home_status',
    'wake_pc',
    'presence_set',
    'tool_approve',
    'tool_deny',
    'voice_request',
    'task_request',
    'unknown',
]);
const FILE_VESSEL_REGISTRY = buildFileVesselRegistry();

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_RUNTIME_DIR, { recursive: true });
fs.mkdirSync(OWNER_ATTACHMENT_CACHE_DIR, { recursive: true });
let outboxLedger = loadOutboxLedger();

function loadOutboxLedger() {
    try {
        if (!fs.existsSync(OUTBOX_LEDGER_PATH)) return { version: 1, entries: {} };
        const parsed = JSON.parse(fs.readFileSync(OUTBOX_LEDGER_PATH, 'utf8'));
        return {
            version: 1,
            entries: parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
        };
    } catch (error) {
        console.error('Failed to load WA outbox ledger:', error);
        return { version: 1, entries: {} };
    }
}

function saveOutboxLedger() {
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const entries = Object.entries(outboxLedger.entries || {})
        .filter(([, item]) => Number(item?.updated_at || 0) >= cutoff)
        .sort((a, b) => Number(b[1]?.updated_at || 0) - Number(a[1]?.updated_at || 0))
        .slice(0, 500);
    outboxLedger.entries = Object.fromEntries(entries);
    atomicWriteJson(OUTBOX_LEDGER_PATH, outboxLedger);
}

function outboxDeliveryKey(chatId, idempotencyKey) {
    const raw = `${WA_PROFILE}|${chatId}|${idempotencyKey || ''}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

async function resolveQuotedReply(msg) {
    if (!msg?.hasQuotedMsg || typeof msg.getQuotedMessage !== 'function') return null;
    try {
        const quoted = await msg.getQuotedMessage();
        const text = (quoted?.body || '').toString().replace(/\s+/g, ' ').trim().slice(0, 1200);
        if (!text) return null;
        let author = quoted.fromMe ? 'Previous outgoing message' : 'Earlier participant';
        if (!quoted.fromMe && typeof quoted.getContact === 'function') {
            try {
                const contact = await quoted.getContact();
                author = (
                    contact?.pushname
                    || contact?.name
                    || contact?.shortName
                    || author
                ).toString().trim().slice(0, 80);
            } catch (_) {
                // The quoted body remains useful when contact lookup is unavailable.
            }
        }
        return {
            author,
            text,
            message_id: (quoted?.id?._serialized || '').toString().slice(0, 240),
        };
    } catch (error) {
        console.warn('Could not resolve quoted WhatsApp message:', error?.message || error);
        return null;
    }
}

function loadContactProfiles() {
    try {
        if (!fs.existsSync(CONTACT_PROFILES_PATH)) {
            return {};
        }

        const raw = fs.readFileSync(CONTACT_PROFILES_PATH, 'utf8').trim();
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.error('Failed to load contact profiles:', error);
        return {};
    }
}

function loadOwnerMemory() {
    try {
        if (!fs.existsSync(OWNER_MEMORY_PATH)) {
            return {
                preferredName: "",
                nickname: "",
                preferences: [],
                notes: [],
                recentTopics: [],
                lastInteractions: [],
            };
        }

        const raw = fs.readFileSync(OWNER_MEMORY_PATH, 'utf8').trim();
        if (!raw) {
            return {
                preferredName: "",
                nickname: "",
                preferences: [],
                notes: [],
                recentTopics: [],
                lastInteractions: [],
            };
        }

        const parsed = JSON.parse(raw);
        return {
            preferredName: parsed.preferredName || "",
            nickname: parsed.nickname || "",
            preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
            notes: Array.isArray(parsed.notes) ? parsed.notes : [],
            recentTopics: Array.isArray(parsed.recentTopics) ? parsed.recentTopics : [],
            lastInteractions: Array.isArray(parsed.lastInteractions) ? parsed.lastInteractions : [],
        };
    } catch (error) {
        console.error('Failed to load owner memory:', error);
        return {
            preferredName: "",
            nickname: "",
            preferences: [],
            notes: [],
            recentTopics: [],
            lastInteractions: [],
        };
    }
}

const OWNER_PRESENCE_DEFAULTS = {
    available: {
        label: 'Available',
        note: 'Owner is available.',
        ttlMinutes: null,
    },
    busy: {
        label: 'Busy',
        note: 'Owner is busy. Keep replies concise and useful.',
        ttlMinutes: 120,
    },
    at_office: {
        label: 'At office',
        note: 'Owner is working. Keep replies concise and avoid noisy suggestions.',
        ttlMinutes: 540,
    },
    sleeping: {
        label: 'Sleeping',
        note: 'Owner may be resting. Keep replies calm and do not assume immediate attention.',
        ttlMinutes: 480,
    },
    gaming: {
        label: 'Gaming',
        note: 'Owner may be playing a game. Keep replies short and easy to act on.',
        ttlMinutes: 240,
    },
    away: {
        label: 'Away',
        note: 'Owner is away. Keep replies brief and hold non-urgent detail.',
        ttlMinutes: 120,
    },
};

const OWNER_PRESENCE_ALIASES = {
    available: 'available',
    normal: 'available',
    online: 'available',
    ada: 'available',
    aktif: 'available',
    sibuk: 'busy',
    busy: 'busy',
    meeting: 'busy',
    kantor: 'at_office',
    kerja: 'at_office',
    office: 'at_office',
    'at office': 'at_office',
    tidur: 'sleeping',
    sleep: 'sleeping',
    sleeping: 'sleeping',
    istirahat: 'sleeping',
    game: 'gaming',
    gaming: 'gaming',
    'main game': 'gaming',
    ranked: 'gaming',
    away: 'away',
    pergi: 'away',
    keluar: 'away',
};

function defaultOwnerPresence() {
    return normalizeOwnerPresence({ status: 'available', source: 'wa' });
}

function normalizePresenceStatus(value) {
    const raw = (value || '').toString().trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
    return OWNER_PRESENCE_ALIASES[raw] || '';
}

function cleanPresenceNote(value) {
    return (value || '').toString().replace(/\s+/g, ' ').trim().slice(0, 180);
}

function normalizeOwnerPresence(update = {}) {
    const rawStatus = normalizePresenceStatus(update.status) || (update.note ? 'busy' : 'available');
    const defaults = OWNER_PRESENCE_DEFAULTS[rawStatus] || OWNER_PRESENCE_DEFAULTS.available;
    const now = new Date();
    const ttlMinutes = update.ttl_minutes ?? update.ttlMinutes ?? defaults.ttlMinutes;
    const expiresAt = rawStatus === 'available'
        ? null
        : update.expires_at || update.expiresAt || (ttlMinutes ? new Date(now.getTime() + Number(ttlMinutes) * 60 * 1000).toISOString() : null);

    return {
        status: rawStatus,
        label: cleanPresenceNote(update.label).slice(0, 48) || defaults.label,
        note: cleanPresenceNote(update.note) || defaults.note,
        source: ['wa', 'control_center', 'private_realm', 'system'].includes(update.source) ? update.source : 'wa',
        updated_at: update.updated_at || update.updatedAt || now.toISOString(),
        expires_at: expiresAt,
        active: rawStatus !== 'available',
    };
}

function loadOwnerPresence() {
    try {
        if (!fs.existsSync(OWNER_PRESENCE_PATH)) {
            return defaultOwnerPresence();
        }

        const raw = fs.readFileSync(OWNER_PRESENCE_PATH, 'utf8').trim();
        if (!raw) return defaultOwnerPresence();

        return normalizeOwnerPresence(JSON.parse(raw));
    } catch (error) {
        console.error('Failed to load owner presence:', error);
        return defaultOwnerPresence();
    }
}

function loadExternalInbox() {
    try {
        if (!fs.existsSync(EXTERNAL_INBOX_PATH)) {
            return [];
        }

        const raw = fs.readFileSync(EXTERNAL_INBOX_PATH, 'utf8').trim();
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Failed to load external inbox:', error);
        return [];
    }
}


function loadOwnerEngagement() {
    try {
        if (!fs.existsSync(OWNER_ENGAGEMENT_PATH)) {
            return {
                last_owner_activity_at: 0,
                last_owner_number: '',
                last_owner_chat_id: '',
                last_proactive_attempt_at: '',
                last_proactive_status: '',
                last_proactive_error: '',
                last_proactive_message_id: '',
                last_proactive_ack: null,
                last_proactive_ack_label: '',
                last_proactive_ack_at: '',
                proactive_paused_until: 0,
                reply_length_mode: 'normal',
                updated_at: '',
            };
        }
        const parsed = JSON.parse(fs.readFileSync(OWNER_ENGAGEMENT_PATH, 'utf8'));
        const parsedAck = parsed?.last_proactive_ack;
        return {
            last_owner_activity_at: Math.max(0, Number(parsed?.last_owner_activity_at || 0)),
            last_owner_number: normalizeInternationalNumber(parsed?.last_owner_number || ''),
            last_owner_chat_id: normalizeDirectChatId(parsed?.last_owner_chat_id || ''),
            last_proactive_attempt_at: (parsed?.last_proactive_attempt_at || '').toString(),
            last_proactive_status: (parsed?.last_proactive_status || '').toString(),
            last_proactive_error: (parsed?.last_proactive_error || '').toString(),
            last_proactive_message_id: (parsed?.last_proactive_message_id || '').toString(),
            last_proactive_ack: parsedAck !== null
                && parsedAck !== undefined
                && Number.isFinite(Number(parsedAck))
                ? Number(parsedAck)
                : null,
            last_proactive_ack_label: (parsed?.last_proactive_ack_label || '').toString(),
            last_proactive_ack_at: (parsed?.last_proactive_ack_at || '').toString(),
            proactive_paused_until: Math.max(0, Number(parsed?.proactive_paused_until || 0)),
            reply_length_mode: ['short', 'normal', 'detail'].includes(parsed?.reply_length_mode)
                ? parsed.reply_length_mode
                : 'normal',
            updated_at: (parsed?.updated_at || '').toString(),
        };
    } catch (error) {
        console.error('Failed to load owner engagement:', error);
        return {
            last_owner_activity_at: 0,
            last_owner_number: '',
            last_owner_chat_id: '',
            last_proactive_attempt_at: '',
            last_proactive_status: '',
            last_proactive_error: '',
            last_proactive_message_id: '',
            last_proactive_ack: null,
            last_proactive_ack_label: '',
            last_proactive_ack_at: '',
            proactive_paused_until: 0,
            reply_length_mode: 'normal',
            updated_at: '',
        };
    }
}

function normalizeDirectChatId(value = '') {
    const chatId = (value || '').toString().trim().toLowerCase();
    return /^\d+@(c\.us|lid)$/.test(chatId) ? chatId : '';
}

function saveOwnerEngagement() {
    try {
        atomicWriteJson(OWNER_ENGAGEMENT_PATH, ownerEngagement);
    } catch (error) {
        console.error('Failed to save owner engagement:', error);
    }
}

function recordOwnerEngagement(ownerNumber = '', ownerChatId = '') {
    const diskState = loadOwnerEngagement();
    ownerEngagement = {
        ...diskState,
        last_owner_activity_at: Math.max(Date.now(), Number(diskState.last_owner_activity_at || 0)),
        last_owner_number: normalizeInternationalNumber(ownerNumber)
            || diskState.last_owner_number
            || ownerEngagement.last_owner_number
            || '',
        last_owner_chat_id: normalizeDirectChatId(ownerChatId)
            || diskState.last_owner_chat_id
            || ownerEngagement.last_owner_chat_id
            || '',
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
}

function setProactivePause(durationMs) {
    const diskState = loadOwnerEngagement();
    const pausedUntil = Date.now() + Math.max(60 * 1000, Number(durationMs || 0));
    ownerEngagement = {
        ...diskState,
        proactive_paused_until: pausedUntil,
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
    return pausedUntil;
}

function clearProactivePause() {
    const diskState = loadOwnerEngagement();
    ownerEngagement = {
        ...diskState,
        proactive_paused_until: 0,
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
}

function setOwnerReplyLengthMode(mode = 'normal') {
    const normalized = ['short', 'normal', 'detail'].includes(mode) ? mode : 'normal';
    ownerEngagement = {
        ...loadOwnerEngagement(),
        reply_length_mode: normalized,
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
    return normalized;
}

function getOwnerReplyLengthMode() {
    return loadOwnerEngagement().reply_length_mode || 'normal';
}

function proactiveAckLabel(ack) {
    return {
        [-1]: 'error',
        0: 'pending',
        1: 'server',
        2: 'device',
        3: 'read',
        4: 'played',
    }[Number(ack)] || 'unknown';
}

function recordProactiveDelivery(status, error = '', message = null) {
    const diskState = loadOwnerEngagement();
    const messageId = (message?.id?._serialized || '').toString();
    const ack = Number.isFinite(Number(message?.ack)) ? Number(message.ack) : null;
    ownerEngagement = {
        ...diskState,
        last_proactive_attempt_at: new Date().toISOString(),
        last_proactive_status: (status || '').toString().trim().slice(0, 40),
        last_proactive_error: (error || '').toString().trim().slice(0, 240),
        last_proactive_message_id: messageId || diskState.last_proactive_message_id || '',
        last_proactive_ack: ack,
        last_proactive_ack_label: ack === null ? '' : proactiveAckLabel(ack),
        last_proactive_ack_at: ack === null ? '' : new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
}

function recordProactiveAck(message, ack) {
    const diskState = loadOwnerEngagement();
    const messageId = (message?.id?._serialized || '').toString();
    if (!messageId || messageId !== diskState.last_proactive_message_id) return;

    ownerEngagement = {
        ...diskState,
        last_proactive_ack: Number(ack),
        last_proactive_ack_label: proactiveAckLabel(ack),
        last_proactive_ack_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
}

function waitForOutgoingProactiveMessage(chatIds, timeoutMs = 3500) {
    const expectedChatIds = new Set(
        (Array.isArray(chatIds) ? chatIds : [chatIds])
            .map((chatId) => normalizeDirectChatId(chatId))
            .filter(Boolean),
    );
    let waiter = null;
    const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            const index = pendingOutgoingProactiveWaiters.indexOf(waiter);
            if (index >= 0) pendingOutgoingProactiveWaiters.splice(index, 1);
            resolve(null);
        }, timeoutMs);
        waiter = {
            expectedChatIds,
            resolve: (message) => {
                clearTimeout(timer);
                resolve(message);
            },
        };
        pendingOutgoingProactiveWaiters.push(waiter);
    });
    return {
        promise,
        cancel: () => {
            const index = pendingOutgoingProactiveWaiters.indexOf(waiter);
            if (index >= 0) pendingOutgoingProactiveWaiters.splice(index, 1);
            waiter?.resolve(null);
        },
    };
}

function captureOutgoingProactiveMessage(message) {
    const messageChatId = normalizeDirectChatId(
        message?.to
        || message?.id?.remote
        || '',
    );
    if (!messageChatId) return;
    const index = pendingOutgoingProactiveWaiters.findIndex(
        (waiter) => waiter.expectedChatIds.has(messageChatId),
    );
    if (index < 0) return;
    const [waiter] = pendingOutgoingProactiveWaiters.splice(index, 1);
    waiter.resolve(message);
}

function rememberOwnerChatId(chatId = '', ownerNumber = '') {
    const normalizedChatId = normalizeDirectChatId(chatId);
    if (!normalizedChatId) return;
    const diskState = loadOwnerEngagement();

    ownerEngagement = {
        ...diskState,
        last_owner_number: normalizeInternationalNumber(ownerNumber)
            || diskState.last_owner_number
            || '',
        last_owner_chat_id: normalizedChatId,
        updated_at: new Date().toISOString(),
    };
    saveOwnerEngagement();
}

function saveContactProfiles() {
    try {
        atomicWriteJson(CONTACT_PROFILES_PATH, contactProfiles);
    } catch (error) {
        console.error('Failed to save contact profiles:', error);
    }
}

function saveOwnerMemory() {
    try {
        atomicWriteJson(OWNER_MEMORY_PATH, ownerMemory);
    } catch (error) {
        console.error('Failed to save owner memory:', error);
    }
}

function saveOwnerPresence() {
    try {
        atomicWriteJson(OWNER_PRESENCE_PATH, ownerPresence);
    } catch (error) {
        console.error('Failed to save owner presence:', error);
    }
}

function saveExternalInbox() {
    try {
        atomicWriteJson(EXTERNAL_INBOX_PATH, externalInbox);
    } catch (error) {
        console.error('Failed to save external inbox:', error);
    }
}

ownerPresence = loadOwnerPresence();

function sanitizeAttachmentFilename(name, fallback = 'owner_input.pdf') {
    const rawName = path.basename((name || fallback).toString().trim() || fallback);
    let safeName = rawName.replace(/[^A-Za-z0-9._ -]+/g, '_').trim();
    safeName = safeName.replace(/^[._ -]+/, '').slice(0, 120) || fallback;
    if (!safeName.toLowerCase().endsWith('.pdf')) {
        safeName = `${safeName.replace(/\.[^.]+$/, '') || 'owner_input'}.pdf`;
    }
    return safeName;
}

function sanitizeGenericFilename(name, fallback = 'attachment.bin') {
    const rawName = path.basename((name || fallback).toString().trim() || fallback);
    let safeName = rawName.replace(/[^A-Za-z0-9._ -]+/g, '_').trim();
    safeName = safeName.replace(/^[._ -]+/, '').slice(0, 120) || fallback;
    return safeName;
}

function hashBufferSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatAttachmentSize(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${Math.max(1, Math.round(value / 1024))} KB`;
    }
    return `${value} B`;
}

function attachmentChatKey(chatId) {
    return (chatId || 'chat').toString().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'chat';
}

function clearCachedOwnerPdf(chatId) {
    delete ownerPendingPdfByChat[chatId];
}

function getCachedOwnerPdf(chatId) {
    const item = ownerPendingPdfByChat[chatId];
    if (!item) return null;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
        clearCachedOwnerPdf(chatId);
        return null;
    }
    return item;
}

function takeCachedOwnerPdf(chatId) {
    const item = getCachedOwnerPdf(chatId);
    if (!item) return null;
    clearCachedOwnerPdf(chatId);
    return item.inputFile || null;
}

function cacheOwnerPdfAttachment(chatId, inputFile) {
    if (!inputFile || !inputFile.content_base64) return null;

    const chatDir = path.join(OWNER_ATTACHMENT_CACHE_DIR, attachmentChatKey(chatId));
    fs.mkdirSync(chatDir, { recursive: true });

    const filename = sanitizeAttachmentFilename(inputFile.name, 'owner_input.pdf');
    const timestamp = Date.now();
    const cachedPath = path.join(chatDir, `${timestamp}_${filename}`);
    try {
        fs.writeFileSync(cachedPath, Buffer.from(inputFile.content_base64, 'base64'));
    } catch (error) {
        console.error('Failed to cache owner PDF attachment:', error);
    }

    const cachedFile = {
        ...inputFile,
        name: filename,
        cached_path: cachedPath,
    };
    ownerPendingPdfByChat[chatId] = {
        inputFile: cachedFile,
        createdAt: timestamp,
        expiresAt: timestamp + WA_ATTACHMENT_CACHE_TTL_MS,
    };
    return cachedFile;
}

function isPdfFollowUpInstruction(message) {
    const text = (message || '').trim();
    if (!text) return false;

    const patterns = [
        /\b(?:edit|ubah|rapiin|rangkumin|rangkum|ringkas|benerin|convert|jadiin|bikin(?:in)?|buat(?:kan)?)\b/i,
        /\b(?:hapus|buang|remove)\s+halaman\b/i,
        /\b(?:tambah(?:in)?|kasih|buat(?:kan)?)\s+cover\b/i,
        /\b(?:watermark|annotate|catatan|highlight)\b/i,
        /\b(?:merge|gabung(?:in)?|split|pisah(?:kan)?)\b.*\bpdf\b/i,
        /\bpdf\b/i,
        /\b(?:page|halaman)\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
}

async function extractOwnerPdfAttachment(msg, chatId, replyLanguage) {
    if (!msg?.hasMedia) return { inputFile: null, stopProcessing: false };

    let media;
    try {
        media = await msg.downloadMedia();
    } catch (error) {
        console.error('Failed to download owner attachment:', error);
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfReadFailed', replyLanguage),
            stopProcessing: true,
        };
    }

    if (!media || !media.data) {
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfReadFailed', replyLanguage),
            stopProcessing: true,
        };
    }

    const mimeType = (media.mimetype || '').toLowerCase().trim();
    if (mimeType !== 'application/pdf') {
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfUnsupported', replyLanguage),
            stopProcessing: true,
        };
    }

    let buffer;
    try {
        buffer = Buffer.from(media.data, 'base64');
    } catch (error) {
        console.error('Failed to decode owner PDF attachment:', error);
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfReadFailed', replyLanguage),
            stopProcessing: true,
        };
    }

    if (!buffer.length) {
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfReadFailed', replyLanguage),
            stopProcessing: true,
        };
    }

    if (buffer.length > WA_ATTACHMENT_MAX_BYTES) {
        return {
            inputFile: null,
            reply: getLocalizedBridgeText('pdfTooLarge', replyLanguage, {
                detail: formatAttachmentSize(WA_ATTACHMENT_MAX_BYTES),
            }),
            stopProcessing: true,
        };
    }

    const filename = sanitizeAttachmentFilename(media.filename || 'owner_input.pdf', 'owner_input.pdf');
    const sha256 = hashBufferSha256(buffer);
    return {
        inputFile: {
            id: `pdf_${sha256.slice(0, 12)}`,
            name: filename,
            kind: 'document',
            mime_type: 'application/pdf',
            size_bytes: buffer.length,
            sha256,
            content_base64: media.data,
        },
        stopProcessing: false,
    };
}

async function extractOwnerFinanceImageAttachment(msg, chatId, replyLanguage, hint = '') {
    if (!msg?.hasMedia) return { handled: false };
    if (!LILY_FINANCE_VESSEL_URL) return { handled: false };

    let media;
    try {
        media = await msg.downloadMedia();
    } catch (error) {
        console.error('Failed to download owner finance image:', error);
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageReadFailed', replyLanguage),
        };
    }

    if (!media?.data) {
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageReadFailed', replyLanguage),
        };
    }

    const mimeType = (media.mimetype || '').toLowerCase().trim();
    if (!mimeType.startsWith('image/')) {
        return { handled: false };
    }

    if (!isSupportedFinanceImageMime(mimeType)) {
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageUnsupported', replyLanguage),
        };
    }

    let buffer;
    try {
        buffer = Buffer.from(media.data, 'base64');
    } catch (error) {
        console.error('Failed to decode owner finance image:', error);
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageReadFailed', replyLanguage),
        };
    }

    if (!buffer.length) {
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageReadFailed', replyLanguage),
        };
    }
    if (buffer.length > LILY_FINANCE_IMAGE_MAX_BYTES) {
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeImageTooLarge', replyLanguage, {
                detail: formatAttachmentSize(LILY_FINANCE_IMAGE_MAX_BYTES),
            }),
        };
    }

    try {
        const parsed = await requestFinanceApi(
            'post',
            '/api/finance/parse/image',
            {
                image_base64: media.data,
                mime_type: mimeType,
                source: 'wa',
                hint: hint || '',
            },
            30000,
        );
        if (!parsed?.ok || !parsed.transaction) {
            const failureKey = financeImageParseFailureKey(parsed?.reason || 'unknown');
            if (failureKey === 'financeImageServiceBusy') {
                setPendingFinanceImageFallback(chatId, replyLanguage, parsed?.reason || 'unknown');
            }
            return {
                handled: true,
                reply: getLocalizedBridgeText(failureKey, replyLanguage, { detail: parsed?.reason || 'unknown' }),
            };
        }

        const draftTransactions = financeDraftFromParseResponse(parsed);
        setPendingFinanceDraft(chatId, draftTransactions, replyLanguage, 'image');
        clearPendingFinanceImageFallback(chatId);
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeDraftReady', replyLanguage, {
                detail: formatFinanceDraftDetail(draftTransactions, replyLanguage),
            }),
        };
    } catch (error) {
        console.error('Finance image parse failed:', error?.message || error);
        if (isFinanceImageServiceBusyReason(error?.message || '')) {
            setPendingFinanceImageFallback(chatId, replyLanguage, error?.message || 'unknown');
            return {
                handled: true,
                reply: getLocalizedBridgeText('financeImageServiceBusy', replyLanguage, { detail: error?.message || 'unknown' }),
            };
        }
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeUnavailable', replyLanguage),
        };
    }
}

function audioExtensionFromMime(mimeType = '') {
    const lowerMime = mimeType.toLowerCase();
    if (lowerMime.includes('ogg') || lowerMime.includes('opus')) return '.ogg';
    if (lowerMime.includes('mpeg') || lowerMime.includes('mp3')) return '.mp3';
    if (lowerMime.includes('wav')) return '.wav';
    if (lowerMime.includes('mp4') || lowerMime.includes('m4a')) return '.m4a';
    return '.audio';
}

async function transcribeWaVoiceMessage(msg, replyLanguage = 'id') {
    if (!LILY_STT_TRANSCRIBE_URL) {
        return { ok: false, skipped: true, detail: 'STT Vessel is not configured.' };
    }
    if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
        return { ok: false, skipped: true, detail: 'Node FormData/Blob is unavailable.' };
    }

    let media;
    try {
        media = await msg.downloadMedia();
    } catch (error) {
        console.warn('Failed to download WhatsApp voice message:', error?.message || error);
        return { ok: false, detail: 'Could not download voice message.' };
    }

    if (!media?.data) {
        return { ok: false, detail: 'Voice message media was empty.' };
    }

    let buffer;
    try {
        buffer = Buffer.from(media.data, 'base64');
    } catch (error) {
        console.warn('Failed to decode WhatsApp voice message:', error?.message || error);
        return { ok: false, detail: 'Could not decode voice message.' };
    }

    if (!buffer.length) {
        return { ok: false, detail: 'Voice message was empty.' };
    }
    if (buffer.length > LILY_STT_MAX_AUDIO_BYTES) {
        return { ok: false, detail: `Voice message is too large: ${formatAttachmentSize(buffer.length)}.` };
    }

    const mimeType = media.mimetype || 'audio/ogg';
    const filename = sanitizeGenericFilename(
        media.filename || `wa_voice_${Date.now()}${audioExtensionFromMime(mimeType)}`,
        `wa_voice_${Date.now()}.ogg`,
    );
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    const language = normalizeReplyLanguage(replyLanguage) === 'en' ? 'en' : '';
    if (language) {
        form.append('language', language);
    }

    try {
        const response = await axios.post(LILY_STT_TRANSCRIBE_URL, form, {
            headers: buildSttHeaders(),
            timeout: LILY_STT_TIMEOUT_MS,
            maxBodyLength: LILY_STT_MAX_AUDIO_BYTES + 1024 * 1024,
            validateStatus: () => true,
        });
        if (response.status < 200 || response.status >= 300) {
            return { ok: false, detail: `STT Vessel HTTP ${response.status}` };
        }
        const text = (response.data?.text || '').toString().trim();
        if (!text) {
            return { ok: false, detail: 'STT Vessel returned empty text.' };
        }
        return {
            ok: true,
            text,
            language: response.data?.language || '',
            durationSeconds: Number(response.data?.duration_seconds || 0),
        };
    } catch (error) {
        console.warn('WhatsApp voice transcription failed:', error?.message || error);
        return { ok: false, detail: describeCoreRequestError(error) };
    }
}

function getActiveOwnerPresence() {
    const current = normalizeOwnerPresence(ownerPresence);
    const expiresAt = current.expires_at ? new Date(current.expires_at).getTime() : 0;
    if (expiresAt && expiresAt <= Date.now()) {
        ownerPresence = defaultOwnerPresence();
        saveOwnerPresence();
        return ownerPresence;
    }
    return current;
}

function setOwnerPresence(update = {}) {
    ownerPresence = normalizeOwnerPresence(update);
    saveOwnerPresence();
    secretary.presenceChanged();
    return ownerPresence;
}

function stripCommandTrailingPunctuation(value = '') {
    return (value || '').toString().trim().replace(/[.!?,;:\s]+$/g, '').trim();
}

function stripLilyCommandPrefix(message = '') {
    return stripCommandTrailingPunctuation((message || '').toString().trim().replace(/^lily[,\s:.-]*/i, ''));
}

function parseOwnerPresenceCommand(message) {
    const text = stripCommandTrailingPunctuation(message);
    const withoutLily = stripLilyCommandPrefix(text);
    const lower = withoutLily.toLowerCase().replace(/\s+/g, ' ');
    if (!lower) return null;

    const directMap = [
        { pattern: /^(?:status\s+)?(?:available|normal|online|aktif|ada)$/i, status: 'available' },
        { pattern: /^(?:status\s+)?(?:kantor|kerja|office|at office)$/i, status: 'at_office' },
        { pattern: /^(?:(?:aku\s+)?mau\s+)?(?:tidur|sleep|sleeping|istirahat)$/i, status: 'sleeping' },
        { pattern: /^(?:(?:aku\s+)?lagi\s+)?(?:main\s+game|gaming|ranked|game)$/i, status: 'gaming' },
        { pattern: /^(?:status\s+)?(?:sibuk|busy|meeting)$/i, status: 'busy' },
        { pattern: /^(?:status\s+)?(?:away|pergi|keluar)$/i, status: 'away' },
    ];

    const matched = directMap.find((item) => item.pattern.test(lower));
    if (matched) {
        return { type: 'owner_presence', status: matched.status, note: '', source: 'wa' };
    }

    const customMatch = withoutLily.match(/^status\s+(.+)$/i);
    if (customMatch) {
        const note = cleanPresenceNote(customMatch[1]);
        if (!note) return null;
        return { type: 'owner_presence', status: 'busy', note, label: 'Busy', source: 'wa' };
    }

    return null;
}

function parseOwnerStatusCommand(message) {
    const text = stripCommandTrailingPunctuation(message);
    const withoutLily = stripLilyCommandPrefix(text);
    const lower = withoutLily.toLowerCase().replace(/\s+/g, ' ');
    if (!lower) return null;

    if (/^(?:presence|availability|my status|status (?:saya|aku|gue|gw))$/i.test(lower)) {
        return { type: 'wa_presence_status' };
    }

    if (/^(?:file\s+status|status\s+file|cek\s+file\s+status|cek\s+status\s+file|file vessels?|storage status)$/i.test(lower)) {
        return { type: 'wa_status', target: 'file' };
    }

    if (/^(?:finance\s+status|status\s+finance|cek\s+finance\s+status|cek\s+status\s+finance|finance vessel)$/i.test(lower)) {
        return { type: 'wa_status', target: 'finance' };
    }

    if (/^(?:status|status\s+lily|lily\s+status|cek\s+status|cek\s+status\s+lily|status\s+system|status\s+sistem|status\s+service|status\s+services|status\s+semua|status\s+all)$/i.test(lower)) {
        return { type: 'wa_status', target: 'all' };
    }

    return null;
}

function parseOwnerHelpCommand(message) {
    const text = stripCommandTrailingPunctuation(message);
    const withoutLily = stripLilyCommandPrefix(text);
    const lower = withoutLily.toLowerCase().replace(/\s+/g, ' ');
    if (!lower) return null;

    if (/^(?:\/help|help|bantuan|commands?|command|menu|fitur|cara pakai|bisa apa)$/i.test(lower)) {
        return { type: 'wa_help' };
    }

    return null;
}

function isResetLilyCommand(message) {
    return /^\/resetlily$/i.test(stripCommandTrailingPunctuation(message));
}

function parseOwnerUtilityCommand(message) {
    const rawText = stripCommandTrailingPunctuation(message).replace(/\s+/g, ' ').trim();
    const text = rawText.toLowerCase();
    if (text === '/why') return { type: 'route_debug' };
    if (text === '/retry') return { type: 'retry_last' };
    if (text === '/recap') return { type: 'conversation_recap' };
    if (text === '/context') return { type: 'context_status' };
    if (text === '/forgetlast') return { type: 'forget_last' };
    if (text === '/cancel') return { type: 'cancel_pending' };
    if (text === '/resume') return { type: 'proactive_resume' };
    if (text === '/serious') return { type: 'owner_mood_alias', mode: 'serious' };
    if (text === '/short') return { type: 'owner_reply_length', mode: 'short' };
    if (text === '/normal') return { type: 'owner_reply_length', mode: 'normal', resetMood: true };
    if (text === '/detail') return { type: 'owner_reply_length', mode: 'detail' };

    const pinMatch = rawText.match(/^\/pinmemory\s+(.+)$/i);
    if (pinMatch) return { type: 'pin_memory', text: pinMatch[1].trim() };
    const unpinMatch = rawText.match(/^\/unpinmemory\s+(\d{1,2})$/i);
    if (unpinMatch) return { type: 'unpin_memory', index: Number(unpinMatch[1]) };

    const quietMatch = text.match(/^\/quiet(?:\s+(\d{1,3})\s*(m|h|d|menit|jam|hari))?$/i);
    if (quietMatch) {
        const amount = Math.max(1, Number(quietMatch[1] || 2));
        const unit = (quietMatch[2] || 'h').toLowerCase();
        const multiplier = ['m', 'menit'].includes(unit)
            ? 60 * 1000
            : ['d', 'hari'].includes(unit)
                ? 24 * 60 * 60 * 1000
                : 60 * 60 * 1000;
        return {
            type: 'proactive_quiet',
            durationMs: Math.min(7 * 24 * 60 * 60 * 1000, amount * multiplier),
        };
    }

    return null;
}

function parseFamilyOwnerCommand(message) {
    const text = stripCommandTrailingPunctuation(message).replace(/\s+/g, ' ').trim();
    if (/^\/keluarga$/i.test(text)) return { type: 'family_status' };
    const sms = text.match(/^\/sms(?:\s+(.+))?$/i);
    if (sms) {
        const deviceName = (sms[1] || '').trim();
        return deviceName
            ? { type: 'family_sms', deviceName }
            : { type: 'invalid', reply: 'Formatnya: /sms nama-perangkat. Isi SMS dibuka hanya lewat panel Family privat.' };
    }
    const location = text.match(/^\/lokasi(?:\s+(.+))?$/i);
    if (location) {
        const parts = (location[1] || '').trim().split(/\s+/).filter(Boolean);
        const last = (parts[parts.length - 1] || '').toLowerCase();
        const mode = last === 'live' ? 'live' : last === 'hemat' ? 'eco' : '';
        if (mode) parts.pop();
        const deviceName = parts.join(' ');
        if (!deviceName) return { type: 'invalid', reply: 'Formatnya: /lokasi nama-perangkat [live|hemat].' };
        return mode
            ? { type: 'family_location_mode', deviceName, mode }
            : { type: 'family_location', deviceName };
    }
    return null;
}

async function forwardOwnerPresenceToCore(presence) {
    try {
        await requestCore('post', `${LILY_CORE_URL}/api/owner/presence`, presence, 5000);
        return true;
    } catch (error) {
        console.warn('Owner presence could not be forwarded to Core:', error?.message || error);
        return false;
    }
}

function getContactProfile(chatId) {
    const normalizedChatId = normalizeDirectChatId(chatId);
    const identityNumber = normalizePhoneNumber((chatId || '').split('@')[0]);
    if (!identityNumber) return null;

    let profileKey = contactProfiles[identityNumber] ? identityNumber : '';
    if (!profileKey && normalizedChatId) {
        profileKey = Object.keys(contactProfiles).find((key) =>
            Array.isArray(contactProfiles[key]?.chatIds)
            && contactProfiles[key].chatIds.includes(normalizedChatId)
        ) || '';
    }

    if (!profileKey) {
        profileKey = identityNumber;
        contactProfiles[profileKey] = {
            phoneNumber: identityNumber,
            name: "",
            label: "general",
            relation: "unknown",
            notes: "",
            isKnownContact: false,
            style: 'default',
            introduced: false,
            lastMessageAt: "",
            lastSummaryAt: "",
            chatIds: normalizedChatId ? [normalizedChatId] : [],
        };
        saveContactProfiles();
    } else if (
        normalizedChatId
        && !contactProfiles[profileKey].chatIds?.includes(normalizedChatId)
    ) {
        contactProfiles[profileKey].chatIds = [
            ...(Array.isArray(contactProfiles[profileKey].chatIds)
                ? contactProfiles[profileKey].chatIds
                : []),
            normalizedChatId,
        ];
        saveContactProfiles();
    }

    return contactProfiles[profileKey];
}

function linkContactProfilePhone(chatId, phoneNumber) {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone) return getContactProfile(chatId);

    const normalizedChatId = normalizeDirectChatId(chatId);
    const sourceProfile = getContactProfile(chatId);
    const sourceKey = Object.keys(contactProfiles).find((key) => contactProfiles[key] === sourceProfile) || '';
    const phoneProfile = contactProfiles[normalizedPhone] || null;
    const sourceName = normalizeContactDisplayName(sourceProfile?.name);
    const phoneName = normalizeContactDisplayName(phoneProfile?.name);
    const merged = {
        ...(sourceProfile || {}),
        ...(phoneProfile || {}),
        phoneNumber: normalizedPhone,
        name: phoneName && !isPhoneLikeDisplayName(phoneName) ? phoneName : sourceName,
        chatIds: uniqueNonEmpty([
            ...(Array.isArray(sourceProfile?.chatIds) ? sourceProfile.chatIds : []),
            ...(Array.isArray(phoneProfile?.chatIds) ? phoneProfile.chatIds : []),
            normalizedChatId,
        ]),
    };

    contactProfiles[normalizedPhone] = merged;
    if (sourceKey && sourceKey !== normalizedPhone) {
        delete contactProfiles[sourceKey];
    }
    saveContactProfiles();
    return merged;
}

function sortExternalInboxNewestFirst() {
    externalInbox.sort((a, b) => {
        const aTime = new Date(a?.createdAt || 0).getTime();
        const bTime = new Date(b?.createdAt || 0).getTime();
        return bTime - aTime;
    });
}

function getLatestInboxPerChat(items = []) {
    const latestByChat = new Map();

    for (const item of items) {
        if (!isValidExternalInboxItem(item)) {
            continue;
        }

        const chatId = (item.chatId || '').toString().trim();
        if (!chatId) {
            continue;
        }

        const existing = latestByChat.get(chatId);
        const itemTime = new Date(item?.createdAt || 0).getTime();
        const existingTime = existing ? new Date(existing?.createdAt || 0).getTime() : 0;

        if (!existing || itemTime >= existingTime) {
            latestByChat.set(chatId, item);
        }
    }

    return [...latestByChat.values()].sort(
        (a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()
    );
}

function isValidExternalInboxItem(item) {
    const chatId = (item?.chatId || '').toString().trim();
    const message = (item?.originalMessage || item?.summary || '').toString().trim();

    if (!chatId || chatId === '0@c.us') {
        return false;
    }

    if (!message) {
        return false;
    }

    if (message.length > 400 && !message.includes(' ')) {
        return false;
    }

    return true;
}

function normalizeContactDisplayName(value) {
    const text = (value || '').toString().trim();
    if (!text) return '';
    return text.replace(/\s+/g, ' ');
}

function deriveDisplayNameFromMessage(message = '') {
    const lowerMessage = (message || '').toLowerCase();

    if (lowerMessage.includes('mikomi') || lowerMessage.includes('neomi')) {
        return 'Mikomi';
    }

    if (lowerMessage.includes('batch po')) {
        return 'Toko PO';
    }

    return '';
}

function isPhoneLikeDisplayName(value = '') {
    const normalized = normalizeContactDisplayName(value);
    if (!normalized) return true;

    const digitsOnly = normalized.replace(/\D/g, '');
    return digitsOnly.length >= 8 && digitsOnly.length === normalized.replace(/[^0-9+()\-\s]/g, '').replace(/\D/g, '').length;
}

function isUsefulContactDisplayName(value = '') {
    const normalized = normalizeContactDisplayName(value);
    if (!normalized || normalized === '0' || isPhoneLikeDisplayName(normalized)) return false;
    return !['unknown', 'circle member', 'someone'].includes(normalized.toLowerCase());
}

async function resolveContactDisplayName(chatId, existingProfile = null, chatRef = null) {
    let profile = existingProfile || getContactProfile(chatId);
    let contact = chatRef?.contact || null;
    if (!contact) {
        try {
            contact = await client.getContactById(chatId);
        } catch (error) {
            // Ignore contact lookup errors and fall back to cached values/number.
        }
    }

    const resolvedPhone = verifiedDirectPhoneNumber(chatId, contact,
        chatRef?.phoneNumber ? [chatRef.phoneNumber] : [], profile?.phoneNumber || '');
    if (resolvedPhone) {
        profile = linkContactProfilePhone(chatId, resolvedPhone);
    }
    const fallbackNumber = profile?.phoneNumber || normalizePhoneNumber((chatId || '').split('@')[0]) || chatId;
    const candidates = [
        profile?.name,
        chatRef?.name,
        chatRef?.formattedTitle,
        contact?.name,
        contact?.pushname,
        contact?.shortName,
    ];

    const resolved = candidates
        .map(normalizeContactDisplayName)
        .find(isUsefulContactDisplayName);

    if (profile && resolved && profile.name !== resolved) {
        profile.name = resolved;
        saveContactProfiles();
    }

    return resolved || fallbackNumber;
}

function getCachedContactDisplayName(chatId, fallbackName = '') {
    const profile = getContactProfile(chatId);
    const fallbackNumber = profile?.phoneNumber || normalizePhoneNumber((chatId || '').split('@')[0]) || chatId;
    const profileName = normalizeContactDisplayName(profile?.name);
    const fallbackDisplayName = normalizeContactDisplayName(fallbackName);

    if (profileName && !isPhoneLikeDisplayName(profileName)) {
        return profileName;
    }

    if (fallbackDisplayName && !isPhoneLikeDisplayName(fallbackDisplayName)) {
        return fallbackDisplayName;
    }

    return fallbackNumber;
}

function trimExternalInbox() {
    const retained = inboxDelivery?.retainedChats() || new Set();
    const seen = new Set();
    const kept = externalInbox.filter((item, index) => {
        const keep = index < 50 || (retained.has(item.chatId) && !seen.has(item.chatId));
        seen.add(item.chatId);
        return keep;
    });
    const changed = kept.length !== externalInbox.length;
    externalInbox.splice(0, externalInbox.length, ...kept);
    return changed;
}

function syncExternalInboxMetadata() {
    const sanitizedItems = [];
    let changed = false;

    for (const rawItem of externalInbox) {
        if (!isValidExternalInboxItem(rawItem)) {
            changed = true;
            continue;
        }

        const chatId = (rawItem.chatId || '').toString().trim();
        const profile = getContactProfile(chatId);
        const originalMessage = (rawItem.originalMessage || rawItem.summary || '').toString().trim();
        const contextualName = deriveDisplayNameFromMessage(originalMessage);
        const resolvedName = getCachedContactDisplayName(chatId, rawItem.name);
        const unresolvedPhone = profile?.phoneNumber || normalizePhoneNumber((chatId || '').split('@')[0]) || chatId;
        const nextName = (resolvedName === unresolvedPhone || isPhoneLikeDisplayName(resolvedName))
            ? (contextualName || resolvedName)
            : resolvedName;
        const nextItem = {
            ...rawItem,
            chatId,
            phoneNumber: profile?.phoneNumber || normalizePhoneNumber((chatId || '').split('@')[0]),
            name: nextName,
            relation: profile?.relation || rawItem.relation || 'unknown',
            label: profile?.label || rawItem.label || 'general',
            originalMessage,
            summary: (rawItem.summary || '').toString().trim() || originalMessage,
            createdAt: rawItem.createdAt || new Date().toISOString(),
        };

        if (profile && contextualName && (!profile.name || profile.name === nextItem.phoneNumber || isPhoneLikeDisplayName(profile.name))) {
            profile.name = contextualName;
            changed = true;
            saveContactProfiles();
        }

        if (
            nextItem.phoneNumber !== rawItem.phoneNumber
            || nextItem.name !== rawItem.name
            || nextItem.relation !== rawItem.relation
            || nextItem.label !== rawItem.label
            || nextItem.originalMessage !== rawItem.originalMessage
            || nextItem.summary !== rawItem.summary
        ) {
            changed = true;
        }

        sanitizedItems.push(nextItem);
    }

    externalInbox.length = 0;
    externalInbox.push(...sanitizedItems);
    sortExternalInboxNewestFirst();

    changed = trimExternalInbox() || changed;

    const previousIds = sanitizedItems.map((item) => item.id).join('|');
    const currentIds = externalInbox.map((item) => item.id).join('|');
    if (previousIds !== currentIds) {
        changed = true;
    }

    if (changed) {
        saveExternalInbox();
    }
}

async function refreshExternalInboxContactNames() {
    const chatIds = uniqueNonEmpty(
        externalInbox
            .map((item) => normalizeDirectChatId(item?.chatId || ''))
            .filter(Boolean),
    ).slice(0, 30);
    if (!chatIds.length) return;

    let changed = false;
    for (const chatId of chatIds) {
        const profile = getContactProfile(chatId);
        const previousName = getCachedContactDisplayName(chatId);
        const resolvedName = await resolveContactDisplayName(chatId, profile);
        if (!isUsefulContactDisplayName(resolvedName) || resolvedName === previousName) continue;
        const refreshedProfile = getContactProfile(chatId);

        for (const item of externalInbox) {
            if (item.chatId !== chatId) continue;
            item.name = resolvedName;
            item.phoneNumber = refreshedProfile?.phoneNumber || item.phoneNumber;
            changed = true;
        }
    }

    if (changed) {
        saveExternalInbox();
    }
}

function markContactIntroduced(chatId) {
    const profile = getContactProfile(chatId);
    if (!profile) return;

    if (!profile.introduced || !profile.isKnownContact) {
        profile.introduced = true;
        profile.isKnownContact = true;
        saveContactProfiles();
    }
}

function updateContactLastMessage(chatId) {
    const profile = getContactProfile(chatId);
    if (!profile) return;

    profile.lastMessageAt = new Date().toISOString();
    saveContactProfiles();
}

function updateOwnerMemory(message) {
    const cleanMessage = (message || '').trim();
    if (!cleanMessage) return;

    ownerMemory.lastInteractions = [cleanMessage, ...ownerMemory.lastInteractions.filter((item) => item !== cleanMessage)].slice(0, 8);

    const topic = cleanMessage.length > 80 ? `${cleanMessage.slice(0, 77)}...` : cleanMessage;
    ownerMemory.recentTopics = [topic, ...ownerMemory.recentTopics.filter((item) => item !== topic)].slice(0, 6);

    saveOwnerMemory();
}

function addOwnerMemoryNote(note) {
    const cleanNote = (note || '').trim();
    if (!cleanNote) return false;

    ownerMemory.notes = [cleanNote, ...ownerMemory.notes.filter((item) => item !== cleanNote)].slice(0, 20);
    saveOwnerMemory();
    return true;
}

function setOwnerPreferredName(name) {
    const cleanName = (name || '').trim();
    if (!cleanName) return false;

    ownerMemory.preferredName = cleanName;
    saveOwnerMemory();
    return true;
}

function setOwnerNickname(name) {
    const cleanName = (name || '').trim();
    if (!cleanName) return false;

    ownerMemory.nickname = cleanName;
    saveOwnerMemory();
    return true;
}

function findPhoneNumberInText(text) {
    const match = (text || '').match(/(?:\+?62|0)?\d{9,15}/);
    return match ? normalizePhoneNumber(match[0]) : '';
}

function setContactTag(phoneNumber, relation, label, notes = "") {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return false;

    if (!contactProfiles[normalized]) {
        contactProfiles[normalized] = {
            phoneNumber: normalized,
            name: "",
            label: label || "general",
            relation: relation || "unknown",
            notes: notes || "",
            isKnownContact: false,
            style: "default",
            introduced: false,
            lastMessageAt: "",
            lastSummaryAt: "",
        };
    }

    if (relation) contactProfiles[normalized].relation = relation;
    if (label) contactProfiles[normalized].label = label;
    if (notes) contactProfiles[normalized].notes = notes;
    saveContactProfiles();
    return true;
}

function normalizeFileVesselKey(value) {
    return (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeFileVesselAlias(value) {
    return (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseFileVesselKeyValueList(rawValue) {
    const entries = {};
    for (const item of (rawValue || '').split(/[;\n]+/)) {
        const trimmed = item.trim();
        if (!trimmed || !trimmed.includes('=')) continue;

        const separatorIndex = trimmed.indexOf('=');
        const key = normalizeFileVesselKey(trimmed.slice(0, separatorIndex));
        const value = trimmed.slice(separatorIndex + 1).trim();
        if (key && value) entries[key] = value;
    }
    return entries;
}

function parseFileVesselAliasList(rawValue) {
    const entries = {};
    for (const [key, value] of Object.entries(parseFileVesselKeyValueList(rawValue))) {
        entries[key] = value
            .split(',')
            .map((alias) => normalizeFileVesselAlias(alias))
            .filter(Boolean);
    }
    return entries;
}

function commonFileVesselAliases(key, label) {
    const aliases = new Set([normalizeFileVesselAlias(key), normalizeFileVesselAlias(label)]);
    const normalizedKey = normalizeFileVesselKey(key);
    const normalizedLabel = normalizeFileVesselAlias(label);
    if (['pc', 'windows', 'iris_forest', 'irisforest'].includes(normalizedKey) || normalizedLabel.includes('lily storage host')) {
        ['pc', 'komputer', 'computer', 'windows', 'Lily-Storage-Host', 'Lily-Storage-Host', 'lily storage host', 'Lily-Storage-Host', 'storage pc'].forEach((alias) => aliases.add(normalizeFileVesselAlias(alias)));
    }
    if (['laptop', 'lily-core-host', 'linux', 'Lily-Voice-Host'].includes(normalizedKey) || normalizedLabel.includes('lily-core-host') || normalizedLabel.includes('laptop')) {
        ['laptop', 'Lily-Core-Host', 'Lily-Core-Host', 'lily-core-host', 'linux', 'device ini', 'laptop ini', 'local laptop'].forEach((alias) => aliases.add(normalizeFileVesselAlias(alias)));
    }
    return [...aliases].filter(Boolean);
}

function buildFileVesselRegistry() {
    const urls = parseFileVesselKeyValueList(LILY_FILE_VESSELS_RAW);
    const labels = parseFileVesselKeyValueList(LILY_FILE_VESSEL_LABELS_RAW);
    const tokens = parseFileVesselKeyValueList(LILY_FILE_VESSEL_TOKENS_RAW);
    const customAliases = parseFileVesselAliasList(LILY_FILE_VESSEL_ALIASES_RAW);
    const defaultKey = normalizeFileVesselKey(LILY_FILE_VESSEL_DEFAULT_KEY);

    if (LILY_FILE_VESSEL_URL && !Object.keys(urls).length) {
        urls[defaultKey || 'default'] = LILY_FILE_VESSEL_URL;
    } else if (LILY_FILE_VESSEL_URL && defaultKey && !urls[defaultKey]) {
        urls[defaultKey] = LILY_FILE_VESSEL_URL;
    }

    const vessels = [];
    for (const [key, rawUrl] of Object.entries(urls)) {
        const url = (rawUrl || '').trim().replace(/\/+$/, '');
        if (!url) continue;

        const label = (labels[key] || (key === 'default' ? 'File Vessel' : key)).trim();
        const aliasSet = new Set([
            ...commonFileVesselAliases(key, label),
            ...(customAliases[key] || []),
        ]);
        vessels.push({
            key,
            label,
            url,
            token: (tokens[key] || LILY_FILE_VESSEL_TOKEN || '').trim(),
            aliases: [...aliasSet].filter(Boolean).sort((a, b) => b.length - a.length),
            isDefault: defaultKey ? key === defaultKey : vessels.length === 0,
        });
    }

    if (vessels.length && !vessels.some((vessel) => vessel.isDefault)) {
        vessels[0].isDefault = true;
    }

    return vessels;
}

function getDefaultFileVessel() {
    return FILE_VESSEL_REGISTRY.find((vessel) => vessel.isDefault) || FILE_VESSEL_REGISTRY[0] || null;
}

function getFileVesselByKey(key) {
    const normalizedKey = normalizeFileVesselKey(key);
    if (!normalizedKey) return null;
    return FILE_VESSEL_REGISTRY.find((vessel) => vessel.key === normalizedKey) || null;
}

function isAllFileVesselsRequest(message) {
    const text = normalizeFileVesselAlias(message);
    return /\b(?:semua|all|any)\s+(?:device|devices|perangkat|vessel|storage)\b/i.test(text)
        || /\b(?:semua|all)\s+(?:pc|laptop|storage)\b/i.test(text)
        || /\b(?:mana aja|sembarang device)\b/i.test(text);
}

function matchRequestedFileVessel(message) {
    const text = normalizeFileVesselAlias(message);
    if (!text) return null;

    for (const vessel of FILE_VESSEL_REGISTRY) {
        for (const alias of vessel.aliases) {
            if (!alias) continue;
            const escapedAlias = escapeOpenClawRegex(alias).replace(/\s+/g, '\\s+');
            const pattern = new RegExp(`(?:^|\\b)${escapedAlias}(?=\\b|$)`, 'i');
            if (pattern.test(text)) {
                return vessel;
            }
        }
    }

    return null;
}

function stripFileVesselDeviceWords(value) {
    let output = value || '';
    const removePhrases = [
        'semua device',
        'semua devices',
        'all devices',
        'all device',
        'semua perangkat',
        'semua storage',
        'mana aja',
        'sembarang device',
    ];

    for (const phrase of removePhrases) {
        output = output.replace(new RegExp(`\\b${escapeOpenClawRegex(phrase).replace(/\s+/g, '\\s+')}\\b`, 'gi'), ' ');
    }

    for (const vessel of FILE_VESSEL_REGISTRY) {
        for (const alias of vessel.aliases) {
            if (!alias) continue;
            output = output.replace(new RegExp(`\\b${escapeOpenClawRegex(alias).replace(/\s+/g, '\\s+')}\\b`, 'gi'), ' ');
        }
    }

    return output;
}

function describeFileVesselScope(command = {}) {
    if (command.searchAllVessels) return 'semua device';
    const vessel = getFileVesselByKey(command.vesselKey) || getDefaultFileVessel();
    return vessel?.label || 'File Vessel';
}

function parseFileVesselRoot(message) {
    const lower = (message || '').toString().toLowerCase().replace(/\s+/g, ' ');
    if (/\b(?:desktop|dekstop|layar utama)\b/i.test(lower)) return 'desktop';
    if (
        /\b(?:pictures|picture folder|pictures folder|photos|photos folder|gallery|galeri)\b/i.test(lower)
        || /\bfolder\s+(?:foto|gambar|image|images)\b/i.test(lower)
        || /\b(?:foto|gambar|image|images)\s+folder\b/i.test(lower)
    ) {
        return 'pictures';
    }
    return 'downloads';
}

function normalizeFileVesselQuery(value) {
    return (value || '')
        .replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
        .split(/\s+/)
        .map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))
        .filter((token) => token && !/^[._-]+$/.test(token))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseFileVesselSendCommand(message) {
    const text = stripCommandTrailingPunctuation(message);
    const withoutLily = stripLilyCommandPrefix(text);
    const lower = withoutLily.toLowerCase().replace(/\s+/g, ' ');
    const wantsFileSend = /\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin)\b.*\b(?:file|gambar|image|foto|photo|wallpaper)\b/i.test(lower)
        || /\b(?:file|gambar|image|foto|photo|wallpaper)\b.*\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin)\b/i.test(lower);
    if (!wantsFileSend) return null;

    const requestedVessel = matchRequestedFileVessel(withoutLily);
    const searchAllVessels = isAllFileVesselsRequest(withoutLily);
    const root = parseFileVesselRoot(lower);
    const desiredKind = /\b(?:gambar|image|foto|photo|wallpaper)\b/i.test(lower) ? 'image' : 'file';
    let query = normalizeFileVesselQuery(stripFileVesselDeviceWords(withoutLily)
        .replace(/\b(?:tolong|please|pls)\b/gi, ' ')
        .replace(/\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin)\b/gi, ' ')
        .replace(/\b(?:file|gambar|image|foto|photo)\b/gi, ' ')
        .replace(/\b(?:dari|di|ke|from|in|at)\b/gi, ' ')
        .replace(/\b(?:folder|pc|komputer|laptop|diari|diary|download|downloads|desktop|dekstop|pictures|photos|gallery|galeri)\b/gi, ' ')
        .replace(/\b(?:dah|dong|ya|klo|kalau|kalo|gak|gk|nggak|ga|salah|ada|kayaknya|mungkin|juga|aja|lagi|lily)\b/gi, ' ')
    );

    if (!query && /\bwallpaper\b/i.test(lower)) {
        query = 'wallpaper';
    }
    const vesselFields = {
        vesselKey: searchAllVessels ? '' : (requestedVessel?.key || ''),
        searchAllVessels,
    };
    if (!query) {
        return { type: 'file_vessel_send', root, query: '', desiredKind, source: 'wa', ...vesselFields };
    }
    return { type: 'file_vessel_send', root, query, desiredKind, source: 'wa', ...vesselFields };
}

function parseFileVesselListLimit(message) {
    const match = (message || '').toString().match(/\b(?:limit|max|maks(?:imal)?|ambil|tampil(?:kan)?)?\s*([1-9]\d?)\s*(?:file|files|item|items)?\b/i);
    const parsed = Number(match?.[1] || LILY_FILE_VESSEL_LIST_LIMIT);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(50, parsed)) : 10;
}

function parseFileVesselListCommand(message) {
    const text = stripCommandTrailingPunctuation(message);
    const withoutLily = stripLilyCommandPrefix(text);
    const lower = withoutLily.toLowerCase().replace(/\s+/g, ' ');
    if (!lower) return null;

    const startsWithListVerb = /^(?:list|daftar|lihat|liat|tampilkan|show)(?:\b|$)/i.test(lower);
    if (!startsWithListVerb) return null;

    const requestedVessel = matchRequestedFileVessel(withoutLily);
    const searchAllVessels = isAllFileVesselsRequest(withoutLily);
    const hasListObject = /^(?:list|daftar|show)$/i.test(lower)
        || /\b(?:file|files|isi|folder|download|downloads|desktop|dekstop|pictures|photos|gallery|galeri|storage)\b/i.test(lower)
        || Boolean(requestedVessel)
        || searchAllVessels;
    if (!hasListObject) return null;

    return {
        type: 'file_vessel_list',
        root: parseFileVesselRoot(lower),
        limit: parseFileVesselListLimit(lower),
        source: 'wa',
        vesselKey: searchAllVessels ? '' : (requestedVessel?.key || ''),
        searchAllVessels,
    };
}

function parseContactPolicyCommand(message) {
    const text = (message || '').trim();
    if (/^lily\s+contacts\s+status$/i.test(text)) return { type: 'contact_policy_status' };
    let match = text.match(/^lily\s+circle\s+(add|remove)\s+(.+)$/i);
    if (match) return { type: 'contact_policy_change', scope: 'circle', action: match[1].toLowerCase(), number: match[2] };
    match = text.match(/^lily\s+secretary\s+(never|allow)\s+(.+)$/i);
    if (match) {
        return {
            type: 'contact_policy_change',
            scope: 'secretary_never_reply',
            action: match[1].toLowerCase() === 'never' ? 'add' : 'remove',
            number: match[2],
        };
    }
    return null;
}

function isOwnerMoodControlMessage(message) {
    const normalized = (message || '').toString().trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
    return [
        'lily mood',
        'lily calm down',
        'lily tenang',
        'lily be clingy',
        'lily clingy',
        'lily normal',
    ].includes(normalized);
}

function parseOwnerCommand(message, replyLanguage = 'id') {
    const text = (message || '').trim();
    const secretaryCommand = parseSecretaryCommand(text);
    if (secretaryCommand) return secretaryCommand;
    const lower = text.toLowerCase();
    const familyCommand = parseFamilyOwnerCommand(text);
    if (familyCommand) return familyCommand;
    const openClawTaskIdMatch = text.match(/\btool_[a-z0-9]+\b/i);
    const toolId = openClawTaskIdMatch?.[0]?.trim() || '';
    const normalizeSpaces = (value) => value.replace(/\s+/g, ' ').trim();
    const aliasPattern = (aliases) => new RegExp(
        `(?:^|\\b)(?:${aliases.map((alias) => alias.replace(/\s+/g, '\\s+')).join('|')})(?=\\b)`,
        'i'
    );
    const approveAliases = [
        'approve',
        'setujui',
        'setujuin',
        'izinkan',
        'izin',
        'acc',
        'okein',
        'lanjutkan',
        'jalanin',
        'gasin',
    ];
    const denyAliases = [
        'deny',
        'tolak',
        'batal',
        'batalin',
        'batalkan',
        'cancel',
        'stop',
        'jangan jadi',
        'skip',
    ];
    const approvePattern = aliasPattern(approveAliases);
    const denyPattern = aliasPattern(denyAliases);

    if (isResetLilyCommand(text)) {
        return { type: 'reset_conversation' };
    }

    const utilityCommand = parseOwnerUtilityCommand(text);
    if (utilityCommand) {
        return utilityCommand;
    }

    const contactPolicyCommand = parseContactPolicyCommand(text);
    if (contactPolicyCommand) return contactPolicyCommand;

    const helpCommand = parseOwnerHelpCommand(text);
    if (helpCommand) {
        return helpCommand;
    }

    const fileVesselListCommand = parseFileVesselListCommand(text);
    if (fileVesselListCommand) {
        return fileVesselListCommand;
    }

    const fileVesselCommand = parseFileVesselSendCommand(text);
    if (fileVesselCommand) {
        return fileVesselCommand;
    }

    let match = lower.match(/^lily,\s*(remember|note|ingat|catat)\s+(.+)$/i);
    if (match) {
        return { type: 'owner_note', value: text.replace(/^lily,\s*(remember|note|ingat|catat)\s+/i, '').trim() };
    }

    match = text.match(/^lily,\s*(?:call me|panggil aku)\s+(.+)$/i);
    if (match) {
        return { type: 'preferred_name', value: match[1].trim() };
    }

    match = text.match(/^lily,\s*(?:my nickname is|nickname aku)\s+(.+)$/i);
    if (match) {
        return { type: 'nickname', value: match[1].trim() };
    }

    const statusCommand = parseOwnerStatusCommand(text);
    if (statusCommand) {
        return statusCommand;
    }

    const presenceCommand = parseOwnerPresenceCommand(text);
    if (presenceCommand) {
        return presenceCommand;
    }

    match = text.match(denyPattern);
    if (match && toolId) {
        const reasonText = normalizeSpaces(
            text
                .replace(new RegExp(`\\b${toolId}\\b`, 'i'), '')
                .replace(denyPattern, '')
        ).replace(/^[-:,\s]+/, '');
        return { type: 'openclaw_deny', taskId: toolId, reason: reasonText };
    }

    match = text.match(approvePattern);
    if (match && toolId) {
        return { type: 'openclaw_approve', taskId: toolId };
    }

    if (/^lily,\s*tandai\s+/i.test(text)) {
        const phoneNumber = findPhoneNumberInText(text);
        if (!phoneNumber) {
            return { type: 'invalid', reply: getLocalizedBridgeText('tagNumberUnclear', replyLanguage) };
        }

        let relation = 'unknown';
        let label = 'general';

        if (/client/i.test(text)) {
            relation = 'client';
            label = 'client';
        } else if (/teman kerja/i.test(text)) {
            relation = 'coworker';
            label = 'work';
        } else if (/teman/i.test(text)) {
            relation = 'friend';
            label = 'friend';
        } else if (/keluarga/i.test(text)) {
            relation = 'family';
            label = 'family';
        }

        return { type: 'contact_tag', phoneNumber, relation, label };
    }

    return null;
}

function buildFileVesselHeaders(vessel = null) {
    const headers = {};
    const token = (vessel?.token || LILY_FILE_VESSEL_TOKEN || '').trim();
    if (token) {
        headers['X-Lily-File-Token'] = token;
    }
    return headers;
}

function buildSttHeaders() {
    const headers = {};
    if (LILY_STT_TOKEN) {
        headers['X-Lily-STT-Token'] = LILY_STT_TOKEN;
    }
    return headers;
}

function fileVesselUrl(vessel, pathname) {
    const resolvedVessel = vessel || getDefaultFileVessel();
    if (!resolvedVessel?.url) return '';
    return `${resolvedVessel.url}${pathname}`;
}

function rootHealthUrlFromUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        return `${parsed.origin}/health`;
    } catch (error) {
        return '';
    }
}

function isLikelyImageFile(name, mimeType = '') {
    const lowerName = (name || '').toLowerCase();
    const lowerMime = (mimeType || '').toLowerCase();
    return lowerMime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(lowerName);
}

function guessMimeTypeFromFilename(name) {
    const lowerName = (name || '').toLowerCase();
    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
    if (lowerName.endsWith('.webp')) return 'image/webp';
    if (lowerName.endsWith('.gif')) return 'image/gif';
    if (lowerName.endsWith('.pdf')) return 'application/pdf';
    if (lowerName.endsWith('.txt')) return 'text/plain';
    if (lowerName.endsWith('.zip')) return 'application/zip';
    return 'application/octet-stream';
}

function resolveDownloadedMimeType(contentType, filename) {
    const mimeType = (contentType || '').toString().split(';')[0].trim().toLowerCase();
    if (mimeType && mimeType !== 'application/json') {
        return mimeType;
    }
    return guessMimeTypeFromFilename(filename);
}

function fileVesselPendingKeys(chatId) {
    const keys = [];
    const exactKey = (chatId || '').toString().trim();
    if (exactKey) keys.push(exactKey);
    keys.push(OWNER_FILE_SEND_PENDING_KEY);
    return [...new Set(keys)];
}

function clearLastFileVesselSearch(chatId) {
    for (const key of fileVesselPendingKeys(chatId)) {
        lastFileSearchByChat.delete(key);
    }
}

function getLastFileVesselSearch(chatId) {
    let lastSearch = null;
    for (const key of fileVesselPendingKeys(chatId)) {
        const candidate = lastFileSearchByChat.get(key);
        if (candidate) {
            lastSearch = candidate;
            break;
        }
    }
    if (!lastSearch) return null;

    if (lastSearch.expiresAt && lastSearch.expiresAt <= Date.now()) {
        clearLastFileVesselSearch(lastSearch.chatId || chatId);
        return null;
    }

    return lastSearch;
}

function setLastFileVesselSearch(chatId, command, replyLanguage = 'id') {
    if (!chatId || !command?.query) return null;

    const timestamp = Date.now();
    const lastSearch = {
        chatId,
        command: {
            type: 'file_vessel_send',
            root: command.root || 'downloads',
            query: command.query,
            desiredKind: command.desiredKind || 'file',
            source: command.source || 'wa',
            vesselKey: normalizeFileVesselKey(command.vesselKey || ''),
            searchAllVessels: Boolean(command.searchAllVessels),
        },
        replyLanguage: normalizeReplyLanguage(replyLanguage),
        createdAt: timestamp,
        expiresAt: timestamp + LILY_FILE_SEARCH_CONTEXT_TTL_MS,
    };
    for (const key of fileVesselPendingKeys(chatId)) {
        lastFileSearchByChat.set(key, lastSearch);
    }
    return lastSearch;
}

function clearPendingFileVesselSend(chatId) {
    for (const key of fileVesselPendingKeys(chatId)) {
        pendingFileSendByChat.delete(key);
    }
}

function getPendingFileVesselSend(chatId) {
    let pending = null;
    let pendingKey = '';
    for (const key of fileVesselPendingKeys(chatId)) {
        const candidate = pendingFileSendByChat.get(key);
        if (candidate) {
            pending = candidate;
            pendingKey = key;
            break;
        }
    }
    if (!pending) return null;

    if (pending.expiresAt && pending.expiresAt <= Date.now()) {
        clearPendingFileVesselSend(pending.chatId || chatId);
        return null;
    }

    return { ...pending, pendingKey };
}

function setPendingFileVesselSend(chatId, files, replyLanguage = 'id') {
    const candidates = (Array.isArray(files) ? files : [])
        .filter((file) => file?.kind === 'file' && file?.virtual_path)
        .slice(0, Math.max(1, LILY_FILE_VESSEL_SEARCH_LIMIT));
    if (!chatId || !candidates.length) return null;

    const timestamp = Date.now();
    const pending = {
        chatId,
        candidates,
        replyLanguage: normalizeReplyLanguage(replyLanguage),
        createdAt: timestamp,
        expiresAt: timestamp + LILY_FILE_SEND_CONFIRM_TTL_MS,
    };
    for (const key of fileVesselPendingKeys(chatId)) {
        pendingFileSendByChat.set(key, pending);
    }
    console.log(`[FILE VESSEL] Pending WA file send for ${chatId}: ${candidates.length} candidate(s).`);
    return pending;
}

function formatFileVesselCandidate(file, index = null) {
    const name = file?.name || 'file';
    const size = Number(file?.size_bytes || 0) > 0 ? formatAttachmentSize(Number(file.size_bytes)) : 'unknown size';
    const prefix = Number.isInteger(index) ? `${index + 1}. ` : '';
    return `${prefix}${name} (${size}) - ${formatFileVesselLocation(file)}`;
}

function formatFileVesselLocation(file) {
    const name = file?.name || 'file';
    const virtualPath = file?.virtual_path || name;
    const vesselLabel = file?.vessel_label || file?.vessel_key || '';
    return vesselLabel ? `${vesselLabel}/${virtualPath}` : virtualPath;
}

function parsePendingFileVesselReply(chatId, message) {
    const pending = getPendingFileVesselSend(chatId);
    if (!pending) return null;

    const rawText = (message || '').trim();
    const text = normalizePendingFileVesselReplyText(rawText);
    if (!text) return null;

    if (/^(?:batal|batalin|cancel|stop|jangan|jangan jadi|nggak|ngga|gak|gk|ga|no|nope)$/i.test(text)) {
        return { type: 'file_vessel_cancel' };
    }

    const wordIndexes = {
        pertama: 1,
        kedua: 2,
        ketiga: 3,
        keempat: 4,
        kelima: 5,
        keenam: 6,
    };
    const wordIndexMatch = text.match(/\b(pertama|kedua|ketiga|keempat|kelima|keenam)\b/i);
    if (wordIndexMatch) {
        return { type: 'file_vessel_confirm', index: wordIndexes[wordIndexMatch[1].toLowerCase()] - 1 };
    }

    const numberMatch = text.match(/^(?:pilih\s+|yang\s+|nomor\s+|no\s+)?#?([1-9]\d*)$/i);
    if (numberMatch) {
        return { type: 'file_vessel_confirm', index: Number(numberMatch[1]) - 1 };
    }

    const confirmMatch = text.match(/^(?:ya|iya|y|yes|ok|oke|gas|kirim|send|lanjut|boleh|cus)(?:\s+(?:nomor\s+|no\s+)?#?([1-9]\d*))?$/i);
    if (confirmMatch) {
        const explicitIndex = confirmMatch[1] ? Number(confirmMatch[1]) - 1 : null;
        return {
            type: 'file_vessel_confirm',
            index: Number.isInteger(explicitIndex) ? explicitIndex : (pending.candidates.length === 1 ? 0 : null),
        };
    }

    return null;
}

function normalizePendingFileVesselReplyText(message) {
    return (message || '')
        .trim()
        .replace(/^lily[,\s:.-]*/i, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?,;:\s]+$/g, '')
        .trim();
}

function isLikelyFileVesselChoiceReply(message) {
    const text = normalizePendingFileVesselReplyText(message);
    return /^(?:pilih\s+|yang\s+|nomor\s+|no\s+)?#?[1-9]\d*$/i.test(text);
}

function parseFileVesselFollowUpCommand(chatId, message) {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text) return null;

    const hasFileReference = /\b(?:file|filenya|folder|pencarian(?:\s+file)?|hasil(?:\s+pencarian)?)\b/i.test(text);
    const hasRepeatAction = /\b(?:cek|check|cari|search|lihat|liat|ulang|refresh)\b/i.test(text);
    const isShortRepeat = /^(?:cek|check|cari|search|ulang|refresh|coba)(?:\s+(?:lagi|ulang))?$/i.test(text);
    const isFileFollowUp = (hasFileReference && hasRepeatAction) || isShortRepeat;
    if (!isFileFollowUp) return null;

    const lastSearch = getLastFileVesselSearch(chatId);
    if (!lastSearch?.command) {
        return { type: 'file_vessel_no_recent_search' };
    }

    return { type: 'file_vessel_repeat_search', command: lastSearch.command };
}

function financePendingKeys(chatId) {
    const keys = [];
    const exactKey = (chatId || '').toString().trim();
    if (exactKey) keys.push(exactKey);
    keys.push(OWNER_FINANCE_DRAFT_PENDING_KEY);
    return [...new Set(keys)];
}

function getPendingFinanceDraft(chatId) {
    let pending = null;
    for (const key of financePendingKeys(chatId)) {
        const candidate = pendingFinanceDraftByChat.get(key);
        if (candidate) {
            pending = candidate;
            break;
        }
    }
    if (!pending) return null;

    if (pending.expiresAt && pending.expiresAt <= Date.now()) {
        clearPendingFinanceDraft(pending.chatId || chatId);
        return null;
    }

    return pending;
}

function normalizeFinanceDraftTransactions(transactionOrTransactions) {
    const transactions = Array.isArray(transactionOrTransactions)
        ? transactionOrTransactions
        : [transactionOrTransactions];
    return transactions.filter((transaction) => transaction?.direction && Number(transaction.amount || 0) > 0);
}

function financeDraftFromParseResponse(parsed) {
    return parsed?.transactions?.length ? parsed.transactions : parsed?.transaction;
}

function createFinanceGroupRef(prefix = 'wa_group') {
    return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function ensureFinanceDraftGroup(transactions) {
    if (!Array.isArray(transactions) || transactions.length <= 1) return transactions;
    const groupRef = transactions.find((transaction) => transaction.external_ref)?.external_ref || createFinanceGroupRef('wa_split');
    return transactions.map((transaction) => ({ ...transaction, external_ref: transaction.external_ref || groupRef }));
}

function setPendingFinanceDraft(chatId, transactionOrTransactions, replyLanguage = 'id', source = 'text') {
    const transactions = ensureFinanceDraftGroup(normalizeFinanceDraftTransactions(transactionOrTransactions));
    if (!transactions.length) return null;
    const timestamp = Date.now();
    const pending = {
        chatId,
        transaction: transactions[0],
        transactions,
        source,
        replyLanguage: normalizeReplyLanguage(replyLanguage),
        createdAt: timestamp,
        expiresAt: timestamp + LILY_FINANCE_CONFIRM_TTL_MS,
    };
    for (const key of financePendingKeys(chatId)) {
        pendingFinanceDraftByChat.set(key, pending);
    }
    console.log(`[FINANCE] Pending draft for ${chatId}: ${transactions.length} line(s).`);
    return pending;
}

function clearPendingFinanceDraft(chatId) {
    for (const key of financePendingKeys(chatId)) {
        pendingFinanceDraftByChat.delete(key);
    }
}

function financeImageFallbackKeys(chatId) {
    const keys = [];
    const exactKey = (chatId || '').toString().trim();
    if (exactKey) keys.push(exactKey);
    keys.push(OWNER_FINANCE_IMAGE_FALLBACK_KEY);
    return [...new Set(keys)];
}

function setPendingFinanceImageFallback(chatId, replyLanguage = 'id', reason = '') {
    const timestamp = Date.now();
    const fallback = {
        chatId,
        replyLanguage: normalizeReplyLanguage(replyLanguage),
        reason: (reason || '').toString().slice(0, 120),
        createdAt: timestamp,
        expiresAt: timestamp + LILY_FINANCE_IMAGE_FALLBACK_TTL_MS,
    };
    for (const key of financeImageFallbackKeys(chatId)) {
        pendingFinanceImageFallbackByChat.set(key, fallback);
    }
    return fallback;
}

function getPendingFinanceImageFallback(chatId) {
    let fallback = null;
    for (const key of financeImageFallbackKeys(chatId)) {
        const candidate = pendingFinanceImageFallbackByChat.get(key);
        if (candidate) {
            fallback = candidate;
            break;
        }
    }
    if (!fallback) return null;
    if (fallback.expiresAt && fallback.expiresAt <= Date.now()) {
        clearPendingFinanceImageFallback(fallback.chatId || chatId);
        return null;
    }
    return fallback;
}

function clearPendingFinanceImageFallback(chatId) {
    for (const key of financeImageFallbackKeys(chatId)) {
        pendingFinanceImageFallbackByChat.delete(key);
    }
}

function financeSummaryContextKeys(chatId) {
    const keys = [];
    const exactKey = (chatId || '').toString().trim();
    if (exactKey) keys.push(exactKey);
    keys.push(OWNER_FINANCE_SUMMARY_CONTEXT_KEY);
    return [...new Set(keys)];
}

function setLastFinanceSummary(chatId, context) {
    const timestamp = Date.now();
    const savedContext = {
        ...context,
        chatId,
        createdAt: timestamp,
        expiresAt: timestamp + LILY_FINANCE_CONTEXT_TTL_MS,
    };
    for (const key of financeSummaryContextKeys(chatId)) {
        lastFinanceSummaryByChat.set(key, savedContext);
    }
    return savedContext;
}

function getLastFinanceSummary(chatId) {
    let context = null;
    for (const key of financeSummaryContextKeys(chatId)) {
        const candidate = lastFinanceSummaryByChat.get(key);
        if (candidate) {
            context = candidate;
            break;
        }
    }
    if (!context) return null;
    if (context.expiresAt && context.expiresAt <= Date.now()) {
        for (const key of financeSummaryContextKeys(context.chatId || chatId)) {
            lastFinanceSummaryByChat.delete(key);
        }
        return null;
    }
    return context;
}

function clearLastFinanceSummary(chatId) {
    for (const key of financeSummaryContextKeys(chatId)) {
        lastFinanceSummaryByChat.delete(key);
    }
}

function parseFinanceAmount(value) {
    const text = (value || '').toString().trim().toLowerCase();
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(k|rb|ribu|jt|juta)?/i);
    if (!match) return null;
    const suffix = (match[2] || '').toLowerCase();
    const rawNumber = match[1];
    const normalizedNumber = suffix
        ? rawNumber.replace(',', '.')
        : /^\d{1,3}([.,]\d{3})+$/.test(rawNumber)
            ? rawNumber.replace(/[.,]/g, '')
            : rawNumber.replace(',', '.');
    const number = Number(normalizedNumber);
    if (!Number.isFinite(number) || number <= 0) return null;
    const multiplier = ['k', 'rb', 'ribu'].includes(suffix)
        ? 1000
        : ['jt', 'juta'].includes(suffix)
            ? 1000000
            : 1;
    return Math.round(number * multiplier);
}

function parsePendingFinanceReply(chatId, message) {
    const pending = getPendingFinanceDraft(chatId);
    if (!pending) return null;

    const text = normalizePendingFileVesselReplyText(message);
    if (!text) return null;

    const adminFeeMatch = text.match(/^(?:admin|biaya\s*(?:admin|tf|transfer)|fee)\s*(?:nya|:|=)?\s*(\d+(?:[.,]\d+)?\s*(?:k|rb|ribu|jt|juta)?)$/i);
    if (adminFeeMatch) {
        return { type: 'finance_add_admin_fee', amount: parseFinanceAmount(adminFeeMatch[1]) };
    }

    if (/^(?:tanpa\s+admin|no\s+admin|nggak\s+ada\s+admin|ngga\s+ada\s+admin|gak\s+ada\s+admin|gk\s+ada\s+admin|ga\s+ada\s+admin)$/i.test(text)) {
        return { type: 'finance_confirm' };
    }

    const categoryMatch = text.match(/^(?:ubah\s+|ganti\s+|set\s+)?(?:kategori|category|cat)\s*(?:ke|jadi|to|as|:|=)?\s*([a-z0-9][a-z0-9 _-]{1,79})$/i);
    if (categoryMatch) {
        const category = normalizeFinanceCategoryName(categoryMatch[1]);
        if (category) {
            return { type: 'finance_update_category', category };
        }
    }

    const naturalCategory = parseNaturalFinanceCategoryCorrection(text);
    if (naturalCategory) {
        return { type: 'finance_update_category', category: naturalCategory };
    }

    if (/^(?:batal|batalin|cancel|stop|jangan|jangan jadi|nggak|ngga|gak|gk|ga|no|nope)$/i.test(text)) {
        return { type: 'finance_cancel' };
    }

    if (/^(?:1|1\.|ya|iya|y|yes|ok|oke|gas|simpan|save|catat|lanjut|boleh|confirm)$/i.test(text)) {
        return { type: 'finance_confirm' };
    }

    return null;
}

function normalizeFinanceCategoryName(value) {
    const text = (value || '').toString().trim().toLowerCase().replace(/[-\s]+/g, '_');
    return text.replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function parseNaturalFinanceCategoryCorrection(text) {
    const normalized = normalizePendingFileVesselReplyText(text);
    if (!normalized || normalized.length > 120) return '';
    const patterns = [
        /^(?:ini|itu|tadi)\s+(?:masuk\s+)?(?:kategori\s+)?([a-z0-9][a-z0-9 _-]{1,79})$/i,
        /^(?:harusnya|mestinya|seharusnya|should\s+be)\s+(?:kategori\s+)?([a-z0-9][a-z0-9 _-]{1,79})$/i,
        /^(?:masuk|jadi|set\s+as)\s+(?:kategori\s+)?([a-z0-9][a-z0-9 _-]{1,79})$/i,
        /^merchant\s+(?:ini\s+)?(?:masuk|jadi)\s+(?:kategori\s+)?([a-z0-9][a-z0-9 _-]{1,79})$/i,
    ];
    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        const category = normalizeFinanceCategoryName(match?.[1] || '');
        if (category && FINANCE_KNOWN_CATEGORY_NAMES.has(category)) return category;
    }
    const direct = normalizeFinanceCategoryName(normalized);
    return FINANCE_KNOWN_CATEGORY_NAMES.has(direct) ? direct : '';
}

function escapeRegExpText(value) {
    return (value || '').toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFinanceRuleValue(value) {
    return (value || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBroadFinanceMerchant(value) {
    return FINANCE_BROAD_MERCHANT_RULE_DENYLIST.has(normalizeFinanceRuleValue(value));
}

function extractFinanceCategoryKeyword(transaction) {
    const note = (transaction?.note || '').toString().trim();
    if (!note) return '';

    let text = note.replace(/\b(?:rp|idr)\s*[\d.,]+(?:\s*(?:k|rb|ribu|jt|juta))?\b/gi, ' ');
    text = text.replace(/\b(?:account|category|merchant|note)\s*:\s*/gi, ' ');
    const merchant = (transaction?.merchant || '').toString().trim();
    if (merchant) {
        text = text.replace(new RegExp(`^\\s*${escapeRegExpText(merchant)}\\s*(?:[|:,-]\\s*)?`, 'i'), '');
    }

    const segments = text
        .split(/[|,;]+/)
        .map((segment) => segment.replace(/\s+/g, ' ').trim())
        .filter((segment) => /[a-zA-Z]/.test(segment) && segment.length >= 3);
    return (segments[0] || '').slice(0, 160);
}

function buildFinanceCategoryRulePayload(transaction, category) {
    const merchant = (transaction?.merchant || '').toString().trim();
    const keyword = extractFinanceCategoryKeyword(transaction);
    return {
        category,
        merchant: merchant && !isBroadFinanceMerchant(merchant) ? merchant : null,
        keyword: keyword || null,
        source: 'wa',
        note: (transaction?.note || '').toString().slice(0, 300),
    };
}

function buildFinanceHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (LILY_FINANCE_SERVICE_TOKEN) {
        headers['X-Lily-Finance-Token'] = LILY_FINANCE_SERVICE_TOKEN;
    }
    return headers;
}

function financeUrl(pathname) {
    if (!LILY_FINANCE_VESSEL_URL) return '';
    return `${LILY_FINANCE_VESSEL_URL}${pathname}`;
}

async function requestFinanceApi(method, pathname, body = null, timeout = 20000) {
    const url = financeUrl(pathname);
    if (!url) {
        throw new Error('finance_not_configured');
    }

    const config = {
        headers: buildFinanceHeaders(),
        timeout,
        validateStatus: () => true,
    };
    const response = method === 'get'
        ? await axios.get(url, config)
        : await axios.post(url, body, config);
    if (response.status < 200 || response.status >= 300) {
        const detail = response.data?.detail || response.data?.reason || `finance_http_${response.status}`;
        throw new Error(detail);
    }
    return response.data;
}

function formatRupiah(value) {
    const amount = Number(value || 0);
    return `Rp ${Math.round(amount).toLocaleString('id-ID')}`;
}

function formatFinanceTransaction(transaction) {
    if (!transaction) return '';
    const direction = (transaction.direction || 'expense').toString().toUpperCase();
    const amount = formatRupiah(transaction.amount);
    const account = transaction.direction === 'transfer'
        ? `${transaction.account || '-'} -> ${transaction.to_account || '-'}`
        : (transaction.account || '-');
    const category = transaction.category || 'uncategorized';
    const merchant = transaction.merchant ? `\nMerchant: ${transaction.merchant}` : '';
    const note = transaction.note ? `\nNote: ${transaction.note}` : '';
    return `${direction} ${amount}\nAccount: ${account}\nCategory: ${category}${merchant}${note}`;
}

function formatFinanceTransactions(transactions) {
    const lines = normalizeFinanceDraftTransactions(transactions);
    if (lines.length <= 1) return formatFinanceTransaction(lines[0]);

    const detail = lines.map((transaction, index) => {
        const direction = (transaction.direction || 'expense').toString().toUpperCase();
        const account = transaction.direction === 'transfer'
            ? `${transaction.account || '-'} -> ${transaction.to_account || '-'}`
            : (transaction.account || '-');
        const merchant = transaction.merchant ? ` | Merchant: ${transaction.merchant}` : '';
        const note = transaction.note ? ` | Note: ${transaction.note}` : '';
        return [
            `${index + 1}. ${direction} ${formatRupiah(transaction.amount)}`,
            `   Account: ${account}`,
            `   Category: ${transaction.category || 'uncategorized'}${merchant}${note}`,
        ].join('\n');
    });

    const expenseTotal = lines
        .filter((transaction) => transaction.direction === 'expense')
        .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const account = lines.find((transaction) => transaction.account)?.account || '-';
    detail.push(`Total keluar dari ${account}: ${formatRupiah(expenseTotal)}`);
    return detail.join('\n');
}

function financeDraftNeedsAdminHint(transactions) {
    const lines = normalizeFinanceDraftTransactions(transactions);
    if (lines.length !== 1) return false;
    const transaction = lines[0];
    return transaction.direction === 'expense'
        && (transaction.category || '').toLowerCase() === 'transfer'
        && !lines.some((line) => (line.category || '').toLowerCase() === 'bank_fee');
}

function formatFinanceDraftDetail(transactions, replyLanguage = 'id') {
    const detail = formatFinanceTransactions(transactions);
    if (!financeDraftNeedsAdminHint(transactions)) return detail;
    const hint = replyLanguage === 'en'
        ? 'If there is a transfer/admin fee, reply `admin 2500` before saving. Reply `gas` to save without a fee.'
        : 'Kalau ada biaya admin, balas `admin 2500` sebelum disimpan. Balas `gas` untuk simpan tanpa admin.';
    return `${detail}\n\n${hint}`;
}

function financeImageParseFailureKey(reason = '') {
    const normalized = (reason || '').toString().trim().toLowerCase();
    if (
        ['gemini_temporarily_unavailable', 'gemini_timeout', 'gemini_unreachable', 'gemini_rate_limited'].includes(normalized)
        || /^gemini_http_(?:429|5\d\d)$/.test(normalized)
    ) {
        return 'financeImageServiceBusy';
    }
    return 'financeImageParseFailed';
}

function isFinanceImageServiceBusyReason(reason = '') {
    return financeImageParseFailureKey(reason) === 'financeImageServiceBusy';
}

function parseFinanceSummaryCommand(message) {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text) return null;
    const matchesSummaryIntent = FINANCE_SUMMARY_SUBJECT_PATTERN.test(text) && FINANCE_SUMMARY_ACTION_PATTERN.test(text);
    return matchesSummaryIntent
        ? { type: 'finance_summary', account: extractFinanceAccountQuery(text) }
        : null;
}

function parseFinanceFollowUpCommand(chatId, message) {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text || !getLastFinanceSummary(chatId)) return null;
    return FINANCE_PERIOD_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(text))
        ? { type: 'finance_period_followup' }
        : null;
}

function parseFinanceDetailCommand(message) {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text) return null;
    if (FINANCE_AMOUNT_PATTERN.test(text)) return null;
    const mentionsFinance = FINANCE_INTERPRETER_HINT_PATTERN.test(text) || /\b(?:transaksi|transaction|riwayat|history)\b/i.test(text);
    if (!mentionsFinance) return null;
    if (FINANCE_RECENT_TRANSACTION_PATTERN.test(text)) {
        return { type: 'finance_recent_transactions', scope: 'recent', limit: 5 };
    }
    if (FINANCE_TODAY_PATTERN.test(text)) {
        return { type: 'finance_recent_transactions', scope: 'today', limit: 10 };
    }
    if (FINANCE_MONTH_EXPENSE_PATTERN.test(text)) {
        return { type: 'finance_month_expense' };
    }
    return null;
}

function normalizeFinanceAccountQuery(value) {
    return (value || '').toString().trim().toLowerCase().replace(/go\s*pay/g, 'gopay').replace(/\s+/g, '_');
}

function extractFinanceAccountQuery(text) {
    const lower = (text || '').toString().toLowerCase();
    const accountAlias = FINANCE_ACCOUNT_ALIASES
        .flatMap((entry) => entry.aliases.map((alias) => ({ alias, account: entry.account })))
        .find(({ alias }) => new RegExp(`\\b${escapeRegExpText(alias)}\\b`, 'i').test(lower));
    if (accountAlias) {
        return accountAlias.account;
    }

    const saldoMatch = lower.match(/\bsaldo\s+([a-z0-9 _-]{2,40}?)(?:\s+(?:ada|berapa|sisa|dong|ya|kah|nih|ini)|$)/i);
    return saldoMatch ? normalizeFinanceAccountQuery(saldoMatch[1]) : '';
}

function shouldUseFinanceInterpreter(message, chatId = '') {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text || text.length > 500) return false;
    if (getLastFinanceSummary(chatId) && text.length <= 120) return true;
    if (getPendingFinanceImageFallback(chatId) && FINANCE_AMOUNT_PATTERN.test(text)) return true;
    if (FINANCE_TRANSACTION_CUE_PATTERN.test(text) && FINANCE_AMOUNT_PATTERN.test(text)) return true;
    return FINANCE_INTERPRETER_HINT_PATTERN.test(text);
}

function isStrongFinanceInterpreterRequest(message, chatId = '') {
    const text = normalizePendingFileVesselReplyText(message);
    if (!text) return false;
    if (getLastFinanceSummary(chatId) && FINANCE_PERIOD_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(text))) return true;
    if (FINANCE_SUMMARY_SUBJECT_PATTERN.test(text) && FINANCE_SUMMARY_ACTION_PATTERN.test(text)) return true;
    if (getPendingFinanceImageFallback(chatId) && FINANCE_AMOUNT_PATTERN.test(text)) return true;
    return FINANCE_TRANSACTION_CUE_PATTERN.test(text) && FINANCE_AMOUNT_PATTERN.test(text);
}

function parseFinanceTextCommand(message, chatId = '') {
    const detailCommand = parseFinanceDetailCommand(message);
    if (detailCommand) return detailCommand;
    return shouldUseFinanceInterpreter(message, chatId)
        ? { type: 'finance_interpret', message: (message || '').trim(), strict: isStrongFinanceInterpreterRequest(message, chatId) }
        : null;
}

function isSupportedFinanceImageMime(mimeType = '') {
    return ['image/jpeg', 'image/png', 'image/webp'].includes((mimeType || '').toLowerCase().trim());
}

function financeAccountKey(value) {
    return (value || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findFinanceSummaryAccount(summary, accountQuery = '') {
    const queryKey = financeAccountKey(accountQuery);
    if (!queryKey) return null;
    const accounts = Array.isArray(summary?.accounts) ? summary.accounts : [];
    return accounts.find((account) => {
        const nameKey = financeAccountKey(account.name);
        const labelKey = financeAccountKey(account.label);
        return nameKey === queryKey || labelKey === queryKey || nameKey.includes(queryKey) || labelKey.includes(queryKey);
    }) || null;
}

function formatFinancePeriod(summary, replyLanguage = 'id') {
    if (summary?.month) {
        return replyLanguage === 'en' ? `month ${summary.month}` : `bulan ${summary.month}`;
    }
    return replyLanguage === 'en' ? 'all saved transactions' : 'semua transaksi tersimpan';
}

function formatFinanceSummary(summary, options = {}, replyLanguage = 'id') {
    const accounts = Array.isArray(summary?.accounts) ? summary.accounts : [];
    const requestedAccount = findFinanceSummaryAccount(summary, options.account);
    if (options.account) {
        if (!requestedAccount) {
            const accountNames = accounts.map((account) => account.label || account.name).filter(Boolean).join(', ') || '-';
            return replyLanguage === 'en'
                ? `Account ${options.account} was not found.\nAvailable accounts: ${accountNames}`
                : `Akun ${options.account} belum ketemu.\nAkun tersedia: ${accountNames}`;
        }
        const label = requestedAccount.label || requestedAccount.name;
        return replyLanguage === 'en'
            ? [
                `${label} balance: ${formatRupiah(requestedAccount.balance || 0)}`,
                `Total all accounts: ${formatRupiah(summary?.total_balance || 0)}`,
                'Scope: account balance is the running ledger balance, not a monthly subtotal.',
            ].join('\n')
            : [
                `Saldo ${label}: ${formatRupiah(requestedAccount.balance || 0)}`,
                `Total semua akun: ${formatRupiah(summary?.total_balance || 0)}`,
                'Cakupan: saldo akun adalah saldo berjalan, bukan subtotal bulanan.',
            ].join('\n');
    }

    if (replyLanguage === 'en') {
        const lines = [
            `Period: ${formatFinancePeriod(summary, replyLanguage)}`,
            `Total balance: ${formatRupiah(summary?.total_balance || 0)}`,
            `Income: ${formatRupiah(summary?.income || 0)}`,
            `Expense: ${formatRupiah(summary?.expense || 0)}`,
            `Net: ${formatRupiah(summary?.net || 0)}`,
        ];
        if (accounts.length) {
            lines.push('');
            lines.push('Accounts:');
            for (const account of accounts.slice(0, 8)) {
                lines.push(`- ${account.label || account.name}: ${formatRupiah(account.balance || 0)}`);
            }
        }
        return lines.join('\n');
    }

    const lines = [
        `Periode: ${formatFinancePeriod(summary, replyLanguage)}`,
        `Total saldo: ${formatRupiah(summary?.total_balance || 0)}`,
        `Pemasukan: ${formatRupiah(summary?.income || 0)}`,
        `Pengeluaran: ${formatRupiah(summary?.expense || 0)}`,
        `Net: ${formatRupiah(summary?.net || 0)}`,
    ];
    if (accounts.length) {
        lines.push('');
        lines.push('Akun:');
        for (const account of accounts.slice(0, 8)) {
            lines.push(`- ${account.label || account.name}: ${formatRupiah(account.balance || 0)}`);
        }
    }
    return lines.join('\n');
}

function localFinanceDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function localFinanceMonthKey(date = new Date()) {
    return localFinanceDateKey(date).slice(0, 7);
}

function financeDateKey(value) {
    const text = (value || '').toString().trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function formatFinanceCompactTransaction(transaction, index = 0) {
    const direction = (transaction.direction || 'expense').toString().toLowerCase();
    const sign = direction === 'income' ? '+' : direction === 'transfer' ? '>' : '-';
    const account = direction === 'transfer'
        ? `${transaction.account || '-'} -> ${transaction.to_account || '-'}`
        : (transaction.account || '-');
    const title = transaction.note || transaction.merchant || transaction.category || 'transaction';
    const date = financeDateKey(transaction.occurred_at) || '-';
    return `${index + 1}. ${date} ${sign}${formatRupiah(transaction.amount)} | ${account} | ${transaction.category || 'uncategorized'} | ${title}`;
}

function formatFinanceRecentTransactions(transactions, scope = 'recent', replyLanguage = 'id') {
    const title = scope === 'today'
        ? (replyLanguage === 'en' ? 'Today transactions' : 'Transaksi hari ini')
        : (replyLanguage === 'en' ? 'Recent transactions' : 'Transaksi terakhir');
    if (!transactions.length) {
        return replyLanguage === 'en'
            ? `${title}:\nNo transactions found.`
            : `${title}:\nBelum ada transaksi.`;
    }
    return `${title}:\n${transactions.map((item, index) => formatFinanceCompactTransaction(item, index)).join('\n')}`;
}

function formatFinanceMonthExpense(summary, replyLanguage = 'id') {
    const month = summary?.month || localFinanceMonthKey();
    if (replyLanguage === 'en') {
        return [
            `This month expense (${month}): ${formatRupiah(summary?.expense || 0)}`,
            `Income: ${formatRupiah(summary?.income || 0)}`,
            `Net: ${formatRupiah(summary?.net || 0)}`,
            `Total balance: ${formatRupiah(summary?.total_balance || 0)}`,
        ].join('\n');
    }
    return [
        `Pengeluaran bulan ini (${month}): ${formatRupiah(summary?.expense || 0)}`,
        `Pemasukan: ${formatRupiah(summary?.income || 0)}`,
        `Net: ${formatRupiah(summary?.net || 0)}`,
        `Total saldo: ${formatRupiah(summary?.total_balance || 0)}`,
    ].join('\n');
}

function formatFinancePeriodFollowUp(context, replyLanguage = 'id') {
    const summary = context?.summary || {};
    if (replyLanguage === 'en') {
        if (context?.account) {
            return `That ${context.account.label || context.account.name} balance is the running ledger balance, not a monthly subtotal. The income/expense summary period was ${formatFinancePeriod(summary, replyLanguage)}.`;
        }
        return `That summary period was ${formatFinancePeriod(summary, replyLanguage)}. Account balances are running balances.`;
    }
    if (context?.account) {
        return `Saldo ${context.account.label || context.account.name} itu saldo berjalan, bukan subtotal bulanan. Ringkasan pemasukan/pengeluaran tadi periodenya ${formatFinancePeriod(summary, replyLanguage)}.`;
    }
    return `Ringkasan tadi periodenya ${formatFinancePeriod(summary, replyLanguage)}. Saldo akun sendiri adalah saldo berjalan.`;
}

function parseWakePcCommand(message) {
    const lower = String(message || '').trim().replace(/[.!]$/, '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!lower) return null;
    // Offline WoL only knows the configured default PC, never a named device.
    // Do not execute quoted, negative, or incomplete requests.
    const explicitWake = /^(?:(?:lily|lili)\s*[,!:]?\s*)?(?:(?:tolong|please)\s+)?(?:wake(?:\s+up)?|turn\s+on|nyalain|nyalakan|hidupin|hidupkan|bangunin|bangunkan)\s+(?:pc|computer|komputer|desktop|windows)(?:\s+(?:dong|ya|please))?$/.test(lower);
    return explicitWake ? { type: 'wake_pc' } : null;
}

function hasWakePcIntent(message) {
    const text = String(message || '').toLowerCase().trim();
    const hasWakeVerb = /\b(?:wake(?:\s+up)?|turn\s+on|nyala(?:in|kan)?|hidup(?:in|kan)?|bangunin|bangunkan)\b/i.test(text);
    const hasDeviceTarget = /\b(?:pc|computer|komputer|desktop|windows|Lily-Voice-Host(?:\s+rtx)?|Lily-Storage-Host(?:\s+pc)?|Lily-Storage-Host(?:\s+pc)?|Lily-Storage-Host)\b/i.test(text);
    return hasWakeVerb && hasDeviceTarget;
}

function shouldUseOwnerIntentRouter(message, chatId, inputFiles = []) {
    if (Array.isArray(inputFiles) && inputFiles.length) return false;

    const text = normalizePendingFileVesselReplyText(message);
    if (!text || text.length > 800) return false;

    const hasPendingFile = Boolean(getPendingFileVesselSend(chatId));
    const hasLastFileSearch = Boolean(getLastFileVesselSearch(chatId));
    if (hasPendingFile && /\b(?:satu|dua|tiga|empat|lima|enam|pertama|kedua|ketiga|keempat|kelima|keenam|yang|nomor|no|boleh|gas|kirim|send|lanjut|batal|cancel)\b/i.test(text)) {
        return true;
    }
    if (hasLastFileSearch && /\b(?:cek|check|cari|search|lihat|liat|ulang|lagi|refresh|filenya|hasil|tadi)\b/i.test(text)) {
        return true;
    }
    if (getLastFinanceSummary(chatId) && FINANCE_PERIOD_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(text))) {
        return true;
    }
    if (getPendingFinanceImageFallback(chatId) && FINANCE_AMOUNT_PATTERN.test(text)) {
        return true;
    }

    const hasFileObject = /\b(?:file|gambar|image|foto|photo|wallpaper|download|downloads|desktop|folder)\b/i.test(text);
    const hasFileAction = /\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin|cari|cek|check|search|lihat|liat|refresh)\b/i.test(text);
    const hasFinanceHint = FINANCE_INTERPRETER_HINT_PATTERN.test(text)
        || /\b(?:transaksi|transaction|riwayat|history|pengeluaran|expense|income|saldo|balance)\b/i.test(text);
    const hasFinanceAction = FINANCE_SUMMARY_ACTION_PATTERN.test(text)
        || FINANCE_TRANSACTION_CUE_PATTERN.test(text)
        || FINANCE_AMOUNT_PATTERN.test(text);
    const hasWakeVerb = /\b(?:wake|turn\s+on|nyala(?:in|kan)?|hidup(?:in|kan)?|bangunin)\b/i.test(text);
    const namedWakeTarget = /\b(?:Lily-Voice-Host(?:\s+rtx)?|Lily-Storage-Host(?:\s+pc)?|Lily-Storage-Host(?:\s+pc)?)\b/i.test(text);
    const namedWakeFollowup = /^(?:Lily-Voice-Host(?:\s+rtx)?|Lily-Storage-Host(?:\s+pc)?|Lily-Storage-Host(?:\s+pc)?)$/i.test(text.trim());
    // Named wake requests and the answer to Core's target question must reach
    // Core directly. The generic bridge WoL shortcut only knows the default PC.
    if (namedWakeFollowup || (hasWakeVerb && namedWakeTarget)) return false;
    const hasWakeHint = hasWakeVerb
        && /\b(?:pc|core|computer|komputer|windows|Lily-Storage-Host|Lily-Storage-Host)\b/i.test(text);
    const hasHomeHint = /\b(?:lampu|light|lights|wiz|teras|kamar|clairie\s+lab)\b/i.test(text)
        && /\b(?:nyalain|nyalakan|hidupin|hidupkan|matiin|matikan|padamin|padamkan|turn\s+(?:on|off)|switch\s+(?:on|off)|cek|check|status|gimana|redup|terang|warna|merah|hijau|biru|ungu|pink|kuning|oranye)\b/i.test(text);
    const hasPresenceHint = /\b(?:status|available|normal|online|aktif|sibuk|busy|meeting|kantor|kerja|office|tidur|sleep|sleeping|istirahat|main\s+game|gaming|ranked|away|pergi|keluar)\b/i.test(text);
    const hasToolDecision = /\btool_[a-z0-9]+\b/i.test(text)
        && /\b(?:approve|setujui|setujuin|izinkan|izin|acc|okein|lanjutkan|jalanin|gasin|deny|tolak|batal|batalin|cancel|stop|skip)\b/i.test(text);

    return (hasFileObject && hasFileAction) || (hasFinanceHint && hasFinanceAction) || hasWakeHint || hasHomeHint || hasPresenceHint || hasToolDecision;
}

function buildOwnerIntentRouterContext(chatId) {
    const pending = getPendingFileVesselSend(chatId);
    const lastSearch = getLastFileVesselSearch(chatId);
    return {
        pending_file_count: pending?.candidates?.length || 0,
        pending_candidates: pending?.candidates?.map((file, index) => ({
            index: index + 1,
            name: file.name || file.virtual_path || 'file',
        })) || [],
        recent_file_query: lastSearch?.command?.query || '',
        available_vessels: FILE_VESSEL_REGISTRY.map((vessel) => ({
            key: vessel.key,
            label: vessel.label,
            aliases: vessel.aliases,
            isDefault: Boolean(vessel.isDefault),
        })),
        has_pending_finance_draft: Boolean(getPendingFinanceDraft(chatId)),
        has_pending_finance_image_fallback: Boolean(getPendingFinanceImageFallback(chatId)),
        has_finance_summary_context: Boolean(getLastFinanceSummary(chatId)),
        is_owner: true,
        access_scope: 'owner',
        wa_profile: WA_PROFILE,
    };
}

function buildOwnerIntentRouterPrompt(message, chatId) {
    const context = buildOwnerIntentRouterContext(chatId);
    const pendingCandidates = context.pending_candidates.map((file) => `${file.index}. ${file.name}`).join('\n') || '-';
    const lastSearchQuery = context.recent_file_query || '';
    const availableVessels = FILE_VESSEL_REGISTRY.map((vessel) => `${vessel.key} (${vessel.label})`).join(', ') || '-';

    return `You are Lily's WhatsApp owner intent router.
Return exactly one compact JSON object. No markdown. No natural-language reply.

Allowed intents:
- chat: normal conversation, questions, jokes, planning, or anything that should not trigger an action.
- finance_interpret: owner asks Lily to record, parse, or understand a money transaction, spending, income, transfer, bill, subscription, admin fee, or receipt text.
- finance_summary: owner asks for finance balance, account balance, or finance summary.
- finance_recent_transactions: owner asks for recent or today's finance transaction history.
- finance_month_expense: owner asks for this month's expense total.
- finance_period_followup: owner asks what period/month a previous finance summary covered.
- file_search: owner asks Lily to find or send a specific existing file/image from storage.
- file_confirm: owner chooses a pending file candidate. Only use when pending_file_count > 0.
- file_cancel: owner cancels a pending file send. Only use when pending_file_count > 0.
- file_repeat_search: owner asks to check/search the recent file query again. Only use when recent_file_query is not empty.
- home_control: owner asks to turn a configured smart-home device on/off or change brightness/color.
- home_status: owner asks whether a configured smart-home device is on, off, or online.
- wake_pc: owner asks Lily to turn on/wake the PC/core/computer.
- presence_set: owner says their availability changed, such as busy, available, sleeping, gaming, away, or at office.
- tool_approve: owner approves an OpenClaw/tool task id.
- tool_deny: owner denies an OpenClaw/tool task id.

Schema:
{"intent":"chat","confidence":0.0,"query":"","root":"downloads","desiredKind":"file","device":"","searchAllVessels":false,"index":null,"status":"","taskId":"","reason":""}

Rules:
- confidence must be 0.0 to 1.0.
- For finance_summary, put the account name in query when the owner asks about a specific account.
- For finance_interpret, keep query empty. WA will pass the original message to the finance interpreter.
- root must be "downloads", "desktop", or "pictures"; default to "downloads".
- desiredKind must be "file" or "image"; use "image" for gambar/foto/photo/wallpaper.
- device must be one of the available vessel keys, or empty when the owner did not name a device.
- searchAllVessels is true only when owner asks all devices/storage.
- index is the 1-based candidate number, or null.
- status must be one of: available, busy, at_office, sleeping, gaming, away.
- reason is a short note only for presence_set or tool_deny.
- For file_search, query must contain only the useful filename/search words. Remove Lily, kirim, file, folder, download, please, dong, juga, lagi.
- Money transfer to someone else, purchase notes, top-up, bill, or subscription with an amount must be finance_interpret.
- If the message asks to move/delete/edit files, use chat. Do not turn that into file_search.
- A casual story about seeing a person, photo, shop, or something earlier is chat. "tadi", "lihat/liat", or "lagi" alone never means file_repeat_search.
- file_repeat_search requires an explicit request to repeat the recent file query, such as "cek file tadi", "ulang pencarian", or a short "cek lagi".
- When recent_file_query is not empty, those explicit repeat requests must use file_repeat_search rather than file_search.
- If uncertain, use chat with low confidence.

Context:
pending_file_count=${context.pending_file_count || 0}
pending_candidates:
${pendingCandidates}
recent_file_query=${JSON.stringify(lastSearchQuery)}
available_vessels=${availableVessels}
has_pending_finance_draft=${Boolean(context.has_pending_finance_draft)}
has_finance_summary_context=${Boolean(context.has_finance_summary_context)}

Message:
${JSON.stringify(message || '')}`;
}

function extractFirstJsonObject(text) {
    const raw = (text || '').toString().trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return '';
    return raw.slice(start, end + 1);
}

function normalizeOwnerRouterIntentPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
        ? payload.params
        : {};
    const intent = (payload.intent || '').toString().trim().toLowerCase();
    if (!WA_OWNER_ROUTER_INTENTS.has(intent)) return null;

    const confidence = Number(payload.confidence);
    const normalized = {
        intent,
        domain: (payload.domain || '').toString().trim().toLowerCase(),
        source: (payload.source || 'wa_router').toString().trim().toLowerCase(),
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        query: normalizeFileVesselQuery(params.query || payload.query || ''),
        root: ['downloads', 'desktop', 'pictures'].includes((params.root || payload.root || '').toString().trim().toLowerCase())
            ? (params.root || payload.root || '').toString().trim().toLowerCase()
            : 'downloads',
        desiredKind: /^(?:image|photo|picture|gambar|foto|wallpaper)$/i.test((params.desiredKind || payload.desiredKind || '').toString().trim()) ? 'image' : 'file',
        device: normalizeFileVesselKey(params.device || payload.device || payload.vesselKey || ''),
        searchAllVessels: Boolean(params.searchAllVessels || payload.searchAllVessels || payload.search_all_vessels),
        index: null,
        status: normalizePresenceStatus(params.status || payload.status || ''),
        taskId: '',
        account: normalizeFinanceAccountQuery(
            params.account
            || payload.account
            || (intent === 'finance_summary' ? (params.query || payload.query || '') : '')
        ),
        scope: (params.scope || payload.scope || '').toString().trim().toLowerCase(),
        limit: null,
        strict: Boolean(params.strict || payload.strict),
        reason: cleanPresenceNote(payload.reason || params.reason || ''),
    };

    if (normalized.device && !getFileVesselByKey(normalized.device)) {
        normalized.device = '';
    }

    const index = Number(params.index ?? payload.index);
    if (Number.isInteger(index) && index > 0) {
        normalized.index = index;
    }

    const limit = Number(params.limit ?? payload.limit);
    if (Number.isInteger(limit) && limit > 0) {
        normalized.limit = Math.min(20, limit);
    }

    const taskIdMatch = (params.taskId || payload.taskId || '').toString().match(/\btool_[a-z0-9]+\b/i);
    if (taskIdMatch) {
        normalized.taskId = taskIdMatch[0];
    }

    if (normalized.intent !== 'chat' && normalized.confidence < LILY_WA_INTENT_ROUTER_MIN_CONFIDENCE) {
        return { ...normalized, intent: 'chat' };
    }

    return normalized;
}

function parseOwnerIntentRouterResponse(rawResponse) {
    if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
        return normalizeOwnerRouterIntentPayload(rawResponse);
    }

    const jsonText = extractFirstJsonObject(rawResponse);
    if (!jsonText) return null;

    try {
        return normalizeOwnerRouterIntentPayload(JSON.parse(jsonText));
    } catch (error) {
        return null;
    }
}

async function generateGeminiTextWithTimeout(modelName, prompt, bucketName, timeoutMs) {
    const generation = generateGeminiText(modelName, prompt, bucketName);
    generation.catch(() => {});

    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Router timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        return await Promise.race([generation, timeout]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function classifyOwnerIntentWithCore(message, chatId = '', replyLanguage = '') {
    if (!LILY_CORE_ROUTER_URL) return null;

    const payload = {
        source: 'wa_bridge',
        session_id: chatId || 'wa-owner-router',
        message: message || '',
        reply_language: replyLanguage || 'id',
        context: buildOwnerIntentRouterContext(chatId),
    };
    const response = await requestCore(
        'post',
        LILY_CORE_ROUTER_URL,
        payload,
        LILY_WA_INTENT_ROUTER_TIMEOUT_MS,
        false,
    );
    return parseOwnerIntentRouterResponse(response.data);
}

async function classifyOwnerIntent(message, chatId = '', replyLanguage = 'id', inputFiles = []) {
    const chatIntent = {
        intent: 'chat',
        source: 'wa_chat_gate',
        confidence: 1,
        query: '',
        root: 'downloads',
        desiredKind: 'file',
        device: '',
        searchAllVessels: false,
        index: null,
        status: '',
        taskId: '',
        reason: 'no_action_hint',
    };
    if (!shouldUseOwnerIntentRouter(message, chatId, inputFiles)) {
        return chatIntent;
    }

    try {
        const coreIntent = await classifyOwnerIntentWithCore(message, chatId, replyLanguage);
        if (coreIntent) {
            return coreIntent;
        }
    } catch (error) {
        console.warn('Core owner intent router skipped:', error?.message || error);
    }

    if (!genAI) {
        return { ...chatIntent, confidence: 0 };
    }

    try {
        const prompt = buildOwnerIntentRouterPrompt(message, chatId);
        const rawResponse = await generateGeminiTextWithTimeout(
            GEMINI_ROUTER_MODEL,
            prompt,
            'router',
            LILY_WA_INTENT_ROUTER_TIMEOUT_MS,
        );
        const intent = parseOwnerIntentRouterResponse(rawResponse);
        return intent || { ...chatIntent, confidence: 0 };
    } catch (error) {
        console.warn('WA owner intent router skipped:', error?.message || error);
        return { ...chatIntent, confidence: 0 };
    }
}

function ownerCommandFromRouterIntent(intentResult, chatId, originalMessage = '') {
    if (!intentResult || intentResult.intent === 'chat') return null;

    if (intentResult.intent === 'finance_interpret') {
        return {
            type: 'finance_interpret',
            message: (originalMessage || '').trim(),
            strict: Boolean(intentResult.strict || isStrongFinanceInterpreterRequest(originalMessage, chatId)),
        };
    }

    if (intentResult.intent === 'finance_summary') {
        return { type: 'finance_summary', account: intentResult.account || extractFinanceAccountQuery(originalMessage) };
    }

    if (intentResult.intent === 'finance_recent_transactions') {
        return {
            type: 'finance_recent_transactions',
            scope: intentResult.scope === 'today' ? 'today' : 'recent',
            limit: intentResult.limit || (intentResult.scope === 'today' ? 10 : 5),
        };
    }

    if (intentResult.intent === 'finance_month_expense') {
        return { type: 'finance_month_expense' };
    }

    if (intentResult.intent === 'finance_period_followup') {
        return getLastFinanceSummary(chatId) ? { type: 'finance_period_followup' } : null;
    }

    if (intentResult.intent === 'file_search') {
        return {
            type: 'file_vessel_send',
            root: intentResult.root || 'downloads',
            query: intentResult.query || '',
            desiredKind: intentResult.desiredKind || 'file',
            source: 'wa_router',
            vesselKey: intentResult.searchAllVessels ? '' : (intentResult.device || ''),
            searchAllVessels: Boolean(intentResult.searchAllVessels),
        };
    }

    if (intentResult.intent === 'file_repeat_search') {
        const lastSearch = getLastFileVesselSearch(chatId);
        return lastSearch?.command
            ? { type: 'file_vessel_repeat_search', command: lastSearch.command }
            : { type: 'file_vessel_no_recent_search' };
    }

    if (intentResult.intent === 'file_confirm') {
        const pending = getPendingFileVesselSend(chatId);
        if (!pending) return null;
        const index = Number.isInteger(intentResult.index) ? intentResult.index - 1 : null;
        return {
            type: 'file_vessel_confirm',
            index: Number.isInteger(index) ? index : (pending.candidates.length === 1 ? 0 : null),
        };
    }

    if (intentResult.intent === 'file_cancel') {
        return getPendingFileVesselSend(chatId) ? { type: 'file_vessel_cancel' } : null;
    }

    if (intentResult.intent === 'wake_pc') {
        // Core interprets the original utterance using the same device context
        // as Android. A WA router prediction must not directly wake hardware.
        return null;
    }

    if (intentResult.intent === 'home_control' || intentResult.intent === 'home_status') {
        return null;
    }

    if (intentResult.intent === 'presence_set') {
        const status = intentResult.status || (intentResult.reason ? 'busy' : '');
        return status ? { type: 'owner_presence', status, note: intentResult.reason, source: 'wa' } : null;
    }

    if (intentResult.intent === 'tool_approve') {
        return intentResult.taskId ? { type: 'openclaw_approve', taskId: intentResult.taskId } : null;
    }

    if (intentResult.intent === 'tool_deny') {
        return intentResult.taskId ? { type: 'openclaw_deny', taskId: intentResult.taskId, reason: intentResult.reason } : null;
    }

    return null;
}

function fileVesselQueryVariants(query) {
    const cleanQuery = normalizeFileVesselQuery(query);
    if (!cleanQuery) return [];

    const variants = [cleanQuery];
    const withoutGenericWords = normalizeFileVesselQuery(cleanQuery
        .replace(/\b(?:file|gambar|image|foto|photo|wallpaper)\b/gi, ' ')
    );

    if (withoutGenericWords && withoutGenericWords.toLowerCase() !== cleanQuery.toLowerCase()) {
        variants.push(withoutGenericWords);
    }

    return [...new Set(variants.map((value) => value.trim()).filter(Boolean))].slice(0, 3);
}

function resolveFileVesselTargets(command = {}) {
    if (!FILE_VESSEL_REGISTRY.length) return [];

    if (command.vesselKey) {
        const vessel = getFileVesselByKey(command.vesselKey);
        return vessel ? [vessel] : [];
    }

    const defaultVessel = getDefaultFileVessel();
    const others = FILE_VESSEL_REGISTRY.filter((vessel) => vessel.key !== defaultVessel?.key);
    return defaultVessel ? [defaultVessel, ...others] : [...FILE_VESSEL_REGISTRY];
}

function annotateFileVesselEntry(entry, vessel) {
    return {
        ...entry,
        vessel_key: vessel?.key || '',
        vessel_label: vessel?.label || vessel?.key || '',
    };
}

async function searchFileVesselEntries(vessel, root, query) {
    const searchUrl = fileVesselUrl(
        vessel,
        `/api/file/search?root=${encodeURIComponent(root)}&query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(LILY_FILE_VESSEL_SEARCH_LIMIT))}&max_depth=${encodeURIComponent(String(LILY_FILE_VESSEL_SEARCH_DEPTH))}`
    );
    const response = await axios.get(searchUrl, { headers: buildFileVesselHeaders(vessel), timeout: 15000 });
    return Array.isArray(response.data?.entries)
        ? response.data.entries.map((entry) => annotateFileVesselEntry(entry, vessel))
        : [];
}

async function listFileVesselEntries(vessel, root, limit = LILY_FILE_VESSEL_LIST_LIMIT) {
    const virtualPath = `${root || 'downloads'}:/`;
    const listUrl = fileVesselUrl(
        vessel,
        `/api/file/list?path=${encodeURIComponent(virtualPath)}&limit=${encodeURIComponent(String(limit))}`
    );
    const response = await axios.get(listUrl, { headers: buildFileVesselHeaders(vessel), timeout: 15000 });
    const entries = Array.isArray(response.data?.entries)
        ? response.data.entries.map((entry) => annotateFileVesselEntry(entry, vessel))
        : [];
    return {
        path: response.data?.path || virtualPath,
        entries,
        truncated: Boolean(response.data?.truncated),
    };
}

function formatFileVesselListEntry(entry, index) {
    const name = entry?.name || 'file';
    const kindOrSize = entry?.kind === 'directory'
        ? 'folder'
        : formatAttachmentSize(Number(entry?.size_bytes || 0));
    return `${index + 1}. ${name} (${kindOrSize}) - ${formatFileVesselLocation(entry)}`;
}

async function executeFileVesselListCommand(command, replyLanguage = 'id') {
    const targets = resolveFileVesselTargets(command);
    if (!targets.length) {
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }

    const sections = [];
    let successfulLists = 0;
    for (const vessel of targets) {
        try {
            const result = await listFileVesselEntries(vessel, command.root || 'downloads', command.limit || LILY_FILE_VESSEL_LIST_LIMIT);
            successfulLists += 1;
            const label = vessel.label || vessel.key || 'storage';
            const lines = result.entries.length
                ? result.entries.map((entry, index) => formatFileVesselListEntry(entry, index))
                : [normalizeReplyLanguage(replyLanguage) === 'en' ? '(empty)' : '(kosong)'];
            if (result.truncated) {
                lines.push(normalizeReplyLanguage(replyLanguage) === 'en' ? '...truncated' : '...dipotong');
            }
            sections.push(`[${label}]\n${lines.join('\n')}`);
        } catch (error) {
            console.warn(`[FILE VESSEL] List failed on ${vessel.label || vessel.key}:`, error?.message || error);
        }
    }

    if (!successfulLists) {
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }

    const header = normalizeReplyLanguage(replyLanguage) === 'en'
        ? `Files in ${command.root || 'downloads'}:`
        : `Isi ${command.root || 'downloads'}:`;
    return `${header}\n${sections.join('\n\n')}`;
}

async function sendFileVesselFile(file, chatId, replyLanguage = 'id') {
    if (!chatId || !file?.virtual_path) {
        return getLocalizedBridgeText('fileVesselSendFailed', replyLanguage, { detail: file?.name || 'file' });
    }
    if (Number(file.size_bytes || 0) > WA_ATTACHMENT_MAX_BYTES) {
        return getLocalizedBridgeText('fileVesselTooLarge', replyLanguage, {
            detail: formatAttachmentSize(Number(file.size_bytes || 0)),
        });
    }

    const vessel = getFileVesselByKey(file.vessel_key) || getDefaultFileVessel();
    if (!vessel) {
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }

    const downloadUrl = fileVesselUrl(vessel, `/api/file/download?path=${encodeURIComponent(file.virtual_path)}`);
    const { MessageMedia } = require('whatsapp-web.js');
    try {
        const response = await axios.get(downloadUrl, {
            headers: buildFileVesselHeaders(vessel),
            timeout: 60000,
            responseType: 'arraybuffer',
            maxContentLength: WA_ATTACHMENT_MAX_BYTES,
            maxBodyLength: WA_ATTACHMENT_MAX_BYTES,
        });
        const buffer = Buffer.from(response.data || []);
        if (buffer.length > WA_ATTACHMENT_MAX_BYTES) {
            return getLocalizedBridgeText('fileVesselTooLarge', replyLanguage, {
                detail: formatAttachmentSize(buffer.length),
            });
        }

        const mimeType = resolveDownloadedMimeType(response.headers?.['content-type'], file.name);
        const media = new MessageMedia(mimeType, buffer.toString('base64'), file.name, buffer.length);
        const caption = getLocalizedBridgeText('fileVesselSending', replyLanguage, {
            detail: formatFileVesselLocation(file),
        });
        const canSendAsImagePreview = isLikelyImageFile(file.name, media.mimetype)
            && buffer.length <= WA_IMAGE_ATTACHMENT_MAX_BYTES;
        if (canSendAsImagePreview) {
            await client.sendMessage(chatId, media, { caption });
        } else {
            if (isLikelyImageFile(file.name, media.mimetype)) {
                console.log(`[FILE VESSEL] Sending large image as document: ${file.name} (${formatAttachmentSize(buffer.length)}).`);
            }
            await client.sendMessage(chatId, media, { caption, sendMediaAsDocument: true });
        }
        return null;
    } catch (error) {
        console.error(`File Vessel download/send failed for ${file.name}:`, error?.message || error);
        return getLocalizedBridgeText('fileVesselSendFailed', replyLanguage, { detail: file.name });
    }
}

async function executeFileVesselSendCommand(command, chatId, replyLanguage = 'id') {
    const targets = resolveFileVesselTargets(command);
    if (!targets.length) {
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }
    if (!command.query) {
        return getLocalizedBridgeText('fileVesselQueryUnclear', replyLanguage);
    }
    setLastFileVesselSearch(chatId, command, replyLanguage);

    let files = [];
    let successfulSearches = 0;
    try {
        for (const query of fileVesselQueryVariants(command.query)) {
            const queryFiles = [];
            for (const vessel of targets) {
                try {
                    const entries = await searchFileVesselEntries(vessel, command.root, query);
                    successfulSearches += 1;
                    let vesselFiles = entries.filter((entry) => entry?.kind === 'file' && entry?.virtual_path);
                    if (command.desiredKind === 'image') {
                        vesselFiles = vesselFiles.filter((entry) => isLikelyImageFile(entry.name));
                    }
                    queryFiles.push(...vesselFiles);
                } catch (error) {
                    console.warn(`[FILE VESSEL] Search failed on ${vessel.label || vessel.key}:`, error?.message || error);
                }
            }
            files = queryFiles;
            if (files.length) break;
        }
    } catch (error) {
        console.error('File Vessel search failed:', error?.message || error);
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }

    if (!successfulSearches && !files.length) {
        return getLocalizedBridgeText('fileVesselUnavailable', replyLanguage);
    }

    if (!files.length) {
        return getLocalizedBridgeText('fileVesselNotFound', replyLanguage, {
            detail: `${command.query} di ${describeFileVesselScope(command)}`,
        });
    }

    const pending = setPendingFileVesselSend(chatId, files, replyLanguage);
    if (!pending) {
        return getLocalizedBridgeText('fileVesselSendFailed', replyLanguage, { detail: command.query });
    }

    if (pending.candidates.length === 1) {
        return getLocalizedBridgeText('fileVesselConfirmSingle', replyLanguage, {
            detail: formatFileVesselCandidate(pending.candidates[0]),
        });
    }

    const candidates = pending.candidates.map((entry, index) => formatFileVesselCandidate(entry, index)).join('\n');
    return getLocalizedBridgeText('fileVesselMultiple', replyLanguage, { detail: candidates });
}

async function executeFinanceParseTextCommand(command, chatId, replyLanguage = 'id') {
    try {
        const parsed = await requestFinanceApi(
            'post',
            '/api/finance/parse',
            { message: command.message || '', source: 'wa' },
            12000,
        );
        if (!parsed?.ok || !parsed.transaction) {
            return getLocalizedBridgeText('financeParseFailed', replyLanguage, { detail: parsed?.reason || 'unknown' });
        }

        const draftTransactions = financeDraftFromParseResponse(parsed);
        setPendingFinanceDraft(chatId, draftTransactions, replyLanguage, 'text');
        clearPendingFinanceImageFallback(chatId);
        return getLocalizedBridgeText('financeDraftReady', replyLanguage, {
            detail: formatFinanceDraftDetail(draftTransactions, replyLanguage),
        });
    } catch (error) {
        console.error('Finance text parse failed:', error?.message || error);
        return getLocalizedBridgeText('financeUnavailable', replyLanguage);
    }
}

async function executeFinanceSummaryCommand(command = {}, chatId = '', replyLanguage = 'id') {
    try {
        const summary = await requestFinanceApi('get', '/api/finance/summary', null, 12000);
        const account = findFinanceSummaryAccount(summary, command.account);
        setLastFinanceSummary(chatId, {
            summary,
            account,
            accountQuery: command.account || '',
        });
        return getLocalizedBridgeText('financeSummary', replyLanguage, {
            detail: formatFinanceSummary(summary, { account: command.account || '' }, replyLanguage),
        });
    } catch (error) {
        console.error('Finance summary failed:', error?.message || error);
        return getLocalizedBridgeText('financeUnavailable', replyLanguage);
    }
}

function executeFinancePeriodFollowUpCommand(chatId, replyLanguage = 'id') {
    const context = getLastFinanceSummary(chatId);
    if (!context) {
        return getLocalizedBridgeText('financeContextExpired', replyLanguage);
    }
    return formatFinancePeriodFollowUp(context, replyLanguage);
}

async function executeFinanceRecentTransactionsCommand(command = {}, replyLanguage = 'id') {
    try {
        const limit = Math.max(1, Math.min(25, Number(command.limit || 5)));
        const response = await requestFinanceApi('get', `/api/finance/transactions?limit=${limit}`, null, 12000);
        let transactions = Array.isArray(response?.items) ? response.items : [];
        if (command.scope === 'today') {
            const today = localFinanceDateKey();
            transactions = transactions.filter((transaction) => financeDateKey(transaction.occurred_at) === today);
        }
        return getLocalizedBridgeText('financeDetail', replyLanguage, {
            detail: formatFinanceRecentTransactions(transactions.slice(0, limit), command.scope || 'recent', replyLanguage),
        });
    } catch (error) {
        console.error('Finance recent transaction lookup failed:', error?.message || error);
        return getLocalizedBridgeText('financeUnavailable', replyLanguage);
    }
}

async function executeFinanceMonthExpenseCommand(replyLanguage = 'id') {
    try {
        const month = localFinanceMonthKey();
        const summary = await requestFinanceApi('get', `/api/finance/summary?month=${encodeURIComponent(month)}`, null, 12000);
        return getLocalizedBridgeText('financeDetail', replyLanguage, {
            detail: formatFinanceMonthExpense(summary, replyLanguage),
        });
    } catch (error) {
        console.error('Finance month expense lookup failed:', error?.message || error);
        return getLocalizedBridgeText('financeUnavailable', replyLanguage);
    }
}

function buildFinanceInterpretPayload(command, chatId, replyLanguage = 'id') {
    const context = getLastFinanceSummary(chatId);
    const payload = {
        message: command.message || '',
        source: 'wa',
        reply_language: normalizeReplyLanguage(replyLanguage),
    };
    if (context?.intent) payload.recent_intent = context.intent;
    if (context?.account) payload.recent_account = context.account;
    if (context?.period) payload.recent_period = context.period;
    return payload;
}

async function executeFinanceInterpretCommand(command, chatId, replyLanguage = 'id') {
    try {
        const startedAt = Date.now();
        const interpreted = await requestFinanceApi(
            'post',
            '/api/finance/interpret',
            buildFinanceInterpretPayload(command, chatId, replyLanguage),
            12000,
        );
        console.log(
            `[FINANCE] interpreted intent=${interpreted?.intent || 'unknown'} reason=${interpreted?.reason || '-'} in ${Date.now() - startedAt}ms`,
        );

        if (!interpreted || interpreted.intent === 'chat') {
            if (command.strict) {
                return getLocalizedBridgeText('financeParseFailed', replyLanguage, {
                    detail: interpreted?.reason || 'not_understood',
                });
            }
            return null;
        }

        const draftTransactions = interpreted.transactions?.length ? interpreted.transactions : interpreted.transaction;
        if (interpreted.intent === 'transaction_draft' && draftTransactions) {
            setPendingFinanceDraft(chatId, draftTransactions, replyLanguage, 'text');
            clearPendingFinanceImageFallback(chatId);
            return getLocalizedBridgeText('financeDraftReady', replyLanguage, {
                detail: formatFinanceDraftDetail(draftTransactions, replyLanguage),
            });
        }

        if (interpreted.reply) {
            setLastFinanceSummary(chatId, {
                intent: interpreted.intent,
                account: interpreted.account || '',
                period: interpreted.period || '',
            });
            return interpreted.reply;
        }

        return null;
    } catch (error) {
        console.error('Finance interpret failed:', error?.message || error);
        return getLocalizedBridgeText('financeUnavailable', replyLanguage);
    }
}

function buildFinanceAdminFeeTransaction(pending, amount) {
    const transactions = normalizeFinanceDraftTransactions(pending?.transactions || pending?.transaction);
    const main = transactions[0];
    if (!main || !amount || amount <= 0) return null;
    const groupRef = transactions.find((transaction) => transaction.external_ref)?.external_ref || createFinanceGroupRef('wa_transfer_fee');
    const target = main.merchant || main.note || 'recipient';
    return {
        direction: 'expense',
        amount,
        account: main.account,
        to_account: null,
        category: 'bank_fee',
        merchant: (main.account || 'bank').toString().toUpperCase(),
        note: `Admin transfer ke ${target}`,
        source: main.source || pending.source || 'wa',
        status: main.status || 'confirmed',
        external_ref: groupRef,
        occurred_at: main.occurred_at || null,
        currency: main.currency || null,
    };
}

async function executeFinanceAddAdminFeeCommand(command, chatId, replyLanguage = 'id') {
    const pending = getPendingFinanceDraft(chatId);
    if (!pending) {
        return getLocalizedBridgeText('financePendingExpired', replyLanguage);
    }
    const amount = Number(command.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
        return getLocalizedBridgeText('financeAdminFeeUnclear', replyLanguage);
    }

    const transactions = normalizeFinanceDraftTransactions(pending.transactions || pending.transaction);
    const adminFee = buildFinanceAdminFeeTransaction(pending, amount);
    if (!adminFee) {
        return getLocalizedBridgeText('financeAdminFeeUnclear', replyLanguage);
    }
    const groupRef = transactions.find((transaction) => transaction.external_ref)?.external_ref || adminFee.external_ref;
    const withoutOldFee = transactions
        .filter((transaction) => (transaction.category || '').toLowerCase() !== 'bank_fee')
        .map((transaction) => ({ ...transaction, external_ref: transaction.external_ref || groupRef }));
    const updatedTransactions = ensureFinanceDraftGroup([...withoutOldFee, adminFee]);
    setPendingFinanceDraft(chatId, updatedTransactions, pending.replyLanguage || replyLanguage, pending.source || 'text');
    return getLocalizedBridgeText('financeAdminFeeAdded', replyLanguage, {
        detail: formatFinanceDraftDetail(updatedTransactions, replyLanguage),
    });
}

async function tryRevisePendingFinanceDraft(chatId, message, replyLanguage = 'id') {
    const pending = getPendingFinanceDraft(chatId);
    if (!pending) return { handled: false, reply: '' };

    const transactions = normalizeFinanceDraftTransactions(pending.transactions || pending.transaction);
    if (!transactions.length) return { handled: false, reply: '' };

    try {
        const revision = await requestFinanceApi(
            'post',
            '/api/finance/drafts/revise',
            {
                message: (message || '').toString().trim(),
                transactions,
                source: 'wa',
                reply_language: normalizeReplyLanguage(replyLanguage),
            },
            12000,
        );
        if (revision?.action === 'unrelated') {
            return { handled: false, reply: '' };
        }
        if (revision?.action === 'clarification') {
            return {
                handled: true,
                reply: revision.reply || getLocalizedBridgeText('financeDraftRevisionUnclear', replyLanguage),
            };
        }
        if (revision?.action !== 'updated' || !revision.transactions?.length) {
            return { handled: false, reply: '' };
        }

        setPendingFinanceDraft(
            chatId,
            revision.transactions,
            pending.replyLanguage || replyLanguage,
            pending.source || 'text',
        );
        return {
            handled: true,
            reply: getLocalizedBridgeText('financeDraftRevised', replyLanguage, {
                detail: formatFinanceDraftDetail(revision.transactions, replyLanguage),
            }),
        };
    } catch (error) {
        console.warn('Finance pending draft revision skipped:', error?.message || error);
        return { handled: false, reply: '' };
    }
}

async function executeFinanceConfirmCommand(chatId, replyLanguage = 'id') {
    const pending = getPendingFinanceDraft(chatId);
    if (!pending) {
        return getLocalizedBridgeText('financePendingExpired', replyLanguage);
    }

    try {
        const transactions = normalizeFinanceDraftTransactions(pending.transactions || pending.transaction);
        const savedTransactions = [];
        for (const transaction of transactions) {
            const saved = await requestFinanceApi('post', '/api/finance/transactions', transaction, 15000);
            savedTransactions.push(saved || transaction);
        }
        clearPendingFinanceDraft(chatId);
        clearPendingFinanceImageFallback(chatId);
        return getLocalizedBridgeText('financeSaved', replyLanguage, {
            detail: formatFinanceTransactions(savedTransactions.length ? savedTransactions : transactions),
        });
    } catch (error) {
        console.error('Finance save failed:', error?.message || error);
        return getLocalizedBridgeText('financeSaveFailed', replyLanguage, { detail: error?.message || 'unknown' });
    }
}

async function executeFinanceCategoryUpdateCommand(command, chatId, replyLanguage = 'id') {
    const pending = getPendingFinanceDraft(chatId);
    if (!pending) {
        return getLocalizedBridgeText('financePendingExpired', replyLanguage);
    }

    const category = normalizeFinanceCategoryName(command.category);
    if (!category) {
        return getLocalizedBridgeText('financeCategoryUnclear', replyLanguage);
    }

    const transactions = normalizeFinanceDraftTransactions(pending.transactions || pending.transaction);
    const updatedTransactions = transactions.map((transaction, index) => (
        index === 0 ? { ...transaction, category } : transaction
    ));
    const updatedTransaction = updatedTransactions[0];
    setPendingFinanceDraft(chatId, updatedTransactions, pending.replyLanguage || replyLanguage, pending.source || 'text');

    const rulePayload = buildFinanceCategoryRulePayload(updatedTransaction, category);
    const hasRuleTarget = Boolean(rulePayload.merchant || rulePayload.keyword);
    if (!hasRuleTarget) {
        return getLocalizedBridgeText('financeCategoryUpdatedNoRule', replyLanguage, {
            detail: formatFinanceDraftDetail(updatedTransactions, replyLanguage),
        });
    }

    try {
        await requestFinanceApi('post', '/api/finance/category-rules', rulePayload, 10000);
        return getLocalizedBridgeText('financeCategoryUpdated', replyLanguage, {
            detail: formatFinanceDraftDetail(updatedTransactions, replyLanguage),
        });
    } catch (error) {
        console.error('Finance category rule save failed:', error?.message || error);
        return getLocalizedBridgeText('financeCategoryUpdatedNoRule', replyLanguage, {
            detail: formatFinanceDraftDetail(updatedTransactions, replyLanguage),
        });
    }
}

async function executeHomeControlCommand(command, replyLanguage = 'id', chatId = '') {
    if (!LILY_CORE_URL) {
        return replyLanguage === 'en'
            ? 'Lily Core is not configured for home control yet.'
            : 'Lily Core belum dikonfigurasi buat kontrol rumah.';
    }

    const language = normalizeReplyLanguage(replyLanguage);
    const response = await requestCore('post', `${LILY_CORE_URL}/api/core/ingest`, {
        source: 'wa_bridge',
        session_id: buildWhatsAppUserId(chatId, true),
        mode: 'owner_chat',
        payload: {
            sender_name: 'Owner',
            requester: 'wa_owner',
            message: command.message || '',
            chat_id: chatId,
            is_owner: true,
            wa_profile: WA_PROFILE,
            access_scope: 'owner',
            delivery_channel: 'wa',
            delivery_profile: WA_PROFILE,
            delivery_target: chatId,
            reply_language: language,
            owner_presence: getActiveOwnerPresence(),
        },
    }, 45000, false);

    return response.data?.result?.text || (
        language === 'en' ? 'The home command completed without a text reply.' : 'Perintah rumah selesai tanpa balasan teks.'
    );
}

async function executeResetConversationCommand(chatId, replyLanguage = 'id') {
    if (!LILY_CORE_URL) {
        return getLocalizedBridgeText('conversationResetFailed', replyLanguage);
    }

    try {
        const sessionId = buildWhatsAppUserId(chatId, true);
        await requestCore(
            'post',
            `${LILY_CORE_URL}/api/core/session/${encodeURIComponent(sessionId)}/reset`,
            {},
            10000,
        );

        clearPendingFileVesselSend(chatId);
        clearLastFileVesselSearch(chatId);
        clearPendingFinanceDraft(chatId);
        clearPendingFinanceImageFallback(chatId);
        clearLastFinanceSummary(chatId);
        clearCachedOwnerPdf(chatId);

        const session = sessionStats[chatId];
        if (session) {
            session.pendingMessage = '';
            session.pendingInputFiles = [];
            session.messageCount = 0;
            session.hasVoiceMessage = false;
            session.voiceInputReady = false;
        }

        return getLocalizedBridgeText('conversationResetDone', replyLanguage);
    } catch (error) {
        console.error('WhatsApp conversation reset failed:', error?.message || error);
        return getLocalizedBridgeText('conversationResetFailed', replyLanguage);
    }
}

function formatUtilityDuration(durationMs, replyLanguage = 'id') {
    const totalMinutes = Math.max(1, Math.round(Number(durationMs || 0) / 60000));
    if (totalMinutes % 1440 === 0) {
        const days = totalMinutes / 1440;
        return normalizeReplyLanguage(replyLanguage) === 'en' ? `${days} day(s)` : `${days} hari`;
    }
    if (totalMinutes % 60 === 0) {
        const hours = totalMinutes / 60;
        return normalizeReplyLanguage(replyLanguage) === 'en' ? `${hours} hour(s)` : `${hours} jam`;
    }
    return normalizeReplyLanguage(replyLanguage) === 'en' ? `${totalMinutes} minute(s)` : `${totalMinutes} menit`;
}

async function executeOwnerUtilityCommand(command, chatId, replyLanguage = 'id') {
    const language = normalizeReplyLanguage(replyLanguage);
    const session = sessionStats[chatId];

    if (command.type === 'route_debug') {
        let route = null;
        try {
            const response = await requestCore('get', `${LILY_CORE_URL}/api/owner/wa/state`, null, 10000);
            const routes = Array.isArray(response.data?.route_history) ? response.data.route_history : [];
            route = routes[routes.length - 1] || null;
        } catch (error) {
            console.warn('Durable route state was unavailable:', error?.message || error);
            route = session?.lastRouteDecision;
        }
        if (!route) {
            return language === 'en'
                ? 'There is no previous routing decision to inspect yet.'
                : 'Belum ada keputusan route sebelumnya yang bisa Lily tunjukin.';
        }
        const confidence = Math.round(Number(route.confidence || 0) * 100);
        const reason = route.reason || 'no_action_hint';
        return language === 'en'
            ? `Last route: ${route.intent || 'chat'} (${confidence}%) via ${route.source || 'wa_chat_gate'}. Reason: ${reason}.`
            : `Route terakhir: ${route.intent || 'chat'} (${confidence}%) lewat ${route.source || 'wa_chat_gate'}. Alasan: ${reason}.`;
    }

    if (command.type === 'proactive_quiet') {
        const pausedUntil = setProactivePause(command.durationMs);
        const duration = formatUtilityDuration(pausedUntil - Date.now(), language);
        return language === 'en'
            ? `Okay. Lily will pause proactive messages for ${duration}. Normal replies still work.`
            : `Oke. Chat proaktif Lily diam dulu selama ${duration}. Kalau kamu chat, Lily tetap jawab.`;
    }

    if (command.type === 'proactive_resume') {
        clearProactivePause();
        return language === 'en'
            ? 'Proactive messages are active again.'
            : 'Chat proaktif Lily aktif lagi. Jangan kaget kalau nanti Lily nyariin kamu.';
    }

    if (command.type === 'cancel_pending') {
        const hadPending = Boolean(
            getPendingFileVesselSend(chatId)
            || getLastFileVesselSearch(chatId)
            || getPendingFinanceDraft(chatId)
            || getPendingFinanceImageFallback(chatId)
            || getCachedOwnerPdf(chatId)
        );
        clearPendingFileVesselSend(chatId);
        clearLastFileVesselSearch(chatId);
        clearPendingFinanceDraft(chatId);
        clearPendingFinanceImageFallback(chatId);
        clearLastFinanceSummary(chatId);
        clearCachedOwnerPdf(chatId);
        return language === 'en'
            ? (hadPending ? 'Pending WhatsApp actions were cancelled.' : 'There were no pending WhatsApp actions.')
            : (hadPending ? 'Yang masih pending di WA sudah Lily batalin.' : 'Nggak ada aksi WA yang lagi pending.');
    }

    if (command.type === 'retry_last') {
        let previousMessage = '';
        try {
            const response = await requestCore('get', `${LILY_CORE_URL}/api/owner/wa/state`, null, 10000);
            previousMessage = (response.data?.last_owner_message || '').toString().trim();
        } catch (error) {
            console.warn('Durable retry state was unavailable:', error?.message || error);
            previousMessage = (session?.lastOwnerTextRequest || '').toString().trim();
        }
        if (!previousMessage) {
            return language === 'en'
                ? 'There is no previous chat message to retry yet.'
                : 'Belum ada pesan chat sebelumnya yang bisa Lily jawab ulang.';
        }
        try {
            const result = await sendOwnerMessageToCore(chatId, previousMessage, false, language);
            return result.text || getLocalizedBridgeText('ownerCannotAnswer', language);
        } catch (error) {
            console.error('WhatsApp retry command failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'context_status') {
        try {
            const response = await requestCore('get', `${LILY_CORE_URL}/api/owner/wa/state`, null, 10000);
            const state = response.data || {};
            const pinned = Array.isArray(state.pinned_memory) ? state.pinned_memory : [];
            const topics = Array.isArray(state.recent_topics) ? state.recent_topics.slice(0, 4) : [];
            const replyLengthMode = getOwnerReplyLengthMode();
            const lines = language === 'en'
                ? [
                    `Shared WA context: ${Number(state.event_count || 0)} recent turn(s).`,
                    `Pinned memory: ${pinned.length}.`,
                    `Reply length: ${replyLengthMode}.`,
                ]
                : [
                    `Konteks WA bersama: ${Number(state.event_count || 0)} turn terbaru.`,
                    `Memory yang dipin: ${pinned.length}.`,
                    `Panjang balasan: ${replyLengthMode}.`,
                ];
            if (topics.length) {
                lines.push(language === 'en' ? 'Recent topics:' : 'Topik terbaru:');
                lines.push(...topics.map((topic) => `- ${topic}`));
            }
            if (pinned.length) {
                lines.push(language === 'en' ? 'Pinned:' : 'Dipin:');
                lines.push(...pinned.map((item, index) => `${index + 1}. ${item}`));
            }
            return lines.join('\n');
        } catch (error) {
            console.error('WhatsApp context status failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'pin_memory') {
        try {
            const response = await requestCore(
                'post',
                `${LILY_CORE_URL}/api/owner/wa/memory/pin`,
                { text: command.text },
                10000,
            );
            const memory = response.data?.memory;
            return language === 'en'
                ? `Pinned as memory ${memory?.index || ''}: ${memory?.text || command.text}`
                : `Udah Lily pin jadi memory ${memory?.index || ''}: ${memory?.text || command.text}`;
        } catch (error) {
            console.error('WhatsApp memory pin failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'unpin_memory') {
        try {
            const response = await requestCore(
                'post',
                `${LILY_CORE_URL}/api/owner/wa/memory/unpin`,
                { index: command.index },
                10000,
            );
            if (!response.data?.ok) {
                return language === 'en'
                    ? `Pinned memory ${command.index} does not exist. Check /context first.`
                    : `Memory pin nomor ${command.index} nggak ada. Cek /context dulu ya.`;
            }
            return language === 'en'
                ? `Removed pinned memory ${command.index}: ${response.data.memory?.text || ''}`
                : `Memory pin nomor ${command.index} udah Lily lepas: ${response.data.memory?.text || ''}`;
        } catch (error) {
            console.error('WhatsApp memory unpin failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'forget_last') {
        try {
            const sessionId = buildWhatsAppUserId(chatId, true);
            const response = await requestCore(
                'post',
                `${LILY_CORE_URL}/api/core/session/${encodeURIComponent(sessionId)}/forget-last`,
                {},
                10000,
            );
            return response.data?.ok
                ? (language === 'en'
                    ? 'Okay. Lily removed only the latest conversation turn.'
                    : 'Oke, Lily hapus satu turn obrolan yang paling baru aja.')
                : (language === 'en'
                    ? 'There is no conversation turn left to remove.'
                    : 'Udah nggak ada turn obrolan yang bisa dihapus.');
        } catch (error) {
            console.error('WhatsApp forget-last failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'conversation_recap') {
        try {
            const recapPrompt = language === 'en'
                ? 'Briefly recap our recent WhatsApp conversation. Keep only useful topics, decisions, and unfinished items.'
                : 'Ringkas singkat obrolan WhatsApp kita belakangan ini. Ambil topik penting, keputusan, dan hal yang belum selesai saja.';
            const result = await sendOwnerMessageToCore(chatId, recapPrompt, false, language);
            return result.text || getLocalizedBridgeText('ownerCannotAnswer', language);
        } catch (error) {
            console.error('WhatsApp recap command failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'owner_mood_alias') {
        try {
            const moodMessage = command.mode === 'serious'
                ? (language === 'en' ? 'lily calm down' : 'lily tenang')
                : 'lily normal';
            const result = await sendOwnerMessageToCore(chatId, moodMessage, false, language);
            return result.text || getLocalizedBridgeText('ownerCannotAnswer', language);
        } catch (error) {
            console.error('WhatsApp mood alias failed:', error?.message || error);
            return getCoreUnavailableReply(language);
        }
    }

    if (command.type === 'owner_reply_length') {
        const mode = setOwnerReplyLengthMode(command.mode);
        if (command.resetMood) {
            try {
                await sendOwnerMessageToCore(chatId, 'lily normal', false, language);
            } catch (error) {
                console.warn('WhatsApp normal mood reset failed:', error?.message || error);
            }
        }
        if (language === 'en') {
            return {
                short: 'Short mode is active. Lily will keep ordinary replies very compact.',
                detail: 'Detail mode is active. Lily can explain things more fully.',
                normal: 'Normal mode is active. Reply length will adapt to the question.',
            }[mode];
        }
        return {
            short: 'Mode short aktif. Balasan biasa Lily bakal pendek banget.',
            detail: 'Mode detail aktif. Lily boleh jelasin lebih lengkap.',
            normal: 'Mode normal aktif. Panjang balasan bakal menyesuaikan pertanyaan.',
        }[mode];
    }

    return null;
}

async function executeFamilyOwnerCommand(command) {
    if (!LILY_CORE_URL) return 'Family service belum terhubung ke Core.';
    if (!LILY_OWNER_API_TOKEN) return 'Perintah Family di WhatsApp butuh LILY_OWNER_API_TOKEN di konfigurasi WA Vessel.';

    const base = LILY_CORE_URL.replace(/\/+$/, '');
    const get = async (path) => (await requestCore('get', `${base}${path}`, null, 10000, false)).data;
    const post = async (path, body) => (await requestCore('post', `${base}${path}`, body, 10000, false)).data;
    const devices = async () => {
        const response = await get('/api/owner/family/devices');
        return Array.isArray(response.devices) ? response.devices.filter((item) => !item.revoked_at) : [];
    };
    const resolveDevice = (items, requestedName) => {
        const needle = (requestedName || '').trim().toLocaleLowerCase('id-ID');
        const exact = items.filter((item) => String(item.name || '').trim().toLocaleLowerCase('id-ID') === needle);
        if (exact.length === 1) return { device: exact[0] };
        const partial = items.filter((item) => String(item.name || '').trim().toLocaleLowerCase('id-ID').includes(needle));
        if (exact.length > 1 || partial.length > 1) return { error: `Nama perangkat ambigu. Pilih salah satu: ${[...new Set((exact.length ? exact : partial).map((item) => item.name))].join(', ')}.` };
        if (partial.length === 1) return { device: partial[0] };
        return { error: `Perangkat keluarga “${requestedName}” tidak ditemukan. Pakai /keluarga untuk melihat nama.` };
    };
    const time = (seconds) => seconds ? new Date(Number(seconds) * 1000).toLocaleString('id-ID') : 'belum ada';

    try {
        if (command.type === 'family_status') {
            const list = await devices();
            if (!list.length) return 'Belum ada HP keluarga yang dipasangkan.';
            return ['Perangkat keluarga:', ...list.map((device) => {
                const state = device.online ? 'online' : 'offline/lama';
                const sms = device.sms_permission ? 'SMS aktif' : 'SMS mati';
                const location = device.location_permission ? `lokasi ${device.location_mode || 'aktif'}` : 'lokasi mati';
                return `• ${device.name}: ${state}, ${sms}, ${location}; sync ${time(device.last_seen_at)}`;
            })].join('\n');
        }

        const list = await devices();
        const selected = resolveDevice(list, command.deviceName);
        if (!selected.device) return selected.error;
        const device = selected.device;

        if (command.type === 'family_sms') {
            const response = await get(`/api/owner/family/devices/${device.id}/sms?limit=10`);
            const items = Array.isArray(response.items) ? response.items : [];
            const viewer = (process.env.LILY_FAMILY_VIEWER_URL || '').trim();
            let viewerText = 'Buka Control Center → Family → Open private SMS untuk membaca isinya.';
            try {
                const parsed = new URL(viewer);
                if (parsed.protocol === 'https:') viewerText = `Buka panel privat: ${parsed.href}`;
            } catch { }
            if (!items.length) return `${device.name}: tidak ada SMS dalam 24 jam terakhir. ${viewerText}`;
            const recent = items.slice(0, 3).map((item) => `• ${item.sender}, ${time(item.received_at)}`);
            return `${device.name}: ${items.length} SMS terbaru tersimpan (retensi 24 jam). Isi tidak dikirim lewat WhatsApp.\n${recent.join('\n')}\n${viewerText}`;
        }

        if (command.type === 'family_location') {
            const response = await get(`/api/owner/family/devices/${device.id}/location`);
            const location = response.location;
            if (!location) return `${device.name}: belum mengirim lokasi.`;
            return `${device.name}: ${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)} (akurasi ±${Math.round(Number(location.accuracy_m))} m), diambil ${time(location.captured_at)}${location.stale ? ' — lokasi sudah lama' : ''}.`;
        }

        if (command.type === 'family_location_mode') {
            const response = await post(`/api/owner/family/devices/${device.id}/location-mode`, { mode: command.mode });
            const label = command.mode === 'live' ? 'live 15 menit' : 'hemat';
            return `Permintaan mode ${label} untuk ${device.name} berstatus ${response.status || 'menunggu'}. HP perlu menerima dan mengonfirmasi perintah; Lily belum menganggapnya aktif. Android bisa menunggu slot sync berikutnya sebelum FCM disiapkan.`;
        }
    } catch (error) {
        console.warn('WhatsApp Family command failed:', error?.message || error);
        return 'Data Family belum bisa diambil dari Core. Cek koneksi, token owner WA, dan layanan Family Core.';
    }
    return null;
}

async function executeOwnerCommand(command, replyLanguage = 'id', chatId = '') {
    if (!command) return null;

    if (command.type === 'invalid') {
        return command.reply;
    }

    if (['family_status', 'family_sms', 'family_location', 'family_location_mode'].includes(command.type)) {
        return await executeFamilyOwnerCommand(command);
    }

    if (command.type === 'reset_conversation') {
        return await executeResetConversationCommand(chatId, replyLanguage);
    }

    if ([
        'route_debug',
        'retry_last',
        'proactive_quiet',
        'proactive_resume',
        'conversation_recap',
        'context_status',
        'pin_memory',
        'unpin_memory',
        'forget_last',
        'cancel_pending',
        'owner_mood_alias',
        'owner_reply_length',
    ].includes(command.type)) {
        return await executeOwnerUtilityCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'contact_policy_status') {
        const policy = contactPolicy.snapshot();
        const circle = policy.circle.length ? policy.circle.join(', ') : 'empty';
        const neverReply = policy.secretary_never_reply.length ? policy.secretary_never_reply.join(', ') : 'empty';
        return `WhatsApp contact policy\nCircle (${policy.circle.length}): ${circle}\nSecretary never-reply (${policy.secretary_never_reply.length}): ${neverReply}\nPersonal mode: ${secretary.mode()}`;
    }

    if (command.type === 'contact_policy_change') {
        const operation = command.action === 'add' ? contactPolicy.add : contactPolicy.remove;
        const result = operation.call(contactPolicy, command.scope, command.number);
        if (!result.ok) return 'That phone number is unclear. Use international format, for example 62812...';
        const label = command.scope === 'circle' ? 'Circle' : 'Secretary never-reply';
        const action = command.action === 'add' ? 'added' : 'removed';
        return `${label}: ${result.number} ${action}${result.changed ? '.' : ' (no change).'}`;
    }

    if (command.type === 'owner_note') {
        return addOwnerMemoryNote(command.value)
            ? getLocalizedBridgeText('noteSaved', replyLanguage, { detail: command.value })
            : getLocalizedBridgeText('noteUnclear', replyLanguage);
    }

    if (command.type === 'preferred_name') {
        return setOwnerPreferredName(command.value)
            ? getLocalizedBridgeText('preferredNameSaved', replyLanguage, { detail: command.value })
            : getLocalizedBridgeText('preferredNameUnclear', replyLanguage);
    }

    if (command.type === 'nickname') {
        return setOwnerNickname(command.value)
            ? getLocalizedBridgeText('nicknameSaved', replyLanguage, { detail: command.value })
            : getLocalizedBridgeText('nicknameUnclear', replyLanguage);
    }

    if (command.type === 'contact_tag') {
        return setContactTag(command.phoneNumber, command.relation, command.label)
            ? getLocalizedBridgeText('contactTagged', replyLanguage, { id: command.phoneNumber, detail: command.label })
            : getLocalizedBridgeText('contactTagFailed', replyLanguage);
    }

    if (command.type === 'wa_status') {
        return await buildWaStatusReply(command.target || 'all', replyLanguage);
    }

    if (command.type === 'wa_help') {
        return buildWaHelpReply(replyLanguage);
    }

    if (command.type === 'finance_interpret') {
        return await executeFinanceInterpretCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'finance_parse_text') {
        return await executeFinanceParseTextCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'finance_summary') {
        return await executeFinanceSummaryCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'finance_period_followup') {
        return executeFinancePeriodFollowUpCommand(chatId, replyLanguage);
    }

    if (command.type === 'finance_recent_transactions') {
        return await executeFinanceRecentTransactionsCommand(command, replyLanguage);
    }

    if (command.type === 'finance_month_expense') {
        return await executeFinanceMonthExpenseCommand(replyLanguage);
    }

    if (command.type === 'finance_confirm') {
        return await executeFinanceConfirmCommand(chatId, replyLanguage);
    }

    if (command.type === 'finance_update_category') {
        return await executeFinanceCategoryUpdateCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'finance_add_admin_fee') {
        return await executeFinanceAddAdminFeeCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'finance_cancel') {
        clearPendingFinanceDraft(chatId);
        clearPendingFinanceImageFallback(chatId);
        return getLocalizedBridgeText('financeCancelled', replyLanguage);
    }

    if (command.type === 'file_vessel_list') {
        return await executeFileVesselListCommand(command, replyLanguage);
    }

    if (command.type === 'file_vessel_send') {
        return await executeFileVesselSendCommand(command, chatId, replyLanguage);
    }

    if (command.type === 'file_vessel_repeat_search') {
        return await executeFileVesselSendCommand(command.command, chatId, replyLanguage);
    }

    if (command.type === 'file_vessel_no_recent_search') {
        return getLocalizedBridgeText('fileVesselNoRecentSearch', replyLanguage);
    }

    if (command.type === 'file_vessel_cancel') {
        clearPendingFileVesselSend(chatId);
        return getLocalizedBridgeText('fileVesselCancelled', replyLanguage);
    }

    if (command.type === 'file_vessel_confirm') {
        const pending = getPendingFileVesselSend(chatId);
        if (!pending) {
            return getLocalizedBridgeText('fileVesselPendingExpired', replyLanguage);
        }
        if (!Number.isInteger(command.index)) {
            return getLocalizedBridgeText('fileVesselChoiceUnclear', replyLanguage);
        }

        const file = pending.candidates[command.index];
        if (!file) {
            return getLocalizedBridgeText('fileVesselChoiceUnclear', replyLanguage);
        }

        clearPendingFileVesselSend(chatId);
        console.log(`[FILE VESSEL] Confirmed WA file send for ${chatId}: ${file.virtual_path}`);
        return await sendFileVesselFile(file, chatId, replyLanguage);
    }

    if (command.type === 'wake_pc') {
        return await executeWakePcCommand(replyLanguage);
    }

    if (command.type === 'home_control') {
        return await executeHomeControlCommand(command, replyLanguage, chatId);
    }

    if (command.type === 'secretary_mode') {
        await secretaryConfig.refresh();
        const current = secretaryConfig.snapshot();
        if (!current) return 'Pengaturan sekretaris belum tersambung ke Core. Balasan otomatis tetap berhenti.';
        if (command.mode !== 'status') {
            try {
                await requestCore('post', `${LILY_CORE_URL}/api/wa/secretary/settings`, {
                    revision: current.revision, settings: { ...current.settings, mode: command.mode },
                }, 5000, false);
                await secretaryConfig.refresh();
            } catch { return 'Mode belum tersimpan. Coba muat ulang pengaturan sekretaris di launcher.'; }
        }
        const active = secretary.enabled();
        return `Sekretaris Lily: ${secretary.mode()} (${active ? 'aktif' : 'siaga/nonaktif'}).\n`
            + 'Auto: aktif saat kamu sibuk; on: aktif manual; off: berhenti.\n'
            + 'Pakai: lily sekretaris on / off / auto / status.';
    }

    if (command.type === 'owner_presence') {
        const presence = setOwnerPresence({
            status: command.status,
            label: command.label,
            note: command.note,
            source: 'wa',
        });
        await forwardOwnerPresenceToCore(presence);
        const key = presence.status === 'available' ? 'presenceAvailable' : 'presenceSet';
        return getLocalizedBridgeText(key, replyLanguage, {
            status: presence.label,
        });
    }

    if (command.type === 'wa_presence_status') {
        const presence = getActiveOwnerPresence();
        return normalizeReplyLanguage(replyLanguage) === 'en'
            ? `Your status: ${presence.label}.`
            : `Status kamu: ${presence.label}.`;
    }

    if (command.type === 'openclaw_approve') {
        return await approveOpenClawTask(command.taskId, replyLanguage);
    }

    if (command.type === 'openclaw_deny') {
        return await denyOpenClawTask(command.taskId, command.reason, replyLanguage);
    }

    return null;
}

async function fetchPromptSnapshot() {
    const response = await requestCore('get', `${LILY_CORE_URL.replace(/\/+$/, '')}/api/prompts`, null, 2000, false);
    return response.data;
}

// Warm the offline cache without involving chat, tools, or inference.
setTimeout(() => { void require('./prompt-store').refresh(fetchPromptSnapshot); }, 10000).unref();
setInterval(() => { void require('./prompt-store').refresh(fetchPromptSnapshot); }, 60000).unref();

async function summarizeExternalMessage(contactName, message) {
    try {
        const response = await requestCore('post',
            `${LILY_CORE_URL.replace(/\/+$/, '')}/api/wa/inbox/summarize`,
            { contact_name: String(contactName || 'Unknown').slice(0, 100), message: message.slice(0, 12000) },
            15000, false);
        const summary = response.data?.summary;
        if (typeof summary !== 'string' || !summary.trim()) throw new Error('Empty summary');
        return summary.trim().slice(0, 500);
    } catch (error) {
        console.warn('External inbox summary unavailable; using message excerpt.');
        return message.length > 120 ? `${message.slice(0, 117)}...` : message;
    }
}

function hasExternalInboxEntry(chatId, message, createdAt = '') {
    const normalizedMessage = (message || '').trim();
    if (!chatId || !normalizedMessage) return false;

    return externalInbox.some((item) =>
        item.chatId === chatId
        && (item.originalMessage || '').trim() === normalizedMessage
        && (!createdAt || item.createdAt === createdAt)
    );
}

async function pushExternalInboxItem(chatId, message, options = {}) {
    const captureVersion = inboxReview.captureVersion(chatId);
    const normalizedMessage = (message || '').trim();
    if (!normalizedMessage) return null;

    const createdAt = options.createdAt || new Date().toISOString();
    if (hasExternalInboxEntry(chatId, normalizedMessage, createdAt)) {
        return externalInbox.find((item) =>
            item.chatId === chatId
            && (item.originalMessage || '').trim() === normalizedMessage
            && item.createdAt === createdAt
        ) || null;
    }

    const profile = getContactProfile(chatId);
    const contactName = await resolveContactDisplayName(chatId, profile, options.chatRef || null);
    const summary = options.category === 'promotion'
        ? normalizedMessage.slice(0, 500)
        : await summarizeExternalMessage(contactName, normalizedMessage);
    const item = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        phoneNumber: profile?.phoneNumber || normalizePhoneNumber((chatId || '').split('@')[0]),
        name: contactName,
        relation: profile?.relation || 'unknown',
        label: profile?.label || 'general',
        summary,
        originalMessage: normalizedMessage,
        createdAt,
        waProfile: WA_PROFILE,
        policyDecision: options.policyDecision || 'routine',
        policyReason: options.policyReason || 'routine',
        priority: options.priority || 'normal',
        category: options.category || 'uncertain',
        confidence: options.confidence || 'low',
        triageMode: options.triageMode || 'shadow',
    };

    externalInbox.unshift(item);
    inboxReview.captured(chatId, captureVersion);
    sortExternalInboxNewestFirst();
    trimExternalInbox();
    saveExternalInbox();

    if (profile) {
        profile.lastSummaryAt = item.createdAt;
        saveContactProfiles();
    }

    return item;
}

async function captureInboxMessage(chatId, message, options = {}) {
    if (IS_PERSONAL_PROFILE && secretaryConfig.action(getContactProfile(chatId)?.phoneNumber || chatId.split('@')[0]) === 'ignore') return null;
    const inboxItem = await pushExternalInboxItem(chatId, message, options);

    if (!inboxItem || options.skipNotify) {
        return inboxItem;
    }

    queueInboxNotification(inboxItem);
    return inboxItem;
}

async function backfillExternalInboxFromRecentChats() {
    if (!INBOX_BACKFILL_ENABLED) {
        console.log('[INBOX] Startup backfill disabled; live incoming capture remains enabled.');
        return;
    }

    if (INBOX_BACKFILL_START_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, INBOX_BACKFILL_START_DELAY_MS));
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const ownerNumber = process.env.OWNER_NUMBER;
            const recentChatTargets = [...new Map(
                externalInbox
                    .filter((item) => item?.chatId)
                    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                    .map((item) => {
                        const sourceChatId = item.chatId;
                        const phoneNumber = normalizePhoneNumber(item.phoneNumber || '');
                        const lookupId = phoneNumber ? `${phoneNumber}@c.us` : sourceChatId;
                        return [lookupId, { sourceChatId, lookupId }];
                    }),
            ).values()].slice(0, INBOX_BACKFILL_CHAT_LIMIT);

            for (const target of recentChatTargets) {
                try {
                    const chat = await client.getChatById(target.lookupId);
                    if (!chat || chat.isGroup || matchesConfiguredNumber(target.sourceChatId, ownerNumber, chat.contact)) continue;
                    const resolvedName = await resolveContactDisplayName(target.sourceChatId, getContactProfile(target.sourceChatId), chat);
                    const messages = await chat.fetchMessages({ limit: INBOX_BACKFILL_MESSAGE_LIMIT });
                    const incomingMessages = messages
                        .filter((message) => !message.fromMe && message.from !== 'status@broadcast')
                        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

                    const latestIncoming = incomingMessages[0];
                    if (!latestIncoming) continue;

                    const text = latestIncoming.type === 'ptt' || latestIncoming.type === 'audio'
                        ? '[voice message]'
                        : (latestIncoming.body || '').trim();

                    if (!text) continue;

                    await captureInboxMessage(target.sourceChatId, text, {
                        createdAt: latestIncoming.timestamp
                            ? new Date(latestIncoming.timestamp * 1000).toISOString()
                            : new Date().toISOString(),
                        skipNotify: true,
                        chatRef: {
                            name: resolvedName,
                            formattedTitle: chat.formattedTitle,
                            contact: chat.contact,
                        },
                    });
                } catch (chatError) {
                    console.warn(`[INBOX] Backfill skipped chat ${target.lookupId || 'unknown'}:`, chatError.message || chatError);
                }
            }

            console.log(`[INBOX] Backfill complete. Total inbox items: ${externalInbox.length}`);
            return;
        } catch (error) {
            if (attempt >= maxAttempts) {
                console.warn(`[INBOX] Backfill skipped after ${maxAttempts} attempts:`, error.message || error);
                return;
            }
            console.warn(`[INBOX] Backfill unavailable (attempt ${attempt}/${maxAttempts}); retrying in ${INBOX_BACKFILL_RETRY_DELAY_MS} ms:`, error.message || error);
            await new Promise((resolve) => setTimeout(resolve, INBOX_BACKFILL_RETRY_DELAY_MS));
        }
    }
}

async function sendOwnerInboxNotification(event) {
    const ownerChatId = `${normalizePhoneNumber(process.env.OWNER_NUMBER)}@c.us`;
    const message = `${event.title}\n\n${event.text}`;
    if (IS_PERSONAL_PROFILE && LILY_WA_PUBLIC_CONTROL_URL && BRIDGE_CONTROL_TOKEN) {
        await axios.post(`${LILY_WA_PUBLIC_CONTROL_URL}/api/owner/notify`, { message, source: 'personal' }, {
            headers: { 'X-Lily-Token': BRIDGE_CONTROL_TOKEN }, timeout: 10000,
        });
        return; // A timeout is uncertain; a second transport could duplicate the notification.
    }
    await client.sendMessage(ownerChatId, message);
}

async function sendHudInboxNotification(event) {
    if (!LILY_CORE_URL) throw new Error('HUD Core is unavailable.');
        await requestCore('post', `${LILY_CORE_URL.replace(/\/+$/, '')}/api/hud/notify`, {
            text: event.text,
            sender: event.title,
            summary: event.text,
            source: 'wa_inbox',
            notification_kind: 'wa_inbox',
            priority: 'normal',
            want_voice: LILY_WA_HUD_VOICE_ENABLED,
            voice_language: LILY_WA_HUD_VOICE_LANGUAGE,
            voice_profile: LILY_WA_HUD_VOICE_PROFILE,
            voice_route: LILY_WA_HUD_VOICE_ROUTE,
        }, 90000, false);
}

syncExternalInboxMetadata();

function isCommandWhitelisted(message, isOwner, hasInputFiles = false) {
    if (!isOwner) return false;
    if (hasInputFiles) return true;
    if (isOpenClawRequestMessage(message)) return true;

    const lowerMsg = (message || '').toLowerCase();
    const allowedPatterns = [
        'nyala pc',
        'nyala komputer',
        'nyala core',
        'voice',
        'suara',
        'vn',
        'tts',
        'openclaw',
        'search',
        'browse',
        'berita terbaru',
        'latest news',
        'buka aplikasi',
    ];

    return allowedPatterns.some((pattern) => lowerMsg.includes(pattern));
}

function buildCoreRequestConfig(timeout, extra = {}) {
    const extraHeaders = extra.headers || {};
    const config = {
        ...extra,
        timeout,
        httpAgent: CORE_HTTP_AGENT,
        httpsAgent: CORE_HTTPS_AGENT,
        headers: {
            Connection: 'close',
            ...(LILY_OWNER_API_TOKEN ? { Authorization: `Bearer ${LILY_OWNER_API_TOKEN}` } : {}),
            ...extraHeaders,
        },
    };

    return config;
}

function isTransientCoreTransportError(error) {
    const code = (error?.code || '').toString().trim().toUpperCase();
    const message = (error?.message || '').toString().trim().toLowerCase();
    return code === 'ECONNRESET'
        || code === 'ECONNABORTED'
        || code === 'EPIPE'
        || code === 'ETIMEDOUT'
        || message.includes('socket hang up')
        || message.includes('connection reset')
        || message.includes('aborted');
}

function describeCoreRequestError(error) {
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail || error?.response?.data?.error || error?.response?.statusText;
    if (status) {
        return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
    }

    if (error?.code) {
        return `${error.code}: ${error.message || 'request failed'}`;
    }

    return error?.message || String(error);
}

async function checkHealthEndpoint(label, url, headers = {}, timeoutMs = LILY_STATUS_CHECK_TIMEOUT_MS) {
    if (!url) {
        return { label, status: 'not configured', online: false, detail: '' };
    }

    try {
        const response = await axios.get(url, {
            headers,
            timeout: timeoutMs,
            validateStatus: () => true,
        });
        const payloadStatus = (response.data?.status || '').toString().toLowerCase();
        const ok = response.status >= 200 && response.status < 400
            && !['offline', 'error', 'failed', 'unavailable'].includes(payloadStatus);
        const rootNames = Array.isArray(response.data?.roots)
            ? response.data.roots
                .filter((root) => root?.exists !== false)
                .map((root) => root?.name)
                .filter(Boolean)
            : [];
        const detailParts = [
            response.data?.detail || response.data?.service || payloadStatus || `HTTP ${response.status}`,
            rootNames.length ? `roots: ${rootNames.join(', ')}` : '',
        ].filter(Boolean);
        const detail = detailParts.join(' | ');
        return { label, status: ok ? 'online' : 'offline', online: ok, detail };
    } catch (error) {
        return { label, status: 'offline', online: false, detail: describeCoreRequestError(error) };
    }
}

function formatWaStatusLine(item) {
    const marker = item.online ? '[ON]' : (item.status === 'not configured' ? '[--]' : '[OFF]');
    const detail = item.detail ? ` - ${item.detail}` : '';
    return `${marker} ${item.label}${detail}`;
}

function coreHealthUrl() {
    return LILY_CORE_URL ? `${LILY_CORE_URL.replace(/\/+$/, '')}/health/live` : '';
}

async function buildWaStatusReply(target = 'all', replyLanguage = 'id') {
    const checks = [];
    const includeNonFile = target !== 'file' && target !== 'finance';
    const includeFile = target === 'all' || target === 'file';

    if (includeNonFile) {
        checks.push(Promise.resolve({ label: 'WA Bridge', status: 'online', online: true, detail: 'running' }));
        checks.push(checkHealthEndpoint('Core', coreHealthUrl()));
        checks.push(checkHealthEndpoint('Tool Vessel', LILY_TOOL_HEALTH_URL));
        checks.push(checkHealthEndpoint('Voice Vessel', LILY_VOICE_HEALTH_URL,
            LILY_VOICE_HEALTH_TOKEN ? { 'X-Lily-Token': LILY_VOICE_HEALTH_TOKEN } : {}, 4000));
        checks.push(checkHealthEndpoint('STT Vessel', LILY_STT_HEALTH_URL || rootHealthUrlFromUrl(LILY_STT_TRANSCRIBE_URL)));
    }

    if (target === 'all' || target === 'finance') {
        checks.push(checkHealthEndpoint('Finance Vessel', financeUrl('/health'), buildFinanceHeaders()));
    }

    if (includeFile) {
        for (const vessel of FILE_VESSEL_REGISTRY) {
            checks.push(checkHealthEndpoint(`File ${vessel.label}`, fileVesselUrl(vessel, '/health'), buildFileVesselHeaders(vessel)));
        }
    }

    const results = await Promise.all(checks);
    const header = normalizeReplyLanguage(replyLanguage) === 'en' ? 'Lily status:' : 'Status Lily:';
    const lines = [header, ...results.map(formatWaStatusLine)];
    if (includeFile) {
        const defaultFileSource = getDefaultFileVessel()?.label || 'not configured';
        lines.push(`Default file source: ${defaultFileSource}`);
    }
    return lines.join('\n');
}

function buildWaHelpReply(replyLanguage = 'id') {
    if (normalizeReplyLanguage(replyLanguage) === 'en') {
        return [
            'Lily WA commands:',
            '- /help - show this command list',
            '- /why - inspect the previous intent route',
            '- /retry - answer the previous chat again',
            '- /recap - summarize recent conversation',
            '- /context - inspect shared WhatsApp context',
            '- /forgetlast - remove only the latest turn',
            '- /pinmemory <text> - keep owner-approved context',
            '- /unpinmemory <number> - remove pinned context',
            '- /resetlily - clear WhatsApp conversation context',
            '- /quiet 2h - pause proactive messages',
            '- /resume - resume proactive messages',
            '- /cancel - cancel pending WA actions',
            '- /keluarga - show paired family phone status',
            '- /sms <device> - show SMS count and private viewer location, never message text',
            '- /lokasi <device> [live|hemat] - show last point or request a location mode',
            '- /short, /normal, or /detail - set reply length',
            '- /serious - temporarily calm Lily down',
            '- lily status - service health',
            '- lily presence - your availability',
            '- lily file status',
            '- lily list downloads laptop',
            '- lily list pictures pc',
            '- lily send wallpaper file from pc',
            '- lily I spent 30k on fuel',
            '- lily finance balance',
            '- send a receipt image, then reply yes/save or cancel',
            '- reply 1/yes/send to send a pending file, or cancel',
        ].join('\n');
    }

    return [
        'Command Lily WA:',
        '- /help - lihat daftar command',
        '- /why - cek alasan route pesan sebelumnya',
        '- /retry - jawab ulang chat sebelumnya',
        '- /recap - ringkas obrolan terbaru',
        '- /context - lihat konteks WA yang dipakai Lily',
        '- /forgetlast - hapus satu turn terakhir',
        '- /pinmemory <teks> - simpan konteks penting',
        '- /unpinmemory <nomor> - lepas konteks yang dipin',
        '- /resetlily - hapus konteks obrolan WA',
        '- /quiet 2h - hentikan chat proaktif sementara',
        '- /resume - aktifkan proaktif lagi',
        '- /cancel - batalkan aksi WA yang pending',
        '- /keluarga - lihat status HP keluarga yang dipasangkan',
        '- /sms <perangkat> - lihat ringkasan dan panel privat, isi SMS tidak dikirim di WA',
        '- /lokasi <perangkat> [live|hemat] - lihat posisi terakhir atau minta mode lokasi',
        '- /short, /normal, atau /detail - atur panjang balasan',
        '- /serious - tenangkan gaya Lily sementara',
        '- lily status - cek layanan',
        '- lily presence - cek status kesibukanmu',
        '- lily file status',
        '- lily list downloads laptop',
        '- lily list pictures pc',
        '- lily kirim file luluka dari pc',
        '- lily gw isi bensin 30k',
        '- lily cek saldo finance',
        '- kirim gambar struk, lalu balas gas/simpan atau batal',
        '- balas 1/gas/iya buat kirim file pending, atau batal',
    ].join('\n');
}

async function requestCore(method, url, body = null, timeout = 10000, allowRetry = true) {
    const run = () => {
        if (method === 'get') {
            return axios.get(url, buildCoreRequestConfig(timeout));
        }

        return axios.post(url, body, buildCoreRequestConfig(timeout, {
            headers: { 'Content-Type': 'application/json' },
        }));
    };

    try {
        return await run();
    } catch (error) {
        if (!allowRetry || !isTransientCoreTransportError(error)) {
            throw error;
        }

        coreStatusCache.checkedAt = 0;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return run();
    }
}

async function isCoreAvailable(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now - coreStatusCache.checkedAt < CORE_STATUS_CACHE_MS) {
        return coreStatusCache.isAvailable;
    }

    try {
        await requestCore('get', `${LILY_CORE_URL}/health/live`, null, 2000, false);
        coreStatusCache.checkedAt = now;
        coreStatusCache.isAvailable = true;
        return true;
    } catch (error) {
        coreStatusCache.checkedAt = now;
        coreStatusCache.isAvailable = false;
        return false;
    }
}

function canUseModelRateLimit(bucketName) {
    const bucket = modelRateLimits[bucketName];
    if (!bucket) return true;

    const now = Date.now();
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < 60 * 1000);

    if (bucket.timestamps.length >= bucket.rpm) {
        return false;
    }

    bucket.timestamps.push(now);
    return true;
}

async function generateGeminiText(modelName, prompt, bucketName) {
    if (!genAI) {
        throw new Error('Gemini API key is not configured');
    }

    if (!canUseModelRateLimit(bucketName)) {
        throw new Error(`Rate limit reached for ${bucketName}`);
    }

    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    return result.response.text();
}

function buildWhatsAppUserId(chatId, isOwner = false) {
    if (isOwner) return 'wa_owner';
    const rawId = (chatId || '').split('@')[0].trim();
    const prefix = IS_PUBLIC_PROFILE ? 'wa_public' : 'wa';
    return rawId ? `${prefix}_${rawId}` : `${prefix}_unknown`;
}

function normalizeReplyLanguage(value) {
    const language = (value || '').toString().trim().toLowerCase();
    return language === 'en' || language === 'english' ? 'en' : 'id';
}

function detectReplyLanguage(message) {
    const lower = (message || '').toString().toLowerCase().replace(/[^\p{L}\p{N}\s'?]/gu, ' ');
    const normalized = lower.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'id';

    if (/^(p|ping|halo|hai|mas|bang|kak|mbak|mba)$/i.test(normalized)) {
        return 'id';
    }

    const indonesianPatterns = [
        /\b(aku|gw|gue|gua|saya|kamu|lu|lo|nih|dong|tolong|nyala|apa|gimana|kalo|kalau|bisa|buat|dah|udah|belum|lagi|lihat|liat|coba|sekarang|nanti|kok|jir|anjay)\b/g,
        /\b(gak|ga|nggak|kgk|ngga|enggak)\b/g,
        /\b(mending|boleh|langsung|sekalian|benerin|jalanin|kasih|pake|dipake|kenapa|cek|cari)\b/g,
    ];
    const englishPatterns = [
        /\b(hello|hi|please|can you|could you|would you|what|how|why|when|where|which|turn on|wake|computer|search|browse|voice|message)\b/g,
        /\b(help|check|show|make|create|fix|update|send|reply|explain|later|now)\b/g,
    ];

    const countMatches = (patterns) => patterns.reduce((total, pattern) => {
        const matches = normalized.match(pattern);
        return total + (matches ? matches.length : 0);
    }, 0);

    const idScore = countMatches(indonesianPatterns);
    const enScore = countMatches(englishPatterns);
    return enScore > idScore ? 'en' : 'id';
}

function getReplyLanguageLabel(replyLanguage) {
    return normalizeReplyLanguage(replyLanguage) === 'en' ? 'English' : 'Indonesian';
}

function getReplyLanguagePromptHint(replyLanguage) {
    return normalizeReplyLanguage(replyLanguage) === 'en'
        ? 'Match the incoming WhatsApp message language. Reply in natural English.'
        : 'Match the incoming WhatsApp message language. Reply in natural Indonesian.';
}

function getCoreLanguageContext(replyLanguage) {
    const language = normalizeReplyLanguage(replyLanguage);
    return {
        language_label: getReplyLanguageLabel(language),
        language_prompt_hint: getReplyLanguagePromptHint(language),
        voice_language: language,
        owner_presence: getActiveOwnerPresence(),
    };
}

function getLocalizedBridgeText(key, replyLanguage, values = {}) {
    const language = normalizeReplyLanguage(replyLanguage);
    const ownerName = values.ownerName || process.env.OWNER_NAME || 'sayang';
    const id = values.id || '';
    const status = values.status || '';
    const detail = values.detail || '';

    const texts = {
        coreUnavailable: {
            id: 'Neural Core lagi belum nyambung, sayang. Chat biasa masih bisa, tapi voice, browsing, sama command khusus coba lagi nanti ya.',
            en: 'Neural Core is not connected right now, love. Normal chat still works, but voice, browsing, and special commands need another try later.',
        },
        ownerRateLimit: {
            id: 'Lily lagi kena limit sebentar, sayang. Coba lagi bentar ya.',
            en: 'Lily is rate-limited for a moment, love. Try again in a bit.',
        },
        secretaryRateLimit: {
            id: 'Lily lagi kena limit balasan sebentar. Tolong kirim lagi nanti ya.',
            en: 'Lily is reply-limited for a moment. Please send it again shortly.',
        },
        ownerVoiceIntroduced: {
            id: 'Suara Lily lagi belum aktif, sayang. Kirim teks aja dulu ya, Lily tetap di sini.',
            en: "Lily's voice is not active right now, love. Send text for now, Lily is still here.",
        },
        ownerVoiceNew: {
            id: 'Lily di sini, sayang. Suara Lily lagi belum aktif, jadi kirim teks aja dulu ya.',
            en: "Lily is here, love. Her voice is not active right now, so send text for now.",
        },
        secretaryVoiceIntroduced: {
            id: 'Maaf, suara Lily belum aktif sekarang. Kalau ada pesan, kirim teks saja ya, nanti Lily bantu teruskan.',
            en: "Sorry, Lily's voice is not active right now. If there is a message, please send text and Lily will help forward it.",
        },
        secretaryVoiceNew: {
            id: 'Lily di sini. Suara Lily belum aktif sekarang, jadi kirim teks saja ya.',
            en: "Lily is here. Her voice is not active right now, so please send text.",
        },
        ownerTextOffline: {
            id: `Maaf, ${ownerName}, Lily belum bisa memproses chat ini. Layanan chat cadangan belum dikonfigurasi.`,
            en: `Sorry, ${ownerName}, Lily couldn't process this chat. The backup chat service is not configured.`,
        },
        wakeFallback: {
            id: 'Udah Lily nyalain, sayang. Tunggu bentar ya, PC-nya lagi bangun.',
            en: 'Lily turned it on, love. Wait a moment while the PC wakes up.',
        },
        whitelistBlocked: {
            id: 'Yang itu belum Lily izinin dari bridge ini, sayang.',
            en: "Lily has not allowed that command from this bridge yet.",
        },
        ownerCannotAnswer: {
            id: 'Lily lagi belum bisa jawab, sayang. Coba lagi bentar ya.',
            en: 'Lily cannot answer right now, love. Try again in a bit.',
        },
        conversationResetDone: {
            id: 'Udah, konteks obrolan WA kita Lily bersihin. Memory penting tetap aman; mulai pesan berikutnya kita mulai baru ya, sayang.',
            en: 'Done. Lily cleared our WhatsApp conversation context. Important memory is still safe; the next message starts fresh, love.',
        },
        conversationResetFailed: {
            id: 'Reset obrolannya belum berhasil, sayang. Core lagi belum bisa beresin konteksnya, jadi jangan Lily bohong bilang sudah.',
            en: "The conversation reset did not work yet, love. Core could not clear the context, so Lily will not pretend it is done.",
        },
        pdfStoredWaitingInstruction: {
            id: 'PDF-nya udah Lily pegang, sayang. Tinggal bilang mau diapain dalam beberapa menit ini ya.',
            en: 'Lily has the PDF now. Just tell her what to do with it in the next few minutes.',
        },
        pdfUnsupported: {
            id: 'Untuk sekarang Lily baru bisa terima PDF dari WhatsApp ya, sayang.',
            en: 'For now Lily can only take PDF files from WhatsApp here.',
        },
        pdfTooLarge: {
            id: `PDF-nya kegedean, sayang. Batas amannya sekitar ${detail || '20 MB'}.`,
            en: `That PDF is too large right now. The safe limit is about ${detail || '20 MB'}.`,
        },
        pdfReadFailed: {
            id: 'PDF-nya belum kebaca rapi, sayang. Coba kirim ulang sekali lagi ya.',
            en: 'Lily could not read that PDF cleanly yet. Please send it again once more.',
        },
        fileVesselUnavailable: {
            id: 'File Vessel Windows belum kebaca dari WA, sayang. Cek `lily file status` dulu ya.',
            en: 'The Windows File Vessel is not reachable from WhatsApp right now. Check `lily file status` first.',
        },
        fileVesselQueryUnclear: {
            id: 'Nama file atau gambarnya belum jelas. Contoh: Lily kirimin gambar wallpaper dari Downloads.',
            en: 'The file or image name is not clear yet. Example: Lily send wallpaper image from Downloads.',
        },
        fileVesselNoRecentSearch: {
            id: 'Lily belum punya pencarian file yang bisa dicek ulang. Sebutin nama filenya lagi ya.',
            en: 'Lily does not have a recent file search to check again. Tell her the file name again.',
        },
        fileVesselNotFound: {
            id: `Lily belum nemu file yang cocok: ${detail || 'itu'}.`,
            en: `Lily could not find a matching file: ${detail || 'that one'}.`,
        },
        fileVesselConfirmSingle: {
            id: `Lily nemu ini:\n${detail || 'file'}\nKirim? Balas gas/kirim/iya, atau batal.`,
            en: `Lily found this:\n${detail || 'file'}\nSend it? Reply yes/send, or cancel.`,
        },
        fileVesselMultiple: {
            id: `Lily nemu beberapa file:\n${detail || ''}\nBalas nomor buat kirim, atau batal.`.trim(),
            en: `Lily found several files:\n${detail || ''}\nReply with a number to send it, or cancel.`.trim(),
        },
        fileVesselChoiceUnclear: {
            id: 'Pilihan filenya belum kebaca. Balas nomor kandidat, gas/kirim kalau cuma satu, atau batal.',
            en: 'Lily could not read the file choice. Reply with a candidate number, send/yes if there is only one, or cancel.',
        },
        fileVesselPendingExpired: {
            id: 'Pilihan file tadi udah kedaluwarsa, sayang. Minta Lily cari lagi ya.',
            en: 'That file choice has expired. Ask Lily to search again.',
        },
        fileVesselCancelled: {
            id: 'Oke, Lily batalin kirim file tadi.',
            en: 'Okay, Lily cancelled that file send.',
        },
        fileVesselTooLarge: {
            id: `File-nya kegedean buat WhatsApp sekarang, sayang. Ukuran: ${detail || 'unknown'}.`,
            en: `That file is too large for WhatsApp right now. Size: ${detail || 'unknown'}.`,
        },
        fileVesselSending: {
            id: `Ini filenya: ${detail || 'file'}`,
            en: `Here is the file: ${detail || 'file'}`,
        },
        fileVesselSendFailed: {
            id: `Lily nemu ${detail || 'file-nya'}, tapi gagal ngirim attachment-nya.`,
            en: `Lily found ${detail || 'the file'}, but could not send the attachment.`,
        },
        financeUnavailable: {
            id: 'Finance Vessel belum nyambung, sayang. Cek `lily finance status` atau URL Finance di env WA dulu ya.',
            en: 'Finance Vessel is not reachable right now. Check `lily finance status` or the WA finance URL env first.',
        },
        financeParseFailed: {
            id: `Lily belum bisa baca transaksi itu. Detail: ${detail || 'amount_not_found'}.`,
            en: `Lily could not read that transaction yet. Detail: ${detail || 'amount_not_found'}.`,
        },
        financeDraftReady: {
            id: `Lily bikin draft transaksi:\n${detail || ''}\n\nSimpan? Balas gas/simpan/iya, atau batal.`.trim(),
            en: `Lily made a transaction draft:\n${detail || ''}\n\nSave it? Reply yes/save, or cancel.`.trim(),
        },
        financeCategoryUpdated: {
            id: `Oke, kategori draft aku ubah dan polanya aku simpan:\n${detail || ''}\n\nSimpan? Balas gas/simpan/iya, atau batal.`.trim(),
            en: `Okay, I updated the draft category and saved the pattern:\n${detail || ''}\n\nSave it? Reply yes/save, or cancel.`.trim(),
        },
        financeCategoryUpdatedNoRule: {
            id: `Oke, kategori draft aku ubah:\n${detail || ''}\n\nRule belajarnya belum kesimpan, tapi draft ini bisa disimpan. Balas gas/simpan/iya, atau batal.`.trim(),
            en: `Okay, I updated the draft category:\n${detail || ''}\n\nThe learning rule was not saved, but this draft can still be saved. Reply yes/save, or cancel.`.trim(),
        },
        financeCategoryUnclear: {
            id: 'Kategori barunya belum kebaca. Contoh: `kategori food` atau `category internet`.',
            en: 'I could not read the new category. Example: `category food`.',
        },
        financeAdminFeeAdded: {
            id: `Oke, biaya admin aku tambahkan ke draft:\n${detail || ''}\n\nSimpan? Balas gas/simpan/iya, atau batal.`.trim(),
            en: `Okay, I added the admin fee to the draft:\n${detail || ''}\n\nSave it? Reply yes/save, or cancel.`.trim(),
        },
        financeAdminFeeUnclear: {
            id: 'Nominal adminnya belum kebaca. Contoh: `admin 2500` atau `fee 2.5k`.',
            en: 'I could not read the admin fee amount. Example: `admin 2500` or `fee 2.5k`.',
        },
        financeDraftRevised: {
            id: `Oke, draftnya Lily sesuaikan:\n${detail || ''}\n\nSimpan? Balas gas/simpan/iya, atau batal.`.trim(),
            en: `Okay, Lily updated the draft:\n${detail || ''}\n\nSave it? Reply yes/save, or cancel.`.trim(),
        },
        financeDraftRevisionUnclear: {
            id: 'Bagian draft yang mau diubah belum kebaca. Sebutkan bagian dan nilai barunya ya.',
            en: 'The draft change is unclear. Say which field and value should change.',
        },
        financePendingExpired: {
            id: 'Draft transaksi tadi udah kedaluwarsa, sayang. Kirim ulang catatannya ya.',
            en: 'That transaction draft expired. Send the finance note again.',
        },
        financeCancelled: {
            id: 'Oke, Lily batalin draft transaksi tadi.',
            en: 'Okay, Lily cancelled that transaction draft.',
        },
        financeSaved: {
            id: `Beres, Lily sudah catat:\n${detail || 'transaction saved'}`,
            en: `Done, Lily saved:\n${detail || 'transaction saved'}`,
        },
        financeSaveFailed: {
            id: `Draft-nya belum bisa disimpan. Detail: ${detail || 'unknown'}.`,
            en: `The draft could not be saved. Detail: ${detail || 'unknown'}.`,
        },
        financeSummary: {
            id: `Ringkasan Finance:\n${detail || ''}`.trim(),
            en: `Finance summary:\n${detail || ''}`.trim(),
        },
        financeDetail: {
            id: `${detail || 'Belum ada detail finance.'}`.trim(),
            en: `${detail || 'No finance detail yet.'}`.trim(),
        },
        financeContextExpired: {
            id: 'Konteks ringkasan finance tadi sudah hilang. Coba tanya ulang saldo atau ringkasannya ya.',
            en: 'That finance summary context has expired. Ask for the balance or summary again.',
        },
        financeImageUnsupported: {
            id: 'Untuk struk, Lily baru bisa baca gambar JPG, PNG, atau WebP ya.',
            en: 'For receipts, Lily can read JPG, PNG, or WebP images for now.',
        },
        financeImageTooLarge: {
            id: `Gambar struknya kegedean, sayang. Batas amannya sekitar ${detail || '5 MB'}.`,
            en: `That receipt image is too large. The safe limit is about ${detail || '5 MB'}.`,
        },
        financeImageReadFailed: {
            id: 'Gambar struknya belum kebaca rapi. Coba kirim ulang sekali lagi ya.',
            en: 'Lily could not read that receipt image cleanly. Please send it again once.',
        },
        financeImageServiceBusy: {
            id: 'Pembaca struknya lagi sibuk dari Gemini. Ketik manual singkat dulu ya, contoh: `bca 45k by.u internet` atau `cash 18k indomaret food`.',
            en: 'The receipt reader is temporarily busy on Gemini. Enter it manually for now, for example: `bca 45k by.u internet` or `cash 18k indomaret food`.',
        },
        financeImageParseFailed: {
            id: `Lily belum nemu transaksi yang jelas dari gambar itu. Detail: ${detail || 'image_not_finance'}.`,
            en: `Lily could not find a clear transaction in that image. Detail: ${detail || 'image_not_finance'}.`,
        },
        wakeFailed: {
            id: `Lily belum bisa nyalain PC dari sini, sayang. ${detail || 'Wake request gagal.'}`,
            en: `Lily could not wake the PC from here, love. ${detail || 'Wake request failed.'}`,
        },
        unclearToolId: {
            id: 'ID task-nya belum kebaca jelas.',
            en: 'I could not read the tool task ID clearly.',
        },
        approveDone: {
            id: `Beres, sayang. Lily udah izinin ${id}. Status: ${status}.`,
            en: `Done, love. Lily approved ${id}. Status: ${status}.`,
        },
        approveFailed: {
            id: `Belum bisa izinin ${id} sekarang, sayang. Core atau tool route belum nyambung.`,
            en: `Lily cannot approve ${id} right now, love. The core or tool route is not responding.`,
        },
        openclawAcceptedEmpty: {
            id: 'Request tool-nya udah masuk, sayang, tapi ringkasannya belum kebaca.',
            en: 'The tool request went through, love, but Lily has not received the summary yet.',
        },
        denyDone: {
            id: `Oke, sayang. Lily batalin ${id}. Status: ${status}.`,
            en: `Okay, love. Lily denied ${id}. Status: ${status}.`,
        },
        denyFailed: {
            id: `Belum bisa batalin ${id} sekarang, sayang. Core atau tool route belum nyambung.`,
            en: `Lily cannot deny ${id} right now, love. The core or tool route is not responding.`,
        },
        presenceSet: {
            id: `Oke, Lily inget kamu lagi ${status || 'sibuk'}, sayang.`,
            en: `Okay, Lily will keep in mind that you are ${status || 'busy'}.`,
        },
        presenceAvailable: {
            id: 'Oke, sayang. Lily balik anggap kamu available lagi.',
            en: 'Okay, Lily will treat you as available again.',
        },
        presenceUnclear: {
            id: 'Statusnya belum kebaca, sayang. Coba: Lily status kantor, tidur, gaming, busy, away, atau available.',
            en: 'I could not read that status yet. Try: Lily status office, sleeping, gaming, busy, away, or available.',
        },
        tagNumberUnclear: {
            id: 'Nomor yang mau ditandai belum jelas. Sertakan nomor HP-nya juga ya.',
            en: 'The number to tag was not clear. Please include the phone number too.',
        },
        noteUnclear: {
            id: 'Catatannya belum jelas. Kirim ulang ya.',
            en: 'The note was not clear yet. Please send it again.',
        },
        noteSaved: {
            id: `Beres, Lily sudah simpan catatan ini: ${detail}`,
            en: `Done, Lily saved this note: ${detail}`,
        },
        preferredNameUnclear: {
            id: 'Nama panggilannya belum jelas. Kirim ulang ya.',
            en: 'The preferred name was not clear yet. Please send it again.',
        },
        preferredNameSaved: {
            id: `Oke, Lily bakal ingat buat manggil kamu ${detail}.`,
            en: `Okay, Lily will remember to call you ${detail}.`,
        },
        nicknameUnclear: {
            id: 'Nickname-nya belum jelas. Kirim ulang ya.',
            en: 'The nickname was not clear yet. Please send it again.',
        },
        nicknameSaved: {
            id: `Beres, Lily sudah simpan nickname kamu sebagai ${detail}.`,
            en: `Done, Lily saved your nickname as ${detail}.`,
        },
        contactTagFailed: {
            id: 'Lily belum bisa menandai nomor itu.',
            en: 'Lily could not tag that number yet.',
        },
        contactTagged: {
            id: `Oke, Lily sudah tandai ${id} sebagai ${detail}.`,
            en: `Okay, Lily marked ${id} as ${detail}.`,
        },
    };

    return texts[key]?.[language] || texts[key]?.id || '';
}

function isOpenClawRequestMessage(message) {
    const text = (message || '').trim();
    const lower = text.toLowerCase();
    const triggers = [
        'openclaw',
        'search',
        'browse',
        'cari di web',
        'cek web',
        'lihat website',
        'buka website',
        'berita terbaru',
        'latest news',
        'search this',
        'check the web',
    ];
    const casualTaskPatterns = [
        /\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin|pindah(?:in)?|mindahin|move)\b.*\b(?:file|gambar|image|foto|photo|wallpaper|download|folder)\b/i,
        /\b(?:file|gambar|image|foto|photo|wallpaper)\b.*\b(?:kirim(?:in)?|send|copy|salin|pindah(?:in)?|mindahin|move)\b/i,
        /\b(?:bikinin|buat(?:kan)?|bikin(?:in)?)\s+file\b/i,
        /\b(?:edit|ubah|benerin)\s+file\b/i,
        /\b(?:edit|ubah|rapiin|hapus|buang|tambah(?:in)?|kasih)\b.*\bpdf\b/i,
        /\b(?:hapus|buang|remove)\s+halaman\b/i,
        /\b(?:merge|gabung(?:in)?|split|pisah(?:kan)?)\b.*\bpdf\b/i,
        /\b(?:jadiin|bikin(?:in)?|buat(?:kan)?|export)\s+(?:ke\s+)?pdf\b/i,
        /\bcreate\s+(?:a\s+)?file\b/i,
        /\bedit\s+(?:a\s+)?file\b/i,
        /\bedit\s+(?:this\s+)?pdf\b/i,
        /\bremove\s+(?:the\s+)?last\s+page\b/i,
        /\bmake\s+(?:a\s+)?pdf\b/i,
        /\bsearch\s+this\b/i,
        /\bcheck\s+the\s+web\b/i,
        /\b(?:cariin|cek\s+web)\b/i,
        /\blihatin\b.*\b(?:web|website|link|artikel|info)\b/i,
    ];

    return triggers.some((trigger) => lower.includes(trigger))
        || casualTaskPatterns.some((pattern) => pattern.test(text));
}

function truncateOpenClawResult(value) {
    const text = (value || '').trim();
    if (text.length <= OPENCLAW_RESULT_MAX_CHARS) {
        return text;
    }

    return `${text.slice(0, OPENCLAW_RESULT_MAX_CHARS - 32).trim()}\n\n[result truncated]`;
}

function sanitizeOpenClawPath(rawPath) {
    const normalized = (rawPath || '').replace(/\\/g, '/').trim();
    if (!normalized) {
        return '';
    }

    if (normalized.startsWith('/api/') || normalized.startsWith('/static/')) {
        return rawPath;
    }

    const leaf = normalized.split('/').filter(Boolean).pop() || '';
    return leaf && leaf.includes('.') ? leaf : '[local path hidden]';
}

function escapeOpenClawRegex(value) {
    return (value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeOpenClawResult(value, artifacts = []) {
    let text = (value || '').trim();
    if (!text) {
        return text;
    }

    const artifactNames = new Set(
        (Array.isArray(artifacts) ? artifacts : [])
            .map((artifact) => (artifact?.name || '').trim())
            .filter(Boolean),
    );

    text = text.replace(OPENCLAW_WINDOWS_PATH_RE, (match, prefix, rawPath) => {
        return `${prefix}${sanitizeOpenClawPath(rawPath)}`;
    });
    text = text.replace(OPENCLAW_UNIX_PATH_RE, (match, prefix, rawPath) => {
        return `${prefix}${sanitizeOpenClawPath(rawPath)}`;
    });

    for (const artifactName of artifactNames) {
        const relativePattern = new RegExp(
            `(^|[^A-Za-z0-9_.-])((?:[A-Za-z0-9_. -]+[\\\\/])+${escapeOpenClawRegex(artifactName)})`,
            'gm',
        );
        text = text.replace(relativePattern, (match, prefix) => `${prefix}${artifactName}`);
    }

    text = text.replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1');
    text = text.replace(/`([^`\n]+)`/g, '$1');
    text = text.replace(/\bready for whatsapp relay\b[:.]?/gi, 'ready.');
    text = text.replace(/\bready for delivery to owner\b[:.]?/gi, 'ready.');
    text = text.replace(/\brelay to owner\b[:.]?\s*/gi, '');
    text = text.replace(/\bapproval test passed\b[:.]?\s*/gi, '');
    text = text.replace(/\bwrite approval verified\b[:.]?\s*/gi, '');
    text = text.replace(/\bready for your next command\b(?:,\s*(?:owner~?|sayang|dear|sweetheart|honey))?[.!~]*/gi, '');
    text = text.replace(/(?:,\s*)?owner~\b/gi, '');
    text = text.replace(/(?:,\s*)?(?:sayang|dear|sweetheart|honey)\b(?=[.!~]*$)/gi, '');
    text = text.replace(/\s+[—-]\s+ready\./g, '.');

    if (!artifactNames.size) {
        return text.replace(/\n{3,}/g, '\n\n').trim();
    }

    const lines = text.split(/\r?\n/);
    const cleaned = [];
    for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index]
            .replace(/\bRelay this to the owner:?\b/gi, '')
            .replace(/\bat the artifact path\b/gi, '')
            .trimEnd();
        line = line.replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trimEnd();
        const trimmed = line.trim();
        const nextTrimmed = index + 1 < lines.length ? lines[index + 1].trim() : '';
        if (
            trimmed.toLowerCase() === 'at:' &&
            artifactNames.has(nextTrimmed)
        ) {
            cleaned.push(`File: ${nextTrimmed}`);
            index += 1;
            continue;
        }
        const locationMatch = trimmed.match(/^location:\s*(.+)$/i);
        if (locationMatch && artifactNames.has(locationMatch[1].trim())) {
            continue;
        }
        const fileCreatedMatch = trimmed.match(/^file created:\s*(.+)$/i);
        if (fileCreatedMatch && artifactNames.has(fileCreatedMatch[1].trim())) {
            cleaned.push(`File: ${fileCreatedMatch[1].trim()}`);
            continue;
        }
        if (!trimmed) {
            if (cleaned.length && cleaned[cleaned.length - 1] !== '') {
                cleaned.push('');
            }
            continue;
        }
        cleaned.push(line);
    }

    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatOpenClawDelivery(task) {
    const status = (task?.status || '').toLowerCase();
    const action = task?.action || 'task';
    const id = task?.id || 'unknown';
    const content = truncateOpenClawResult(
        sanitizeOpenClawResult(
            task?.result_text || task?.error || 'The tool task finished without a text update.',
            task?.artifacts || [],
        ),
    );

    if (status === 'completed') {
        return `Done, Lily finished this tool task.\nID: ${id}\nAction: ${action}\n\n${content}`;
    }

    if (status === 'denied') {
        return `Okay, Lily stopped this tool task.\nID: ${id}\nAction: ${action}\n\n${content}`;
    }

    return `This tool task did not finish cleanly.\nID: ${id}\nAction: ${action}\n\n${content}`;
}

function resolveOpenClawArtifactUrl(artifact) {
    const rawUrl = (artifact?.download_url || '').trim();
    if (!rawUrl) return '';
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
    return `${LILY_CORE_URL.replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`;
}

function isOpenClawImageArtifact(artifact) {
    const kind = (artifact?.kind || '').toLowerCase();
    const mimeType = (artifact?.mime_type || '').toLowerCase();
    return kind === 'image' || mimeType.startsWith('image/');
}

function validateOpenClawArtifactPayload(artifact, buffer, responseContentType = '') {
    const name = sanitizeGenericFilename(artifact?.name || artifact?.id || 'artifact');
    const contentType = (responseContentType || '').toString().split(';')[0].trim().toLowerCase();
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error(`OpenClaw artifact ${name} downloaded as an empty file.`);
    }
    if (buffer.length > WA_ATTACHMENT_MAX_BYTES) {
        throw new Error(`OpenClaw artifact ${name} exceeds the WhatsApp attachment limit.`);
    }
    if (contentType === 'application/json' || contentType === 'text/html') {
        throw new Error(`OpenClaw artifact ${name} returned ${contentType} instead of file data.`);
    }

    const expectedSize = Number(artifact?.size_bytes || 0);
    if (expectedSize > 0 && buffer.length !== expectedSize) {
        throw new Error(`OpenClaw artifact ${name} size mismatch (${buffer.length} B, expected ${expectedSize} B).`);
    }

    const expectedSha256 = (artifact?.sha256 || '').toString().trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(expectedSha256) && hashBufferSha256(buffer) !== expectedSha256) {
        throw new Error(`OpenClaw artifact ${name} checksum mismatch.`);
    }

    const extension = path.extname(name).toLowerCase();
    const startsWith = (...bytes) => bytes.every((value, index) => buffer[index] === value);
    const isZip = startsWith(0x50, 0x4b, 0x03, 0x04)
        || startsWith(0x50, 0x4b, 0x05, 0x06)
        || startsWith(0x50, 0x4b, 0x07, 0x08);
    const signatureValid = extension === '.docx' || extension === '.zip'
        ? isZip
        : extension === '.pdf'
            ? buffer.subarray(0, 5).toString('ascii') === '%PDF-'
            : extension === '.png'
                ? startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
                : extension === '.jpg' || extension === '.jpeg'
                    ? startsWith(0xff, 0xd8, 0xff)
                    : extension === '.gif'
                        ? buffer.subarray(0, 4).toString('ascii') === 'GIF8'
                        : extension === '.webp'
                            ? buffer.subarray(0, 4).toString('ascii') === 'RIFF'
                                && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
                            : true;
    if (!signatureValid) {
        throw new Error(`OpenClaw artifact ${name} does not match its ${extension || 'declared'} file type.`);
    }
}

async function sendOpenClawArtifact(chatId, taskId, artifact) {
    const url = resolveOpenClawArtifactUrl(artifact);
    const name = sanitizeGenericFilename(artifact?.name || artifact?.id || 'artifact');
    if (!url) {
        throw new Error(`OpenClaw artifact ${name} has no download URL.`);
    }

    const artifactOrigin = new URL(url).origin;
    const coreOrigin = new URL(LILY_CORE_URL).origin;
    if (artifactOrigin !== coreOrigin) {
        throw new Error(`OpenClaw artifact ${name} points outside the configured Core.`);
    }

    const response = await axios.get(url, buildCoreRequestConfig(60000, {
        responseType: 'arraybuffer',
        maxContentLength: WA_ATTACHMENT_MAX_BYTES,
        maxBodyLength: WA_ATTACHMENT_MAX_BYTES,
    }));
    const buffer = Buffer.from(response.data || []);
    const responseContentType = response.headers?.['content-type'] || '';
    validateOpenClawArtifactPayload(artifact, buffer, responseContentType);

    const responseMimeType = responseContentType.toString().split(';')[0].trim().toLowerCase();
    const declaredMimeType = (artifact?.mime_type || '').toString().trim().toLowerCase();
    const mimeType = responseMimeType && responseMimeType !== 'application/octet-stream'
        ? responseMimeType
        : declaredMimeType || guessMimeTypeFromFilename(name);
    const { MessageMedia } = require('whatsapp-web.js');
    const media = new MessageMedia(mimeType, buffer.toString('base64'), name, buffer.length);
    const caption = `OpenClaw artifact\nID: ${taskId}\n${name}`;

    if (isOpenClawImageArtifact(artifact)) {
        await client.sendMessage(chatId, media, { caption });
        return;
    }

    await client.sendMessage(chatId, media, {
        caption,
        sendMediaAsDocument: true,
    });
}

async function deliverOpenClawResult(chatId, task) {
    const taskId = (task?.id || '').trim();
    const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    if (!openClawSummarySentTaskIds.has(taskId)) {
        await client.sendMessage(chatId, formatOpenClawDelivery(task));
        openClawSummarySentTaskIds.add(taskId);
    }

    const failures = [];
    for (const artifact of artifacts) {
        const name = artifact?.name || artifact?.id || 'artifact';
        try {
            await sendOpenClawArtifact(chatId, taskId, artifact);
        } catch (error) {
            console.error(`Failed to send OpenClaw artifact ${name}:`, error.message || error);
            failures.push({ name, error });
            if (!openClawFailureNotifiedTaskIds.has(taskId)) {
                const url = resolveOpenClawArtifactUrl(artifact);
                const downloadNote = url ? `\nDownload: ${url}` : '';
                await client.sendMessage(chatId, `OpenClaw finished, but Lily could not attach ${name}.${downloadNote}`);
                openClawFailureNotifiedTaskIds.add(taskId);
            }
        }
    }
    if (failures.length) {
        throw new Error(`OpenClaw artifact delivery failed for ${failures.map((item) => item.name).join(', ')}.`);
    }
}

async function redeliverOpenClawTask(taskId) {
    const cleanTaskId = (taskId || '').toString().trim();
    if (!cleanTaskId) {
        throw new Error('OpenClaw task ID is required.');
    }

    const response = await requestCore(
        'get',
        `${LILY_CORE_URL}/api/tools/openclaw/requests?limit=80`,
        null,
        10000,
    );
    const tasks = Array.isArray(response.data?.items) ? response.data.items : [];
    const task = tasks.find((item) => (item?.id || '').toString().trim() === cleanTaskId);
    if (!task) {
        throw new Error(`OpenClaw task ${cleanTaskId} was not found.`);
    }
    if (task.status !== 'completed') {
        throw new Error(`OpenClaw task ${cleanTaskId} is ${task.status || 'not completed'}.`);
    }

    const deliveryTarget = (task.delivery_target || OPENCLAW_OWNER_DELIVERY_TARGET).toString().trim();
    const chatId = await resolveOpenClawDeliveryChatId(deliveryTarget);
    if (!chatId) {
        throw new Error(`Could not resolve WhatsApp delivery target for ${cleanTaskId}.`);
    }
    await deliverOpenClawResult(chatId, task);
    return {
        taskId: cleanTaskId,
        artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
        targetScheme: chatId.split('@')[1] || '',
    };
}

async function resolveOpenClawDeliveryChatId(deliveryTarget = '') {
    const normalizedTarget = (deliveryTarget || '').toString().trim().toLowerCase();
    if (normalizedTarget === OPENCLAW_OWNER_DELIVERY_TARGET) {
        if (!IS_PERSONAL_PROFILE) return '';
        return resolveProactiveOwnerChatId();
    }
    return normalizeDirectChatId(normalizedTarget);
}

async function markOpenClawDeliverySent(taskId, deliveryTarget) {
    await requestCore('post', `${LILY_CORE_URL}/api/tools/openclaw/${encodeURIComponent(taskId)}/delivered`, {
        channel: 'wa',
        target: deliveryTarget,
        delivery_profile: WA_PROFILE,
        consumer: OPENCLAW_DELIVERY_CONSUMER,
    }, 10000);
}

async function pollOpenClawDeliveries() {
    if (isOpenClawDeliveryPollRunning || !client.info?.wid?._serialized) {
        return;
    }

    isOpenClawDeliveryPollRunning = true;

    try {
        if (!await isCoreAvailable()) {
            return;
        }

        const response = await requestCore('get', `${LILY_CORE_URL}/api/tools/openclaw/deliveries/wa?limit=6&delivery_profile=${encodeURIComponent(WA_PROFILE)}&consumer=${encodeURIComponent(OPENCLAW_DELIVERY_CONSUMER)}`, null, 10000);
        const items = Array.isArray(response.data?.items) ? response.data.items : [];

        for (const item of items) {
            const deliveryTarget = (item?.delivery_target || '').trim();
            const taskId = (item?.id || '').trim();
            if (!deliveryTarget || !taskId) continue;

            try {
                const chatId = await resolveOpenClawDeliveryChatId(deliveryTarget);
                if (!chatId) {
                    throw new Error(`Could not resolve WhatsApp delivery target: ${deliveryTarget}`);
                }
                await deliverOpenClawResult(chatId, item);
                await markOpenClawDeliverySent(taskId, deliveryTarget);
                openClawSummarySentTaskIds.delete(taskId);
                openClawFailureNotifiedTaskIds.delete(taskId);
            } catch (deliveryError) {
                console.error(`Failed to deliver OpenClaw result ${taskId} to ${deliveryTarget}:`, deliveryError);
                try {
                    await requestCore('post', `${LILY_CORE_URL}/api/tools/openclaw/${encodeURIComponent(taskId)}/delivery-release`, {
                        channel: 'wa',
                        target: deliveryTarget,
                        delivery_profile: WA_PROFILE,
                        consumer: OPENCLAW_DELIVERY_CONSUMER,
                    }, 5000);
                } catch (releaseError) {
                    console.warn(`Failed to release OpenClaw delivery lease ${taskId}:`, releaseError.message || releaseError);
                }
            }
        }
    } catch (error) {
        coreStatusCache.checkedAt = 0;
        console.error('OpenClaw delivery poll failed:', describeCoreRequestError(error));
    } finally {
        isOpenClawDeliveryPollRunning = false;
    }
}

function startOpenClawDeliveryPolling() {
    if (openClawDeliveryPoller) {
        return;
    }

    openClawDeliveryPoller = setInterval(() => {
        pollOpenClawDeliveries();
    }, Math.max(2000, OPENCLAW_DELIVERY_POLL_MS));

    pollOpenClawDeliveries();
}

function currentHourInTimezone(timezoneName) {
    try {
        const formatted = new Intl.DateTimeFormat('en-US', {
            timeZone: timezoneName || 'Asia/Jakarta',
            hour: '2-digit',
            hourCycle: 'h23',
        }).format(new Date());
        const hour = Number(formatted);
        return Number.isFinite(hour) ? hour : new Date().getHours();
    } catch (_) {
        return new Date().getHours();
    }
}

function isProactiveQuietHours() {
    const start = LILY_WA_PROACTIVE_QUIET_START_HOUR;
    const end = LILY_WA_PROACTIVE_QUIET_END_HOUR;
    if (start === end) return false;
    const hour = currentHourInTimezone(LILY_WA_PROACTIVE_TIMEZONE);
    return start < end
        ? hour >= start && hour < end
        : hour >= start || hour < end;
}

async function resolveProactiveOwnerChatId(preferredOwnerNumber = '') {
    ownerEngagement = loadOwnerEngagement();
    const configuredOwners = configuredNumberValues(process.env.OWNER_NUMBER)
        .map((value) => normalizeInternationalNumber(value))
        .filter(Boolean);
    const preferredNumber = normalizeInternationalNumber(preferredOwnerNumber);
    if (preferredNumber && !configuredOwners.includes(preferredNumber)) return '';

    const ownerNumber = preferredNumber
        || LILY_WA_PROACTIVE_OWNER_NUMBER
        || ownerEngagement.last_owner_number
        || configuredOwners[0]
        || '';
    if (!ownerNumber) return '';

    try {
        const mappings = await client.getContactLidAndPhone([`${ownerNumber}@c.us`]);
        const mappedChatId = normalizeDirectChatId(
            (Array.isArray(mappings) ? mappings : [])
                .flatMap((mapping) => [mapping?.pn, mapping?.lid])
                .find((identity) => /@(lid|c\.us)$/i.test((identity || '').toString()))
            || '',
        );
        if (mappedChatId) {
            rememberOwnerChatId(mappedChatId, ownerNumber);
            return mappedChatId;
        }
    } catch (error) {
        console.warn('[PROACTIVE] Could not map owner phone to LID:', error.message || error);
    }

    const savedChatId = normalizeDirectChatId(ownerEngagement.last_owner_chat_id);
    if (
        savedChatId
        && savedChatId.endsWith('@lid')
        && normalizeInternationalNumber(ownerEngagement.last_owner_number) === ownerNumber
    ) {
        return savedChatId;
    }

    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            const chatId = normalizeDirectChatId(chat?.id?._serialized || '');
            if (!chatId) continue;

            let contact = null;
            try {
                contact = await client.getContactById(chatId);
            } catch (_) {
                contact = null;
            }
            const additionalIdentities = await resolveLidPhoneIdentities(chatId);
            if (!matchesConfiguredNumber(chatId, ownerNumber, contact, additionalIdentities)) continue;

            ownerEngagement = {
                ...loadOwnerEngagement(),
                last_owner_chat_id: chatId,
                updated_at: new Date().toISOString(),
            };
            saveOwnerEngagement();
            return chatId;
        }
    } catch (error) {
        console.warn('[PROACTIVE] Could not resolve owner chat from recent chats:', error.message || error);
    }

    try {
        const numberId = await client.getNumberId(ownerNumber);
        const resolved = normalizeDirectChatId(numberId?._serialized || '');
        if (resolved) return resolved;
    } catch (error) {
        console.warn('[PROACTIVE] Could not resolve owner number ID:', error.message || error);
    }

    return `${ownerNumber}@c.us`;
}

async function getProactiveOwnerDiagnostics() {
    const ownerNumbers = configuredNumberValues(process.env.OWNER_NUMBER)
        .map((value) => normalizeInternationalNumber(value))
        .filter(Boolean);
    const requestedIds = ownerNumbers.map((number) => `${number}@c.us`);
    const mappings = await client.getContactLidAndPhone(requestedIds);
    const candidates = (Array.isArray(mappings) ? mappings : []).flatMap((mapping, index) => [
        {
            owner_last4: ownerNumbers[index]?.slice(-4) || '',
            kind: 'pn',
            id: normalizeDirectChatId(mapping?.pn || ''),
        },
        {
            owner_last4: ownerNumbers[index]?.slice(-4) || '',
            kind: 'lid',
            id: normalizeDirectChatId(mapping?.lid || ''),
        },
    ]).filter((item) => item.id);

    const browserState = await client.pupPage.evaluate((candidateIds) => {
        const collections = window.require('WAWebCollections');
        const factory = window.require('WAWebWidFactory');
        const chatCollection = collections.Chat;
        const loadedIds = (chatCollection.getModelsArray?.() || [])
            .map((chat) => chat?.id?._serialized || '')
            .filter(Boolean);
        return {
            candidates: candidateIds.map((id) => {
                let loaded = false;
                try {
                    loaded = Boolean(chatCollection.get(factory.createWid(id)));
                } catch (_) {
                    loaded = false;
                }
                return { id, loaded };
            }),
            loaded_direct_chats: loadedIds
                .filter((id) => /@(c\.us|lid)$/.test(id))
                .slice(-20),
        };
    }, candidates.map((item) => item.id));
    const loadedById = new Map(
        (browserState?.candidates || []).map((item) => [item.id, Boolean(item.loaded)]),
    );

    return {
        self_last4: normalizeInternationalNumber(client.info?.wid?.user || '').slice(-4) || null,
        web_version: await client.getWWebVersion(),
        owners: candidates.map((item) => ({
            owner_last4: item.owner_last4,
            kind: item.kind,
            id_suffix: item.id.split('@')[1] || '',
            id_last6: item.id.split('@')[0].slice(-6),
            loaded: loadedById.get(item.id) || false,
        })),
        loaded_direct_chats: (browserState?.loaded_direct_chats || []).map((id) => ({
            scheme: id.split('@')[1] || '',
            id_last6: id.split('@')[0].slice(-6),
        })),
    };
}

async function pollProactiveOwnerMessage() {
    if (
        !IS_PUBLIC_PROFILE
        || !LILY_WA_PROACTIVE_ENABLED
        || isProactiveOwnerPollRunning
        || !waClientReady
        || !LILY_CORE_URL
    ) {
        return;
    }

    ownerEngagement = loadOwnerEngagement();
    const lastActivityAt = Number(ownerEngagement.last_owner_activity_at || 0);
    const proactivePausedUntil = Number(ownerEngagement.proactive_paused_until || 0);
    if (proactivePausedUntil > Date.now()) {
        return;
    }
    if (!lastActivityAt || Date.now() - lastActivityAt < LILY_WA_PROACTIVE_MIN_IDLE_MS) {
        return;
    }
    if (isProactiveQuietHours()) {
        return;
    }

    const ownerChatId = await resolveProactiveOwnerChatId();
    if (!ownerChatId) {
        console.warn('[PROACTIVE] Owner chat is unavailable.');
        recordProactiveDelivery('target_unavailable', 'Owner chat could not be resolved.');
        return;
    }

    isProactiveOwnerPollRunning = true;
    try {
        const response = await requestCore('post', `${LILY_CORE_URL}/api/owner/mood/proactive/claim`, {
            profile: WA_PROFILE,
            min_idle_seconds: Math.round(LILY_WA_PROACTIVE_MIN_IDLE_MS / 1000),
            cooldown_seconds: Math.round(LILY_WA_PROACTIVE_COOLDOWN_MS / 1000),
            max_per_day: LILY_WA_PROACTIVE_MAX_PER_DAY,
            quiet_hours_active: false,
        }, 45000);
        if (!response.data?.due || !response.data?.text) {
            return;
        }

        const sentMessage = await sendHumanizedText(ownerChatId, response.data.text, {
            allowSplit: false,
            operational: false,
            rememberOwnerChatId: true,
            allowLoadedReplyFallback: true,
            waitUntilMsgSent: true,
        });
        recordProactiveDelivery('sent', '', sentMessage);
        console.log(
            `[PROACTIVE] Sent owner check-in with mood ${response.data?.owner_mood?.mood || 'unknown'}.`,
        );
    } catch (error) {
        recordProactiveDelivery('failed', describeCoreRequestError(error));
        console.error('[PROACTIVE] Owner check-in failed:', describeCoreRequestError(error));
    } finally {
        isProactiveOwnerPollRunning = false;
    }
}

function startProactiveOwnerPolling() {
    if (!IS_PUBLIC_PROFILE || !LILY_WA_PROACTIVE_ENABLED || proactiveOwnerPoller) {
        return;
    }
    proactiveOwnerPoller = setInterval(() => {
        void pollProactiveOwnerMessage();
    }, LILY_WA_PROACTIVE_POLL_MS);
    void pollProactiveOwnerMessage();
}

async function pollOwnerRoutines() {
    if (
        !IS_PUBLIC_PROFILE
        || !LILY_WA_ROUTINES_ENABLED
        || isOwnerRoutinePollRunning
        || !waClientReady
        || !LILY_CORE_URL
    ) {
        return;
    }
    isOwnerRoutinePollRunning = true;
    try {
        const ownerChatId = await resolveProactiveOwnerChatId();
        if (!ownerChatId) return;
        const response = await requestCore(
            'post',
            `${LILY_CORE_URL}/api/owner/routines/claim`,
            { profile: WA_PROFILE },
            15000,
        );
        if (!response.data?.due || !response.data?.text) return;
        const delivery = response.data?.delivery || {};
        const deliveryId = String(delivery.id || '');
        const leaseToken = String(response.data?.lease_token || delivery.lease_token || '');
        if (!deliveryId || !leaseToken) {
            throw new Error('Core returned a routine without a delivery lease.');
        }
        try {
            await sendHumanizedText(ownerChatId, response.data.text, {
                allowSplit: false,
                operational: false,
                rememberOwnerChatId: true,
                allowLoadedReplyFallback: true,
                waitUntilMsgSent: true,
                idempotencyKey: deliveryId,
            });
        } catch (sendError) {
            await acknowledgeRoutineDelivery(delivery, leaseToken, false, sendError?.message || String(sendError));
            throw sendError;
        }
        try {
            await acknowledgeRoutineDelivery(delivery, leaseToken, true);
        } catch (ackError) {
            lastRoutineDelivery = {
                id: deliveryId,
                routine_id: delivery.routine_id || response.data?.routine?.id || 'daily',
                status: 'sent_unacknowledged',
                attempts: Number(delivery.attempts || 1),
                last_error: ackError?.message || String(ackError),
                updated_at: new Date().toISOString(),
            };
            void reportWaRuntime();
            console.warn('[ROUTINE] Message sent but acknowledgement failed:', ackError?.message || ackError);
        }
        console.log(`[ROUTINE] Sent ${delivery.routine_id || response.data?.routine?.id || 'daily'} to owner.`);
    } catch (error) {
        console.warn('[ROUTINE] Poll failed:', error?.message || error);
    } finally {
        isOwnerRoutinePollRunning = false;
    }
}

async function acknowledgeRoutineDelivery(delivery, leaseToken, success, error = '') {
    const response = await requestCore(
        'post',
        `${LILY_CORE_URL}/api/owner/routines/ack`,
        {
            delivery_id: delivery.id,
            lease_token: leaseToken,
            success: Boolean(success),
            profile: WA_PROFILE,
            error: String(error || '').slice(0, 500),
        },
        15000,
    );
    const acknowledged = response.data?.delivery || delivery;
    lastRoutineDelivery = {
        id: acknowledged.id || delivery.id,
        routine_id: acknowledged.routine_id || delivery.routine_id || 'daily',
        status: acknowledged.status || (success ? 'sent' : 'failed'),
        attempts: Number(acknowledged.attempts || delivery.attempts || 1),
        last_error: acknowledged.last_error || String(error || ''),
        updated_at: acknowledged.updated_at || new Date().toISOString(),
        sent_at: acknowledged.sent_at || null,
        next_attempt_at: acknowledged.next_attempt_at || null,
    };
    void reportWaRuntime();
    return response.data;
}

async function reportWaRuntime() {
    if (!LILY_CORE_URL || isWaRuntimeReportRunning) return;
    isWaRuntimeReportRunning = true;
    try {
        await requestCore(
            'post',
            `${LILY_CORE_URL}/api/owner/runtime/wa`,
            {
                profile: WA_PROFILE,
                ready: waClientReady,
                client_state: waClientState,
                state_updated_at: waClientStateUpdatedAt,
                routine_delivery: lastRoutineDelivery,
            },
            10000,
        );
    } catch (error) {
        console.warn('[RUNTIME] Could not report WA state:', error?.message || error);
    } finally {
        isWaRuntimeReportRunning = false;
    }
}

function startWaRuntimeReporting() {
    if (waRuntimePoller) return;
    waRuntimePoller = setInterval(() => {
        void reportWaRuntime();
    }, 60 * 1000);
    void reportWaRuntime();
}

function startOwnerRoutinePolling() {
    if (!IS_PUBLIC_PROFILE || !LILY_WA_ROUTINES_ENABLED || ownerRoutinePoller) return;
    ownerRoutinePoller = setInterval(() => {
        void pollOwnerRoutines();
    }, LILY_WA_ROUTINE_POLL_MS);
    void pollOwnerRoutines();
}

function loadCoreWatchdogState() {
    try {
        if (!fs.existsSync(CORE_WATCHDOG_PATH)) {
            return { status: 'unknown', consecutive_failures: 0, transition_at: 0 };
        }
        const parsed = JSON.parse(fs.readFileSync(CORE_WATCHDOG_PATH, 'utf8'));
        return {
            status: ['unknown', 'online', 'offline'].includes(parsed?.status) ? parsed.status : 'unknown',
            consecutive_failures: Math.max(0, Number(parsed?.consecutive_failures || 0)),
            transition_at: Math.max(0, Number(parsed?.transition_at || 0)),
        };
    } catch (error) {
        console.warn('[CORE WATCHDOG] Could not load state:', error?.message || error);
        return { status: 'unknown', consecutive_failures: 0, transition_at: 0 };
    }
}

async function sendCoreWatchdogNotice(status, transitionAt) {
    const ownerChatId = await resolveProactiveOwnerChatId();
    if (!ownerChatId) return;
    const message = status === 'offline'
        ? 'Sayang, Core Lily lagi putus koneksi. WA Lily masih hidup, tapi fitur otak utama dan tools sementara nggak bisa dipakai. Lily bakal kabarin lagi begitu pulih.'
        : 'Core Lily udah nyambung lagi. Otak utama dan tools-nya sudah bisa dipakai seperti biasa, jadi nggak perlu khawatir lagi ya.';
    await sendHumanizedText(ownerChatId, message, {
        operational: true,
        allowSplit: false,
        rememberOwnerChatId: true,
        idempotencyKey: `core-watchdog:${status}:${transitionAt}`,
    });
}

async function pollCoreWatchdog() {
    if (
        !IS_PUBLIC_PROFILE
        || !LILY_WA_CORE_WATCHDOG_ENABLED
        || !waClientReady
        || !LILY_CORE_URL
        || isCoreWatchdogRunning
    ) {
        return;
    }
    isCoreWatchdogRunning = true;
    try {
        const state = loadCoreWatchdogState();
        let online = false;
        try {
            await requestCore('get', `${LILY_CORE_URL}/health/ready`, null, 5000, false);
            online = true;
        } catch (_) {
            online = false;
        }
        if (!online) {
            state.consecutive_failures += 1;
            if (state.status !== 'offline' && state.consecutive_failures >= 3) {
                state.status = 'offline';
                state.transition_at = Date.now();
                atomicWriteJson(CORE_WATCHDOG_PATH, state);
                await sendCoreWatchdogNotice('offline', state.transition_at);
            } else {
                atomicWriteJson(CORE_WATCHDOG_PATH, state);
            }
            return;
        }
        state.consecutive_failures = 0;
        if (state.status === 'offline') {
            state.status = 'online';
            state.transition_at = Date.now();
            atomicWriteJson(CORE_WATCHDOG_PATH, state);
            await sendCoreWatchdogNotice('online', state.transition_at);
        } else {
            state.status = 'online';
            atomicWriteJson(CORE_WATCHDOG_PATH, state);
        }
    } finally {
        isCoreWatchdogRunning = false;
    }
}

function startCoreWatchdog() {
    if (!IS_PUBLIC_PROFILE || !LILY_WA_CORE_WATCHDOG_ENABLED || coreWatchdogPoller) return;
    coreWatchdogPoller = setInterval(() => {
        void pollCoreWatchdog();
    }, LILY_WA_CORE_WATCHDOG_POLL_MS);
    void pollCoreWatchdog();
}

async function approveOpenClawTask(taskId, replyLanguage = 'id') {
    const id = (taskId || '').trim();
    if (!id) {
        return getLocalizedBridgeText('unclearToolId', replyLanguage);
    }

    if (!await isCoreAvailable(true)) {
        return getCoreUnavailableReply(replyLanguage);
    }

    try {
        const response = await requestCore('post', `${LILY_CORE_URL}/api/tools/openclaw/${encodeURIComponent(id)}/approve`, {
            approver: 'wa_owner',
        }, 10000);
        const status = response.data?.status || response.data?.task?.status || 'approved';
        return getLocalizedBridgeText('approveDone', replyLanguage, { id, status });
    } catch (error) {
        console.error('OpenClaw approve request failed:', error);
        return getLocalizedBridgeText('approveFailed', replyLanguage, { id });
    }
}

async function denyOpenClawTask(taskId, reason = '', replyLanguage = 'id') {
    const id = (taskId || '').trim();
    if (!id) {
        return getLocalizedBridgeText('unclearToolId', replyLanguage);
    }

    if (!await isCoreAvailable(true)) {
        return getCoreUnavailableReply(replyLanguage);
    }

    try {
        const response = await requestCore('post', `${LILY_CORE_URL}/api/tools/openclaw/${encodeURIComponent(id)}/deny`, {
            approver: 'wa_owner',
            reason,
        }, 10000);
        const status = response.data?.status || response.data?.task?.status || 'denied';
        return getLocalizedBridgeText('denyDone', replyLanguage, { id, status });
    } catch (error) {
        console.error('OpenClaw deny request failed:', error);
        return getLocalizedBridgeText('denyFailed', replyLanguage, { id });
    }
}

function resolveCoreMediaUrl(value) {
    const raw = (value || '').toString().trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${LILY_CORE_URL.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`;
}

async function sendOwnerMessageToCore(
    chatId,
    finalMessage,
    useOpenClawRoute,
    replyLanguage,
    inputFiles = [],
    wantVoiceReply = false,
    voiceRoute = '',
    quotedReply = null,
) {
    const language = normalizeReplyLanguage(replyLanguage || detectReplyLanguage(finalMessage));
    const ownerPresenceContext = getActiveOwnerPresence();
    if (useOpenClawRoute) {
        const response = await requestCore('post', `${LILY_CORE_URL}/api/core/ingest`, {
            source: 'wa_bridge',
            session_id: buildWhatsAppUserId(chatId, true),
            mode: 'owner_tool',
            payload: {
                sender_name: 'Owner',
                requester: 'wa_owner',
                message: finalMessage,
                chat_id: chatId,
                is_owner: true,
                wa_profile: WA_PROFILE,
                access_scope: 'owner',
                require_tool_approval: false,
                delivery_channel: 'wa',
                delivery_profile: WA_PROFILE,
                delivery_target: chatId,
                reply_language: language,
                voice_language: language,
                owner_presence: ownerPresenceContext,
                input_files: Array.isArray(inputFiles) ? inputFiles : [],
                ...(quotedReply ? { quoted_reply: quotedReply } : {}),
            },
        }, 45000);

        const result = response.data?.result || {};
        return {
            text: result.text || getLocalizedBridgeText('openclawAcceptedEmpty', language),
            audio: null,
            important: true,
            metadata: result.metadata || {},
        };
    }

    const response = await requestCore('post', `${LILY_CORE_URL}/api/chat`, {
        user_id: buildWhatsAppUserId(chatId, true),
        message: finalMessage,
        want_voice: Boolean(wantVoiceReply),
        context: {
            ...getCoreLanguageContext(language),
            wa_profile: WA_PROFILE,
            is_owner: true,
            access_scope: 'owner',
            reply_length_mode: getOwnerReplyLengthMode(),
            ...(quotedReply ? { quoted_reply: quotedReply } : {}),
            ...(voiceRoute ? { voice_route: voiceRoute } : {}),
        },
    }, 45000, false);

    return {
        text: response.data?.text || '',
        audio: response.data?.audio || null,
        important: Boolean(response.data?.mood_important),
        moodExpression: response.data?.mood_expression || '',
        ownerMood: response.data?.owner_mood || null,
    };
}

async function sendPublicMessageToCore(chatId, finalMessage, replyLanguage, senderDisplayName = '', quotedReply = null) {
    const language = normalizeReplyLanguage(replyLanguage || detectReplyLanguage(finalMessage));
    const response = await requestCore('post', `${LILY_CORE_URL}/api/core/ingest`, {
        source: 'wa_bridge',
        session_id: buildWhatsAppUserId(chatId, false),
        mode: 'public_chat',
        payload: {
            sender_name: getCachedContactDisplayName(chatId, senderDisplayName || 'Contact'),
            requester: 'wa_public',
            message: finalMessage,
            chat_id: chatId,
            is_owner: false,
            wa_profile: WA_PROFILE,
            access_scope: 'public_chat',
            reply_language: language,
            ...(quotedReply ? { quoted_reply: quotedReply } : {}),
        },
    }, 30000);
    return response.data?.result?.text || '';
}

function normalizePhoneNumber(value) {
    return (value || '').replace(/\D/g, '');
}

function uniqueNonEmpty(values) {
    return [...new Set(values.map((value) => (value || '').toString().trim()).filter(Boolean))];
}

function configuredNumberValues(configuredNumber) {
    return uniqueNonEmpty((configuredNumber || '').toString().split(/[\s,;]+/));
}

function contactIdentityCandidates(chatId, contact = null) {
    return uniqueNonEmpty([
        chatId,
        (chatId || '').split('@')[0],
        contact?.number,
        contact?.id?.user,
        contact?.id?._serialized,
        contact?._serialized,
    ]);
}

function identityMatchesValue(identity, configuredValue) {
    const rawIdentity = (identity || '').toString().trim().toLowerCase();
    const rawConfigured = (configuredValue || '').toString().trim().toLowerCase();
    const identityNumber = normalizePhoneNumber(rawIdentity.split('@')[0]);
    const configuredNumber = normalizePhoneNumber(rawConfigured.split('@')[0]);

    if (!rawIdentity || !rawConfigured) return false;
    if (rawIdentity === rawConfigured) return true;
    if (rawIdentity.split('@')[0] === rawConfigured.split('@')[0]) return true;
    if (!identityNumber || !configuredNumber) return false;

    return identityNumber === configuredNumber
        || identityNumber.endsWith(configuredNumber)
        || configuredNumber.endsWith(identityNumber);
}

function matchesConfiguredNumber(chatId, configuredNumber, contact = null, additionalIdentities = []) {
    const identities = uniqueNonEmpty([
        ...contactIdentityCandidates(chatId, contact),
        ...(Array.isArray(additionalIdentities) ? additionalIdentities : []),
    ]);
    const configuredValues = configuredNumberValues(configuredNumber);

    if (!identities.length || !configuredValues.length) return false;
    return identities.some((identity) =>
        configuredValues.some((configuredValue) => identityMatchesValue(identity, configuredValue))
    );
}

async function resolveLidPhoneIdentities(chatId) {
    if (!/@lid$/i.test((chatId || '').toString())) return [];
    try {
        const mappings = await client.getContactLidAndPhone([chatId]);
        return uniqueNonEmpty((Array.isArray(mappings) ? mappings : []).flatMap((mapping) => [
            mapping?.lid,
            mapping?.pn,
            (mapping?.pn || '').split('@')[0],
        ]));
    } catch (error) {
        console.warn('[WA IDENTITY] Could not resolve LID phone identity:', error.message || error);
        return [];
    }
}

function isAllowedTestChat(chatId, ownerNumber, contact = null) {
    if (matchesConfiguredNumber(chatId, ownerNumber, contact)) return true;
    return matchesConfiguredNumber(chatId, ALLOWED_TEST_NUMBER, contact);
}

async function needsNeuralCore(message) {
    const lowerMsg = (message || '').toLowerCase().trim();
    if (!lowerMsg) return false;
    if (hasWakePcIntent(message)) return true;

    const obviousCoreKeywords = [
        'suara',
        'voice',
        'vn',
        'voice note',
        'tts',
        'sovits',
        'gpt-sovits',
        'openclaw',
        'search',
        'browse',
        'cari di web',
        'cek web',
        'lihat website',
        'buka website',
        'berita terbaru',
        'latest news',
        'buka aplikasi',
        'nyala pc',
        'nyala komputer',
        'nyala core',
        'kirimin file',
        'kirim file',
        'send file',
        'mindahin file',
        'pindahin file',
        'copy file',
        'salin file',
        'kirimin gambar',
        'kirim gambar',
        'wallpaper',
    ];

    if (obviousCoreKeywords.some((keyword) => lowerMsg.includes(keyword))) {
        return true;
    }

    if (!genAI) {
        return false;
    }

    try {
        const prompt = `Classify this WhatsApp message into one label only.

Labels:
- NEURAL_CORE: needs voice generation, browsing/live info lookup, OpenClaw tools, app/device control, or special execution.
- TEXT_ONLY: normal conversation, regular questions, casual chat, text-only replies.

Reply with exactly one label: NEURAL_CORE or TEXT_ONLY.

Message: ${message}`;

        const result = await generateGeminiText(GEMINI_ROUTER_MODEL, prompt, 'router');
        return result.trim().toUpperCase().includes('NEURAL_CORE');
    } catch (error) {
        console.error('Gemini router fallback to text-only:', error);
        return false;
    }
}

function getCoreUnavailableReply(replyLanguage = 'id') {
    return getLocalizedBridgeText('coreUnavailable', replyLanguage);
}

function getChatRateLimitReply(isOwner, replyLanguage = 'id') {
    if (isOwner) {
        return getLocalizedBridgeText('ownerRateLimit', replyLanguage);
    }

    return getLocalizedBridgeText('secretaryRateLimit', replyLanguage);
}

function isValidMacAddress(mac) {
    return /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test((mac || '').trim());
}

function sendWakeMagicPacket(mac) {
    return new Promise((resolve, reject) => {
        if (!mac) {
            reject(new Error('Wake-on-LAN MAC address is not configured.'));
            return;
        }

        if (!isValidMacAddress(mac)) {
            reject(new Error('Wake-on-LAN MAC address format is invalid.'));
            return;
        }

        let wol;
        try {
            wol = require('wake_on_lan');
        } catch (error) {
            reject(new Error('wake_on_lan module is missing on the bridge.'));
            return;
        }

        const wakeBroadcastIp = (process.env.LILY_WAKE_BROADCAST_IP || '255.255.255.255').trim() || '255.255.255.255';
        const configuredWakePort = Number.parseInt(process.env.LILY_WAKE_PORT || '9', 10);
        const wakePort = Number.isInteger(configuredWakePort) && configuredWakePort > 0 ? configuredWakePort : 9;

        wol.wake(mac, { address: wakeBroadcastIp, port: wakePort }, (error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve({
                status: 'ok',
                mode: 'bridge_local',
                broadcast_ip: wakeBroadcastIp,
                port: wakePort,
            });
        });
    });
}

async function executeWakePcCommand(replyLanguage = 'id') {
    try {
        await sendWakeMagicPacket(process.env.LILY_CORE_MAC);
        return await generateWakePcReply(replyLanguage);
    } catch (error) {
        console.error("Bridge-local Wake-on-LAN failed:", error);
        return getLocalizedBridgeText('wakeFailed', replyLanguage, {
            detail: error.message || String(error),
        });
    }
}

function readControlJson(req, maxBytes = BRIDGE_CONTROL_MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let received = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) return;
            received += chunk.length;
            if (received > maxBytes) {
                settled = true;
                const error = new Error('Request body exceeds the configured limit.');
                error.statusCode = 413;
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (_error) {
                const error = new Error('Request body must be valid JSON.');
                error.statusCode = 400;
                reject(error);
            }
        });
        req.on('error', (cause) => {
            if (settled) return;
            settled = true;
            const error = new Error(cause?.message || 'Could not read request body.');
            error.statusCode = 400;
            reject(error);
        });
    });
}

function allowBridgeControlRequest(remoteAddress, method, pathname) {
    if (method === 'OPTIONS') return { allowed: true, retryAfter: 0 };
    const limit = pathname === '/api/power/wake' ? 6 : (method === 'GET' ? 120 : 60);
    const windowMs = 60 * 1000;
    const now = Date.now();
    const routeGroup = pathname.startsWith('/api/inbox/') ? '/api/inbox/*'
        : pathname.startsWith('/api/secretary/') ? '/api/secretary/*'
            : pathname.startsWith('/api/owner/') ? '/api/owner/*' : pathname;
    const key = `${remoteAddress}:${method}:${routeGroup}`;
    const recent = (bridgeControlRateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= limit) {
        bridgeControlRateBuckets.set(key, recent);
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) };
    }
    recent.push(now);
    bridgeControlRateBuckets.set(key, recent);
    if (bridgeControlRateBuckets.size > 2048) {
        for (const [bucket, timestamps] of bridgeControlRateBuckets.entries()) {
            if (!timestamps.some((timestamp) => now - timestamp < windowMs)) bridgeControlRateBuckets.delete(bucket);
        }
        while (bridgeControlRateBuckets.size > 2048) {
            bridgeControlRateBuckets.delete(bridgeControlRateBuckets.keys().next().value);
        }
    }
    return { allowed: true, retryAfter: 0 };
}

function appendBridgeControlAudit({ event, requestId, method, pathname, status, remoteAddress, providedToken }) {
    try {
        fs.mkdirSync(path.dirname(BRIDGE_CONTROL_AUDIT_PATH), { recursive: true });
        if (fs.existsSync(BRIDGE_CONTROL_AUDIT_PATH)
            && fs.statSync(BRIDGE_CONTROL_AUDIT_PATH).size >= BRIDGE_CONTROL_AUDIT_MAX_BYTES) {
            const archivePath = `${BRIDGE_CONTROL_AUDIT_PATH}.1`;
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
            fs.renameSync(BRIDGE_CONTROL_AUDIT_PATH, archivePath);
        }
        const actor = providedToken
            ? `token:${crypto.createHash('sha256').update(providedToken).digest('hex').slice(0, 12)}`
            : 'anonymous';
        const record = {
            timestamp: new Date().toISOString(),
            event,
            request_id: requestId,
            method,
            route: pathname.startsWith('/api/inbox/') ? '/api/inbox/*' : pathname,
            status,
            client: remoteAddress,
            actor,
        };
        fs.appendFileSync(BRIDGE_CONTROL_AUDIT_PATH, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
        console.warn('[SECURITY] Could not append Bridge control audit:', error.message || error);
    }
}

function startBridgeControlServer() {
    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const providedToken = (req.headers['x-lily-token'] || '').toString().trim();
        const requestOrigin = (req.headers.origin || '').toString().trim().replace(/\/$/, '');
        const allowedOrigin = requestOrigin && BRIDGE_CONTROL_CORS_ALLOW_ORIGINS.has(requestOrigin)
            ? requestOrigin
            : '';
        const remoteAddress = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
        const requestId = crypto.randomUUID();

        const writeJson = (statusCode, payload) => {
            const headers = {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Lily-Token',
                'Cache-Control': 'no-store',
                'Vary': 'Origin',
                'X-Request-ID': requestId,
            };
            if (allowedOrigin) {
                headers['Access-Control-Allow-Origin'] = allowedOrigin;
            }
            res.writeHead(statusCode, headers);
            res.end(JSON.stringify(payload));
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || statusCode >= 400) {
                appendBridgeControlAudit({
                    event: statusCode === 429
                        ? 'rate_limited'
                        : (statusCode === 401 || statusCode === 403 ? 'authentication_failed' : 'control_request'),
                    requestId,
                    method: req.method,
                    pathname: requestUrl.pathname,
                    status: statusCode,
                    remoteAddress,
                    providedToken,
                });
            }
        };

        const ensureControlToken = () => {
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return false;
            }
            if (providedToken !== BRIDGE_CONTROL_TOKEN) {
                writeJson(403, { status: 'error', detail: 'Invalid bridge control token.' });
                return false;
            }

            return true;
        };

        if (requestOrigin && !allowedOrigin) {
            writeJson(403, { status: 'error', detail: 'Origin is not allowed.' });
            return;
        }

        if (req.method === 'OPTIONS') {
            writeJson(200, { status: 'ok' });
            return;
        }

        const rate = allowBridgeControlRequest(remoteAddress, req.method, requestUrl.pathname);
        if (!rate.allowed) {
            res.setHeader('Retry-After', String(rate.retryAfter));
            writeJson(429, { status: 'error', detail: 'Too many requests.' });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/health/live') {
            writeJson(200, {
                status: 'ok',
                service: 'lily_wa_bridge_executor',
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/health/ready') {
            writeJson(waClientReady ? 200 : 503, {
                status: waClientReady ? 'ready' : 'not_ready',
                service: 'lily_wa_bridge_executor',
                ready: waClientReady,
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/health') {
            writeJson(200, {
                status: waClientReady ? 'ok' : 'degraded',
                service: 'lily_wa_bridge_executor',
                ready: waClientReady,
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
            if (!ensureControlToken()) return;
            ownerEngagement = loadOwnerEngagement();
            writeJson(200, {
                status: waClientReady ? 'ok' : 'degraded',
                service: 'lily_wa_bridge_executor',
                profile: WA_PROFILE,
                ready: waClientReady,
                client_state: waClientState,
                identity: waClientReady ? 'verified' : waClientState,
                state_updated_at: waClientStateUpdatedAt,
                proactive: IS_PUBLIC_PROFILE ? {
                    enabled: LILY_WA_PROACTIVE_ENABLED,
                    min_idle_seconds: Math.round(LILY_WA_PROACTIVE_MIN_IDLE_MS / 1000),
                    cooldown_seconds: Math.round(LILY_WA_PROACTIVE_COOLDOWN_MS / 1000),
                    paused: Number(ownerEngagement.proactive_paused_until || 0) > Date.now(),
                    paused_until: Number(ownerEngagement.proactive_paused_until || 0) || null,
                    last_attempt_at: ownerEngagement.last_proactive_attempt_at || null,
                    last_status: ownerEngagement.last_proactive_status || 'never',
                    last_error: ownerEngagement.last_proactive_error || null,
                    target_scheme: normalizeDirectChatId(ownerEngagement.last_owner_chat_id).split('@')[1] || null,
                    ack: ownerEngagement.last_proactive_ack,
                    ack_label: ownerEngagement.last_proactive_ack_label || null,
                    ack_at: ownerEngagement.last_proactive_ack_at || null,
                } : null,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/secretary/status') {
            if (!IS_PERSONAL_PROFILE) { writeJson(404, { detail: 'Not found.' }); return; }
            if (!BRIDGE_CONTROL_TOKEN) { writeJson(503, { detail: 'Bridge control token is not configured.' }); return; }
            if (!ensureControlToken()) return;
            writeJson(200, { mode: secretaryConfig.settings()?.mode || 'off', enabled: secretary.enabled(),
                configuration_fresh: Boolean(secretaryConfig.fresh()),
                wa_client_ready: waClientReady, wa_client_state: waClientState,
                wa_client_state_updated_at: waClientStateUpdatedAt,
                triage_mode: secretaryConfig.settings()?.triage_mode || 'shadow',
                runtime: secretary.runtimeStatus(),
                first_reply_delay_ms: (secretaryConfig.settings()?.first_reply_seconds || 60) * 1000,
                handoff_ms: (secretaryConfig.settings()?.handoff_minutes || 30) * 60000 });
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/owner/proactive/test') {
            const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!IS_PUBLIC_PROFILE || !['127.0.0.1', '::1'].includes(remoteAddress)) {
                writeJson(404, { status: 'error', detail: 'Not found.' });
                return;
            }
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return;
            }
            if (!ensureControlToken()) return;

            try {
                    const payload = await readControlJson(req);
                    const cleanMessage = (payload.message || '').toString()
                        .replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ')
                        .trim()
                        .slice(0, 1500);
                    const requestedOwnerNumber = normalizeInternationalNumber(payload.owner_number || '');
                    const ownerChatId = await resolveProactiveOwnerChatId(requestedOwnerNumber);
                    if (!cleanMessage || !ownerChatId || !waClientReady) {
                        writeJson(503, { status: 'error', detail: 'Proactive WhatsApp delivery is not ready.' });
                        return;
                    }
                    const sentMessage = await sendHumanizedText(ownerChatId, cleanMessage, {
                        allowSplit: false,
                        operational: false,
                        rememberOwnerChatId: true,
                        allowLoadedReplyFallback: true,
                        waitUntilMsgSent: true,
                    });
                    recordProactiveDelivery('test_sent', '', sentMessage);
                    writeJson(200, {
                        status: 'sent',
                        profile: WA_PROFILE,
                        target_scheme: ownerChatId.split('@')[1] || null,
                        target_last4: requestedOwnerNumber.slice(-4) || null,
                        ack: Number.isFinite(Number(sentMessage?.ack)) ? Number(sentMessage.ack) : null,
                        ack_label: Number.isFinite(Number(sentMessage?.ack))
                            ? proactiveAckLabel(sentMessage.ack)
                            : null,
                    });
                } catch (error) {
                    recordProactiveDelivery('test_failed', error.message || String(error));
                    writeJson(error.statusCode || 500, { status: 'error', detail: error.message || String(error) });
                }
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/owner/openclaw/redeliver') {
            const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!IS_PERSONAL_PROFILE || !['127.0.0.1', '::1'].includes(remoteAddress)) {
                writeJson(404, { status: 'error', detail: 'Not found.' });
                return;
            }
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return;
            }
            if (!ensureControlToken()) return;

            try {
                    const payload = await readControlJson(req);
                    const result = await redeliverOpenClawTask(payload.task_id);
                    writeJson(200, { status: 'sent', profile: WA_PROFILE, ...result });
                } catch (error) {
                    writeJson(error.statusCode || 500, { status: 'error', detail: error.message || String(error) });
                }
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/owner/proactive/diagnostics') {
            const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!IS_PUBLIC_PROFILE || !['127.0.0.1', '::1'].includes(remoteAddress)) {
                writeJson(404, { status: 'error', detail: 'Not found.' });
                return;
            }
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return;
            }
            if (!ensureControlToken()) return;
            try {
                writeJson(200, {
                    status: 'ok',
                    ...(await getProactiveOwnerDiagnostics()),
                });
            } catch (error) {
                writeJson(500, { status: 'error', detail: error.message || String(error) });
            }
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/client/reset') {
            const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!['127.0.0.1', '::1'].includes(remoteAddress)) {
                writeJson(404, { status: 'error', detail: 'Not found.' });
                return;
            }
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return;
            }
            if (!ensureControlToken()) return;
            try {
                await client.resetState();
                writeJson(200, { status: 'reconnecting', profile: WA_PROFILE });
            } catch (error) {
                writeJson(500, { status: 'error', detail: error.message || String(error) });
            }
            return;
        }

        if (['/api/inbox/review', '/api/inbox/notifications', '/api/inbox/draft', '/api/inbox/approve', '/api/inbox/resolve', '/api/inbox/correct', '/api/inbox/remind', '/api/inbox/cancel-reminder'].includes(requestUrl.pathname)) {
            if (!IS_PERSONAL_PROFILE || !BRIDGE_CONTROL_TOKEN) { writeJson(503, {detail: 'Personal inbox review is unavailable.'}); return; }
            if (!ensureControlToken()) return;
            if (req.method === 'GET' && requestUrl.pathname === '/api/inbox/review') {
                writeJson(200, {items: inboxReview.list().map(item => ({...item,
                    ...inboxDelivery.forItem(externalInbox.find(entry => entry.id === item.id))}))}); return;
            }
            if (req.method === 'GET' && requestUrl.pathname === '/api/inbox/notifications') {
                writeJson(200, {items: inboxDelivery.notifications()}); return;
            }
            if (req.method !== 'POST' || ['/api/inbox/review', '/api/inbox/notifications'].includes(requestUrl.pathname)) { writeJson(405, {detail: 'Method not allowed.'}); return; }
            try {
                    const data = await readControlJson(req);
                    const action = requestUrl.pathname.split('/').pop();
                    if (action === 'approve' && data.confirm !== true) throw new Error('Explicit confirmation is required.');
                    if (['remind', 'cancel-reminder'].includes(action) && !inboxReview.list().some(item => item.id === data.id && !item.processing)) throw new Error('Conversation is unavailable.');
                    const result = action === 'draft' ? await inboxReview.draft(data.id)
                        : action === 'resolve' ? await inboxReview.resolve(data.id)
                        : action === 'correct' ? await inboxReview.correct(data.id, data.category)
                        : action === 'remind' ? inboxDelivery.remind(data.id, data.due_at, data.note || '')
                        : action === 'cancel-reminder' ? inboxDelivery.cancel(data.id)
                        : await inboxReview.approve(data.id, data.revision, data.text);
                    if (['resolve', 'approve'].includes(action)) inboxDelivery.cancel(data.id);
                    writeJson(200, {result});
                } catch (error) { writeJson(error.statusCode || 409, {detail: error.message || 'Review action failed.'}); }
            return;
        }
        if (req.method === 'GET' && requestUrl.pathname === '/api/inbox') {
            if (!ensureControlToken()) {
                return;
            }

            const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit') || 8), 20));
            syncExternalInboxMetadata();
            const latestInbox = getLatestInboxPerChat(externalInbox).filter(item => !IS_PERSONAL_PROFILE ||
                secretaryConfig.action(reviewContactNumber(item.chatId)) !== 'ignore');
            const items = latestInbox
                .slice(0, limit)
                .map((item, index) => ({
                id: item.id || `${item.chatId || 'chat'}_${index}`,
                chatId: item.chatId || '',
                phoneNumber: item.phoneNumber || '',
                name: getCachedContactDisplayName(item.chatId || '', item.name || item.phoneNumber || item.chatId || 'Unknown'),
                relation: getContactProfile(item.chatId || '')?.relation || item.relation || 'unknown',
                label: getContactProfile(item.chatId || '')?.label || item.label || 'general',
                summary: inboxSummary(item),
                originalMessage: item.originalMessage || '',
                createdAt: item.createdAt || new Date().toISOString(),
            }));

            writeJson(200, {
                status: 'ok',
                count: latestInbox.length,
                items,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/owner/notify') {
            const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!IS_PUBLIC_PROFILE || !['127.0.0.1', '::1'].includes(remoteAddress)) {
                writeJson(404, { status: 'error', detail: 'Not found.' });
                return;
            }
            if (!BRIDGE_CONTROL_TOKEN) {
                writeJson(503, { status: 'error', detail: 'Bridge control token is not configured.' });
                return;
            }
            if (!ensureControlToken()) return;

            try {
                    const payload = await readControlJson(req);
                    const cleanMessage = (payload.message || '').toString().replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, 6000);
                    const ownerNumber = normalizeInternationalNumber(process.env.OWNER_NUMBER);
                    if (!cleanMessage || !ownerNumber || !waClientReady) {
                        writeJson(503, { status: 'error', detail: 'Public WhatsApp delivery is not ready.' });
                        return;
                    }
                    await client.sendMessage(`${ownerNumber}@c.us`, cleanMessage);
                    writeJson(200, { status: 'sent', profile: WA_PROFILE });
                } catch (error) {
                    writeJson(error.statusCode || 500, { status: 'error', detail: error.message || String(error) });
                }
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/power/wake') {
            if (!ensureControlToken()) {
                return;
            }

            try {
                    const payload = await readControlJson(req);
                    const result = await sendWakeMagicPacket(process.env.LILY_CORE_MAC);
                    writeJson(200, {
                        ...result,
                        source: payload?.source || 'unknown',
                        reason: payload?.reason || 'bridge executor wake request',
                        timestamp: new Date().toISOString(),
                    });
                } catch (error) {
                    console.error('Bridge wake executor failed:', error);
                    writeJson(error.statusCode || 500, {
                        status: 'error',
                        detail: error.message || String(error),
                    });
                }

            return;
        }

        writeJson(404, { status: 'error', detail: 'Not found.' });
    });

    if (!BRIDGE_CONTROL_TOKEN && !['127.0.0.1', '::1', 'localhost'].includes(BRIDGE_CONTROL_HOST.toLowerCase())) {
        throw new Error('BRIDGE_CONTROL_TOKEN is required when Bridge control binds beyond loopback.');
    }

    server.listen(BRIDGE_CONTROL_PORT, BRIDGE_CONTROL_HOST, () => {
        // Record the Node process identity; this helper never starts or updates services.
        require('node:child_process').spawnSync(process.platform === 'win32' ? 'python' : 'python3',
            [path.join(__dirname, '..', 'scripts', 'runtime_status.py'), 'stamp',
                IS_PERSONAL_PROFILE ? 'wa_personal' : 'wa_public', '--pid', String(process.pid)],
            { windowsHide: true, stdio: 'ignore', timeout: 15000 });
        console.log(`Bridge control executor (${WA_PROFILE}) listening on http://${BRIDGE_CONTROL_HOST}:${BRIDGE_CONTROL_PORT}`);
    });

    server.on('error', (error) => {
        console.error('Bridge control server failed:', error);
    });
}

function getVoiceMessageUnavailableReply(isOwner, hasIntroduced, replyLanguage = 'id') {
    if (isOwner) {
        return hasIntroduced
            ? getLocalizedBridgeText('ownerVoiceIntroduced', replyLanguage)
            : getLocalizedBridgeText('ownerVoiceNew', replyLanguage);
    }

    return hasIntroduced
        ? getLocalizedBridgeText('secretaryVoiceIntroduced', replyLanguage)
        : getLocalizedBridgeText('secretaryVoiceNew', replyLanguage);
}

class LilyLocalAuth extends LocalAuth {
    async afterBrowserInitialized() {
        await super.afterBrowserInitialized();
        await this.client.pupPage.setBypassServiceWorker(true);
    }
}

const LilyWhatsAppClient = createNavigationResilientClient(Client);
const client = new LilyWhatsAppClient({
    authStrategy: new LilyLocalAuth(IS_PUBLIC_PROFILE ? { clientId: 'lily-public' } : {}),
    authTimeoutMs: LILY_WA_AUTH_TIMEOUT_MS,
    ...(IS_PUBLIC_PROFILE && LILY_WA_PAIRING_NUMBER ? {
        pairWithPhoneNumber: {
            phoneNumber: LILY_WA_PAIRING_NUMBER,
            showNotification: true,
            intervalMs: 180000,
        },
    } : {}),
    ...(LILY_WA_WEB_VERSION ? { webVersion: LILY_WA_WEB_VERSION } : {}),
    ...(LILY_WA_USER_AGENT ? { userAgent: LILY_WA_USER_AGENT } : {}),
    webVersionCache: {
        ...(LILY_WA_WEB_VERSION
            ? { type: 'local', path: path.join(PROFILE_RUNTIME_DIR, 'wwebjs_cache') }
            : { type: 'none' }),
    },
    puppeteer: {
        ...(PUPPETEER_EXECUTABLE_PATH ? { executablePath: PUPPETEER_EXECUTABLE_PATH } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

function updateWaClientState(state, ready = false) {
    waClientState = state;
    waClientReady = ready;
    waClientStateUpdatedAt = new Date().toISOString();
}

let waShutdownStarted = false;

async function shutdownWaBridge(signal, exitCode = 0) {
    if (waShutdownStarted) {
        return;
    }

    waShutdownStarted = true;
    updateWaClientState('stopping');
    console.log(`Stopping Lily WA bridge after ${signal}.`);

    if (openClawDeliveryPoller) {
        clearInterval(openClawDeliveryPoller);
        openClawDeliveryPoller = null;
    }
    if (proactiveOwnerPoller) {
        clearInterval(proactiveOwnerPoller);
        proactiveOwnerPoller = null;
    }
    if (ownerRoutinePoller) {
        clearInterval(ownerRoutinePoller);
        ownerRoutinePoller = null;
    }
    if (waRuntimePoller) {
        clearInterval(waRuntimePoller);
        waRuntimePoller = null;
    }
    if (coreWatchdogPoller) {
        clearInterval(coreWatchdogPoller);
        coreWatchdogPoller = null;
    }

    try {
        await Promise.race([
            client.destroy(),
            new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
    } catch (error) {
        console.warn('Lily WA bridge shutdown could not close cleanly:', error?.message || error);
    }

    process.exit(exitCode);
}

process.once('SIGTERM', () => {
    void shutdownWaBridge('SIGTERM');
});

process.once('SIGINT', () => {
    void shutdownWaBridge('SIGINT');
});

client.on('lily_navigation_retry', ({ attempt, maxAttempts }) => {
    updateWaClientState('reconnecting');
    void reportWaRuntime();
    console.warn(`WA page reloaded during injection; recovery ${attempt}/${maxAttempts - 1}.`);
});

client.on('lily_navigation_failed', (error) => {
    updateWaClientState('recovery_failed');
    void reportWaRuntime();
    console.error('WA page recovery failed:', error?.message || error);
    void shutdownWaBridge('WA page recovery failure', 1);
});

client.on('qr', (qr) => {
    updateWaClientState('awaiting_qr');
    fs.writeFileSync(PAIRING_QR_PATH, qr, { encoding: 'utf8', mode: 0o600 });
    // Display QR Code in the terminal
    qrcode.generate(qr, { small: true });
    console.log(`Scan this QR Code using ${IS_PERSONAL_PROFILE ? "the owner's WhatsApp (Personal Bridge)" : "Lily's WhatsApp (Lily Bridge)"}.`);
});

client.on('authenticated', () => {
    updateWaClientState('authenticated');
});

client.on('code', (code) => {
    updateWaClientState('awaiting_pairing_code');
    console.log(`LILY_WA_PAIRING_CODE=${code}`);
});

client.on('ready', async () => {
    const identity = verifyProfileIdentity(
        WA_PROFILE,
        client.info?.wid?.user,
        process.env.OWNER_NUMBER,
        LILY_WA_PAIRING_NUMBER,
    );
    if (!identity.ok) {
        updateWaClientState(identity.state);
        await reportWaRuntime();
        console.error(`[PROFILE ISOLATION] ${WA_PROFILE} bridge ${identity.state}; message handling disabled.`);
        return;
    }
    updateWaClientState('ready', true);
    await reportWaRuntime();
    try {
        if (fs.existsSync(PAIRING_QR_PATH)) fs.unlinkSync(PAIRING_QR_PATH);
    } catch (error) {
        console.warn('Could not remove consumed pairing QR:', error.message || error);
    }
    console.log(`Lily WA Bot (${WA_PROFILE}) is ready and connected!`);
    if (IS_PUBLIC_PROFILE) {
        savePublicProfileIdentity();
    }
    if (IS_PERSONAL_PROFILE) {
        syncExternalInboxMetadata();
        await refreshExternalInboxContactNames();
        await backfillExternalInboxFromRecentChats();
        syncExternalInboxMetadata();
    }
    startOpenClawDeliveryPolling();
    startProactiveOwnerPolling();
    startOwnerRoutinePolling();
    startWaRuntimeReporting();
    startCoreWatchdog();
});

client.on('auth_failure', () => {
    updateWaClientState('auth_failure');
    void reportWaRuntime();
});

client.on('disconnected', () => {
    updateWaClientState('disconnected', false);
    void reportWaRuntime();
});

async function askOwnerTextOnlyFlash(prompt, replyLanguage) {
    const ownerName = process.env.OWNER_NAME || "sayang";
    const language = normalizeReplyLanguage(replyLanguage || detectReplyLanguage(prompt));
    const languageLabel = getReplyLanguageLabel(language);
    const languageTone = language === 'en'
        ? 'natural for everyday English chat'
        : 'natural untuk chat bahasa Indonesia sehari-hari yang santai';

    if (!genAI) {
        return getLocalizedBridgeText('ownerTextOffline', language, { ownerName });
    }

    try {
        const memoryContext = `Owner memory:
- Preferred name: ${ownerMemory.preferredName || '-'}
- Nickname: ${ownerMemory.nickname || '-'}
- Preferences: ${ownerMemory.preferences.join(', ') || '-'}
- Notes: ${ownerMemory.notes.join(' | ') || '-'}
- Recent topics: ${ownerMemory.recentTopics.join(' | ') || '-'}
- Recent interactions: ${ownerMemory.lastInteractions.join(' | ') || '-'}
- Current presence: ${getActiveOwnerPresence().label} - ${getActiveOwnerPresence().note}`;
        const systemPrompt = await require('./prompt-store').renderPrompt('wa_owner_fallback', { ownerName, languageLabel, languageTone }, fetchPromptSnapshot);
        const fullPrompt = `${systemPrompt}\n\n${memoryContext}\n\nUser asked: ${prompt}`;
        return await generateGeminiText(GEMINI_CHAT_MODEL, fullPrompt, 'chat');
    } catch (e) {
        console.error("Owner Text Flash Error:", e);
        return getChatRateLimitReply(true, language);
    }
}

async function generateWakePcReply(replyLanguage = 'id') {
    const language = normalizeReplyLanguage(replyLanguage);
    if (!genAI) {
        return getLocalizedBridgeText('wakeFallback', language);
    }

    try {
        const prompt = `Write one short WhatsApp reply in ${getReplyLanguageLabel(language)} as Lily to her owner after successfully turning on the PC remotely.

Style:
- Santai Sayang: affectionate, playful, familiar, and soft
- natural WhatsApp wording, not stiff or system-like
- short, 1 sentence only
- do not mention technical details
- say Lily turned the PC on and ask the owner to wait a moment
- Indonesian may use "sayang" and "bentar"; English may use "love" once
- no emoji, markdown, or formal status wording

Return only the reply text.`;

        return await generateGeminiText(GEMINI_CHAT_MODEL, prompt, 'chat');
    } catch (error) {
        console.error("Wake PC reply generation failed:", error);
        return getLocalizedBridgeText('wakeFallback', language);
    }
}


async function askSecretaryFallbackFlash(prompt, replyLanguage, hasIntroduced = false) {
    const language = normalizeReplyLanguage(replyLanguage || detectReplyLanguage(prompt));
    try {
        const ownerName = process.env.OWNER_NAME || "Lily User";
        const languageLabel = getReplyLanguageLabel(language);
        const presence = getActiveOwnerPresence();
        const introductionRule = hasIntroduced
            ? "This contact has already been introduced to Lily before. Do not introduce yourself again unless truly necessary."
            : `This is Lily's first reply to this contact. Introduce yourself once as Lily, ${ownerName}'s assistant.`;
        const systemPrompt = await require('./prompt-store').renderPrompt('wa_secretary_fallback', { ownerName, languageLabel, 'presence.label': presence.label, 'presence.note': presence.note, introductionRule }, fetchPromptSnapshot);

        const fullPrompt = `${systemPrompt}\n\nFriend's message: ${prompt}`;
        return await generateGeminiText(GEMINI_CHAT_MODEL, fullPrompt, 'chat');
    } catch (e) {
        console.error("Secretary Flash Error:", e);
        return getChatRateLimitReply(false, language);
    }
}

async function setChatPresence(chatId, state = 'typing') {
    try {
        const chat = await client.getChatById(chatId);
        if (!chat) return false;

        if (state === 'recording') {
            await chat.sendStateRecording();
        } else {
            await chat.sendStateTyping();
        }
        return true;
    } catch (error) {
        console.warn(`[WA PRESENCE] Could not set ${state} state for ${chatId}:`, error.message || error);
        return false;
    }
}

function deterministicReplyFraction(value) {
    const digest = crypto.createHash('sha256').update((value || '').toString()).digest();
    return digest[0] / 255;
}

function isOperationalReply(text) {
    const value = (text || '').toString();
    return /```|https?:\/\/|\b(?:ID|status|action|amount|filename|task)\s*:/i.test(value)
        || value.split('\n').length > 3;
}

function splitHumanizedReply(text, allowSplit = true) {
    const value = (text || '').toString().trim();
    if (!allowSplit || value.length < 55 || value.length > 420 || isOperationalReply(value)) {
        return value ? [value] : [];
    }
    if (deterministicReplyFraction(value) >= LILY_WA_HUMANIZED_SPLIT_RATE) {
        return [value];
    }

    const candidates = [...value.matchAll(/[.!?](?:\s+|$)/g)]
        .map((match) => Number(match.index || 0) + 1)
        .filter((index) => index >= 28 && index <= Math.min(190, value.length - 18));
    if (!candidates.length) return [value];

    const splitAt = candidates[Math.floor(candidates.length / 2)];
    const first = value.slice(0, splitAt).trim();
    const second = value.slice(splitAt).trim();
    return first && second ? [first, second] : [value];
}

function humanizedTypingDelay(text, operational = false) {
    if (!LILY_WA_HUMANIZED_TIMING_ENABLED) return 0;
    const value = (text || '').toString();
    const range = Math.max(0, LILY_WA_HUMANIZED_MAX_DELAY_MS - LILY_WA_HUMANIZED_MIN_DELAY_MS);
    const readingDelay = Math.min(range, value.length * (operational ? 5 : 11));
    const jitter = Math.round(deterministicReplyFraction(`${value}:delay`) * Math.min(450, range));
    return Math.min(
        LILY_WA_HUMANIZED_MAX_DELAY_MS,
        LILY_WA_HUMANIZED_MIN_DELAY_MS + readingDelay + jitter,
    );
}

async function sendTextViaLoadedReply(chatId, content) {
    try {
        const chat = await client.getChatById(chatId);
        if (!chat) return null;
        const messages = await chat.fetchMessages({ limit: 8 });
        const latestMessage = Array.isArray(messages)
            ? [...messages].reverse().find((message) => message?.id?._serialized)
            : null;
        if (!latestMessage) return null;
        return await latestMessage.reply(content, chatId, { sendSeen: false });
    } catch (error) {
        console.warn('[PROACTIVE] Loaded-message reply fallback failed:', error.message || error);
        return null;
    }
}

async function sendHumanizedText(chatId, text, options = {}) {
    const value = (text || '').toString().trim();
    if (!value) return null;

    const operational = Boolean(options.operational || isOperationalReply(value));
    const chunks = splitHumanizedReply(value, options.allowSplit !== false && !operational);
    const ledgerKey = options.idempotencyKey
        ? outboxDeliveryKey(chatId, options.idempotencyKey)
        : '';
    let ledgerEntry = ledgerKey ? outboxLedger.entries[ledgerKey] : null;
    if (ledgerEntry?.completed) {
        console.log(`[OUTBOX] Skipping completed duplicate delivery ${ledgerKey.slice(0, 10)}.`);
        return { id: { _serialized: ledgerEntry.message_id || `dedupe-${ledgerKey}` } };
    }
    if (ledgerKey && !ledgerEntry) {
        ledgerEntry = {
            profile: WA_PROFILE,
            chat_id: chatId,
            sent_chunks: [],
            completed: false,
            created_at: Date.now(),
            updated_at: Date.now(),
        };
        outboxLedger.entries[ledgerKey] = ledgerEntry;
        saveOutboxLedger();
    }
    let lastSentMessage = null;
    let deliveryChatId = chatId;
    try {
        for (let index = 0; index < chunks.length; index += 1) {
            if (ledgerEntry?.sent_chunks?.includes(index)) continue;
            const chunk = chunks[index];
            await setChatPresence(deliveryChatId);
            const delayMs = humanizedTypingDelay(chunk, operational);
            if (delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            let outgoingChatIds = [deliveryChatId];
            if (options.rememberOwnerChatId) {
                try {
                    const mappings = await client.getContactLidAndPhone([deliveryChatId]);
                    outgoingChatIds = uniqueNonEmpty([
                        deliveryChatId,
                        ...(Array.isArray(mappings) ? mappings : []).flatMap((mapping) => [
                            mapping?.pn,
                            mapping?.lid,
                        ]),
                    ]);
                } catch (error) {
                    console.warn('[PROACTIVE] Could not resolve outgoing chat aliases:', error.message || error);
                }
            }
            const outgoingWaiter = waitForOutgoingProactiveMessage(outgoingChatIds);
            lastSentMessage = await client.sendMessage(deliveryChatId, chunk, {
                waitUntilMsgSent: Boolean(options.waitUntilMsgSent),
            });
            if (!lastSentMessage && outgoingWaiter) {
                lastSentMessage = await outgoingWaiter.promise;
            } else {
                outgoingWaiter?.cancel();
            }
            if (!lastSentMessage && options.allowLoadedReplyFallback) {
                lastSentMessage = await sendTextViaLoadedReply(deliveryChatId, chunk);
            }
            if (!lastSentMessage) {
                throw new Error(`WhatsApp did not create a message for ${deliveryChatId.split('@')[1] || 'unknown target'}.`);
            }
            if (ledgerEntry) {
                ledgerEntry.sent_chunks = [...new Set([...(ledgerEntry.sent_chunks || []), index])];
                ledgerEntry.message_id = (lastSentMessage?.id?._serialized || '').toString();
                ledgerEntry.updated_at = Date.now();
                saveOutboxLedger();
            }
            if (options.rememberOwnerChatId) {
                const actualChatId = normalizeDirectChatId(
                    lastSentMessage?.to
                    || lastSentMessage?.id?.remote
                    || '',
                );
                if (actualChatId) {
                    rememberOwnerChatId(actualChatId);
                }
            }
            if (index < chunks.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 450));
            }
        }
        if (ledgerEntry) {
            ledgerEntry.completed = true;
            ledgerEntry.updated_at = Date.now();
            saveOutboxLedger();
        }
        return lastSentMessage;
    } catch (error) {
        if (ledgerEntry) {
            ledgerEntry.last_error = (error?.message || String(error)).slice(0, 300);
            ledgerEntry.updated_at = Date.now();
            saveOutboxLedger();
        }
        throw error;
    }
}

function enqueueProcessMessages(chatId) {
    const session = sessionStats[chatId];
    if (!session) return Promise.resolve();

    const previous = session.processingPromise || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => processMessages(chatId));
    session.processingPromise = next;
    return next.finally(() => {
        if (session.processingPromise === next) {
            session.processingPromise = null;
        }
    });
}

// Main function called when debounce is met
async function processMessages(chatId) {
    if (!waClientReady) return;
    const session = sessionStats[chatId];
    if (!session || !session.buffer) return;

    const finalMessage = session.buffer.trim();
    let inputFiles = Array.isArray(session.pendingInputFiles) ? session.pendingInputFiles : [];
    const replyLanguage = detectReplyLanguage(finalMessage);
    // Clear buffer to receive the next new messages
    session.buffer = "";
    session.pendingInputFiles = [];
    const isOwner = session.isOwner;
    const hasVoiceMessage = Boolean(session.hasVoiceMessage);
    const voiceInputReady = Boolean(session.voiceInputReady);
    const useStreamVoiceTest = Boolean(LILY_WA_STREAM_VOICE_TEST_ENABLED && isOwner);
    const wantVoiceReply = Boolean((hasVoiceMessage && voiceInputReady) || useStreamVoiceTest);
    const hasIntroduced = session.hasIntroduced;
    const messageMetadata = session.messageMetadata || {};
    const quotedReply = session.quotedReply || null;
    const incomingMessageIds = Array.isArray(session.pendingMessageIds)
        ? [...session.pendingMessageIds]
        : [];
    const ownerReplyGeneration = Number(session.ownerReplyGeneration || 0);
    session.hasVoiceMessage = false;
    session.voiceInputReady = false;
    session.messageMetadata = {};
    session.quotedReply = null;
    session.pendingMessageIds = [];

    updateContactLastMessage(chatId);
    if (isOwner && !hasVoiceMessage && !finalMessage.startsWith('/')) {
        updateOwnerMemory(finalMessage);
    }

    if (hasVoiceMessage && !voiceInputReady) {
        await setChatPresence(chatId);
        await client.sendMessage(chatId, getVoiceMessageUnavailableReply(isOwner, hasIntroduced, replyLanguage));
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }

    // --- NON-OWNER FLOW (SECRETARY MODE) ---
    if (!isOwner) {
        if (IS_PUBLIC_PROFILE) {
            try {
                await setChatPresence(chatId);
                const reply = await sendPublicMessageToCore(
                    chatId,
                    finalMessage,
                    replyLanguage,
                    session.contactDisplayName,
                    quotedReply,
                );
                if (reply) await client.sendMessage(chatId, reply);
            } catch (error) {
                console.error(`Public chat failed for ${chatId}:`, error.message || error);
            }
            return;
        }

        const phoneNumber = getPolicyPhoneNumber(chatId);
        const secretaryAction = phoneNumber ? secretaryConfig.action(phoneNumber) : 'summary_only';
        if (secretaryAction === 'ignore') {
            secretary.receive(chatId, '', { decision: 'hold' });
            return;
        }
        const classification = classifyIncomingMessage(finalMessage, messageMetadata);
        const triageMode = secretaryConfig.settings()?.triage_mode === 'enforce' ? 'enforce' : 'shadow';
        const explicitAction = phoneNumber ? secretaryConfig.explicitAction(phoneNumber) : 'summary_only';
        const route = decideTriageRoute(classification, triageMode, explicitAction, secretaryAction);
        const inboxItem = await pushExternalInboxItem(chatId, finalMessage, {
            policyDecision: classification.decision,
            policyReason: classification.reason,
            priority: classification.priority,
            category: classification.category,
            confidence: classification.confidence,
            triageMode,
        });
        if (inboxItem && inboxItem.categorySource !== 'owner') {
            inboxItem.policyDecision = classification.decision;
            inboxItem.policyReason = classification.reason;
            inboxItem.priority = classification.priority;
            inboxItem.category = classification.category;
            inboxItem.confidence = classification.confidence;
            inboxItem.triageMode = triageMode;
            saveExternalInbox();
        }
        const secretaryCanHandle = secretaryAction === 'secretary'
            && route.allowAutomaticReply && secretary.eligible(chatId);
        if (!secretaryCanHandle && !route.quietNotification) queueInboxNotification(inboxItem);

        if (Number(session.ownerReplyGeneration || 0) !== ownerReplyGeneration) {
            console.log(`[SECRETARY MODE] Owner replied while ${chatId} was being captured; auto-reply cancelled.`);
            session.pendingMessage = "";
            return;
        }

        if (secretaryAction !== 'secretary'
            || contactPolicy.has('secretary_never_reply', phoneNumber)
            || classification.decision !== 'routine') {
            console.log(`[SECRETARY MODE] Held ${chatId}: ${classification.reason}`);
            session.pendingMessage = "";
            secretary.receive(chatId, finalMessage, { decision: 'hold' });
            return;
        }

        secretary.receive(chatId, finalMessage, { decision: classification.decision,
            name: session.contactDisplayName, language: replyLanguage, introduced: session.hasIntroduced });
        return; // Stop here, do not hit Neural Core yet
    }

    const pendingFinanceReply = parsePendingFinanceReply(chatId, finalMessage);
    if (pendingFinanceReply) {
        const commandReply = await executeOwnerCommand(pendingFinanceReply, replyLanguage, chatId);
        if (commandReply) {
            await client.sendMessage(chatId, commandReply);
        }
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }

    const pendingFinanceRevision = await tryRevisePendingFinanceDraft(
        chatId,
        finalMessage,
        replyLanguage,
    );
    if (pendingFinanceRevision.handled) {
        if (pendingFinanceRevision.reply) {
            await client.sendMessage(chatId, pendingFinanceRevision.reply);
        }
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }

    const pendingFileReply = parsePendingFileVesselReply(chatId, finalMessage);
    if (pendingFileReply) {
        const commandReply = await executeOwnerCommand(pendingFileReply, replyLanguage, chatId);
        if (commandReply) {
            await client.sendMessage(chatId, commandReply);
        }
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }
    if (isLikelyFileVesselChoiceReply(finalMessage)) {
        await client.sendMessage(chatId, getLocalizedBridgeText('fileVesselPendingExpired', replyLanguage));
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }
    const ownerCommand = parseOwnerCommand(finalMessage, replyLanguage);
    if (ownerCommand) {
        const commandReply = await executeOwnerCommand(ownerCommand, replyLanguage, chatId);
        if (commandReply) {
            await client.sendMessage(chatId, commandReply);
            session.hasIntroduced = true;
            markContactIntroduced(chatId);
            return;
        }
    }

    const routedIntent = isOwnerMoodControlMessage(finalMessage)
        ? null
        : await classifyOwnerIntent(finalMessage, chatId, replyLanguage, inputFiles);
    if (routedIntent) {
        session.lastRouteDecision = {
            message: finalMessage.slice(0, 240),
            source: routedIntent.source || 'wa_chat_gate',
            intent: routedIntent.intent || 'chat',
            confidence: Number(routedIntent.confidence || 0),
            reason: routedIntent.reason || 'no_action_hint',
        };
    }
    const routedCommand = ownerCommandFromRouterIntent(routedIntent, chatId, finalMessage);
    if (routedCommand) {
        if (routedCommand.type === 'wake_pc') {
            await setChatPresence(chatId);
        }
        const commandReply = await executeOwnerCommand(routedCommand, replyLanguage, chatId);
        if (commandReply) {
            await client.sendMessage(chatId, commandReply);
        }
        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    }

    if (routedIntent && Number(routedIntent.confidence || 0) <= 0) {
        const fallbackCommand = parseFileVesselFollowUpCommand(chatId, finalMessage)
            || parseFinanceTextCommand(finalMessage, chatId);
        if (fallbackCommand) {
            if (fallbackCommand.type === 'wake_pc') {
                await setChatPresence(chatId);
            }
            const commandReply = await executeOwnerCommand(fallbackCommand, replyLanguage, chatId);
            if (commandReply) {
                await client.sendMessage(chatId, commandReply);
            }
            session.hasIntroduced = true;
            markContactIntroduced(chatId);
            return;
        }
    }

    if (isOwner && !inputFiles.length) {
        const cachedPdf = getCachedOwnerPdf(chatId);
        if (cachedPdf && isPdfFollowUpInstruction(finalMessage)) {
            const consumedPdf = takeCachedOwnerPdf(chatId);
            if (consumedPdf) {
                inputFiles = [consumedPdf];
            }
        }
    }
    const restorePendingPdf = () => {
        if (!isOwner || !inputFiles.length) return;
        cacheOwnerPdfAttachment(chatId, inputFiles[0]);
    };

    // --- OWNER FLOW (NEURAL CORE & WOL) ---
    const useOpenClawRoute = isOpenClawRequestMessage(finalMessage) || inputFiles.length > 0;
    if (useOpenClawRoute && !isCommandWhitelisted(finalMessage, isOwner, inputFiles.length > 0)) {
        restorePendingPdf();
        await client.sendMessage(chatId, getLocalizedBridgeText('whitelistBlocked', replyLanguage));
        return;
    }

    console.log(`Sending to Neural Core: [${chatId}] - ${finalMessage}`);
    session.lastOwnerTextRequest = finalMessage;

    try {
        await setChatPresence(chatId);
        const coreReply = await sendOwnerMessageToCore(
            chatId,
            finalMessage,
            useOpenClawRoute,
            replyLanguage,
            inputFiles,
            wantVoiceReply,
            useStreamVoiceTest ? 'stream_voice' : '',
            quotedReply,
        );
        const replyText = coreReply.text || "";

        if (wantVoiceReply && coreReply.audio) {
            const audioUrl = resolveCoreMediaUrl(coreReply.audio);
            const { MessageMedia } = require('whatsapp-web.js');
            const media = await MessageMedia.fromUrl(audioUrl, { unsafeMime: true });

            await setChatPresence(chatId, 'recording');
            await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
        } else {
            await sendHumanizedText(chatId, replyText, {
                operational: Boolean(coreReply.important),
                allowSplit: false,
                idempotencyKey: incomingMessageIds.join('|') || '',
            });
        }

        session.hasIntroduced = true;
        markContactIntroduced(chatId);
        return;
    } catch (error) {
        console.error("Lily Neural Core request failed. Falling back to backup owner chat mode.", error);
        restorePendingPdf();
        // Only connection failures known to precede processing may use local WoL.
        // A timeout or lost response could mean Core already executed the action.
        const offlineWake = !inputFiles.length && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)
            ? parseWakePcCommand(finalMessage) : null;
        if (offlineWake) {
            const reply = await executeOwnerCommand(offlineWake, replyLanguage, chatId);
            if (reply) await client.sendMessage(chatId, reply);
            session.hasIntroduced = true;
            markContactIntroduced(chatId);
            return;
        }
    }

    const needsCoreFallback = useOpenClawRoute || await needsNeuralCore(finalMessage);
    if (!needsCoreFallback) {
        try {
            await setChatPresence(chatId);
            const replyText = await askOwnerTextOnlyFlash(finalMessage, replyLanguage);
            await sendHumanizedText(chatId, replyText, { allowSplit: false });
            session.hasIntroduced = true;
            markContactIntroduced(chatId);
        } catch (error) {
            console.error("Owner text-only mode failed:", error);
            await client.sendMessage(chatId, getLocalizedBridgeText('ownerCannotAnswer', replyLanguage));
        }
        return;
    }

    restorePendingPdf();
    await client.sendMessage(chatId, getCoreUnavailableReply(replyLanguage));
}

async function processSecretaryAutoReply(chatId) {
    return secretary.flush(chatId);
}

function cancelSecretaryAutoReply(chatId) {
    const session = sessionStats[chatId];
    if (!session) return;

    if (session.autoReplyTimer) {
        clearTimeout(session.autoReplyTimer);
        session.autoReplyTimer = null;
    }

    session.pendingMessage = "";
    session.buffer = "";
}

function shouldSkipDuplicateIncomingMessage(messageId) {
    const normalizedId = (messageId || '').toString().trim();
    if (!normalizedId) return false;

    const now = Date.now();
    const previousSeenAt = Number(incomingMessageSeenAt.get(normalizedId) || 0);
    if (previousSeenAt && now - previousSeenAt < INCOMING_MESSAGE_DEDUPE_TTL_MS) {
        console.warn(`[WA DEDUPE] Skipping replayed incoming message ...${normalizedId.slice(-12)}`);
        return true;
    }

    incomingMessageSeenAt.set(normalizedId, now);
    const cutoff = now - INCOMING_MESSAGE_DEDUPE_TTL_MS;
    for (const [seenId, seenAt] of incomingMessageSeenAt) {
        if (seenAt < cutoff) incomingMessageSeenAt.delete(seenId);
    }
    while (incomingMessageSeenAt.size > 5000) {
        const oldestId = incomingMessageSeenAt.keys().next().value;
        if (!oldestId) break;
        incomingMessageSeenAt.delete(oldestId);
    }
    return false;
}

function savePublicProfileIdentity() {
    const number = normalizeInternationalNumber(client.info?.wid?.user || '');
    if (!number) {
        console.warn('[PROFILE ISOLATION] Public profile number was unavailable after ready.');
        return;
    }

    atomicWriteJson(PUBLIC_PROFILE_IDENTITY_PATH, {
        version: 1,
        number,
        updated_at: new Date().toISOString(),
    });
}

function isDedicatedPublicProfileNumber(number) {
    if (!IS_PERSONAL_PROFILE || !number) return false;
    try {
        if (!fs.existsSync(PUBLIC_PROFILE_IDENTITY_PATH)) return false;
        const identity = JSON.parse(fs.readFileSync(PUBLIC_PROFILE_IDENTITY_PATH, 'utf8'));
        return normalizeInternationalNumber(identity?.number) === normalizeInternationalNumber(number);
    } catch (error) {
        console.warn('[PROFILE ISOLATION] Could not read public profile identity:', error.message || error);
        return false;
    }
}

client.on('message', async (msg) => {
    if (!waClientReady) return;
    // Ignore group or status messages
    if (msg.from === 'status@broadcast' || msg.id.participant) return;

    const incomingMessageId = (msg.id?._serialized || '').toString().trim();
    if (shouldSkipDuplicateIncomingMessage(incomingMessageId)) return;
    if (IS_PERSONAL_PROFILE) inboxReview.incoming(msg.from);

    const ownerNumber = process.env.OWNER_NUMBER;
    let contact = null;
    try {
        contact = await msg.getContact();
    } catch (contactError) {
        console.error(`Failed to resolve contact identity for ${msg.from}:`, contactError);
    }

    const resolvedPhoneIdentities = await resolveLidPhoneIdentities(msg.from);
    const isOwner = matchesConfiguredNumber(msg.from, ownerNumber, contact, resolvedPhoneIdentities);
    const isVoiceMessage = msg.type === 'ptt' || msg.type === 'audio';
    let textBody = (msg.body || '').trim();
    let replyLanguage = detectReplyLanguage(textBody);

    const cachedInboxPhone = externalInbox.find((item) => item.chatId === msg.from)?.phoneNumber || '';
    const senderNumber = verifiedDirectPhoneNumber(msg.from, contact,
        [...resolvedPhoneIdentities, cachedInboxPhone], getContactProfile(msg.from)?.phoneNumber || '');
    if (isDedicatedPublicProfileNumber(senderNumber)) {
        console.log(`[PROFILE ISOLATION] Ignoring sibling public-profile message: ${msg.from}`);
        return;
    }
    if (IS_PERSONAL_PROFILE && !isOwner) {
        await secretaryConfig.refresh();
        if (secretaryConfig.action(senderNumber) === 'ignore') return;
    }
    if (isOwner) {
        recordOwnerEngagement(senderNumber, msg.from);
    }

    const chatId = msg.from;
    const body = msg.body;
    const profile = linkContactProfilePhone(chatId, senderNumber);
    const senderDisplayName = await resolveContactDisplayName(chatId, profile, {
        contact,
        phoneNumber: senderNumber,
    });

    if (!sessionStats[chatId]) {
        sessionStats[chatId] = {
            buffer: "",
            timer: null,
            processingPromise: null,
            autoReplyTimer: null,
            pendingMessage: "",
            messageCount: 0,
            lastRouteDecision: null,
            lastOwnerTextRequest: "",
            isOwner: isOwner, // Tag the session as Owner or Friend
            contactPhoneNumber: senderNumber,
            hasVoiceMessage: false,
            voiceInputReady: false,
            hasIntroduced: Boolean(profile?.introduced),
            pendingInputFiles: [],
            messageMetadata: {},
            ownerReplyGeneration: 0,
            contactDisplayName: senderDisplayName,
            quotedReply: null,
            pendingMessageIds: [],
        };
    }

    const session = sessionStats[chatId];
    session.isOwner = isOwner;
    session.contactPhoneNumber = senderNumber || session.contactPhoneNumber || '';
    session.contactDisplayName = senderDisplayName || session.contactDisplayName || '';
    if (!Array.isArray(session.pendingMessageIds)) session.pendingMessageIds = [];
    session.messageMetadata = {
        isForwarded: Boolean(session.messageMetadata?.isForwarded || msg.isForwarded),
        forwardingScore: Math.max(Number(session.messageMetadata?.forwardingScore || 0), Number(msg.forwardingScore || 0)),
        links: [...(Array.isArray(session.messageMetadata?.links) ? session.messageMetadata.links : []), ...(Array.isArray(msg.links) ? msg.links : [])],
    };
    const quotedReply = await resolveQuotedReply(msg);
    if (quotedReply) session.quotedReply = quotedReply;
    if (incomingMessageId && !session.pendingMessageIds.includes(incomingMessageId)) {
        session.pendingMessageIds.push(incomingMessageId);
    }
    let voiceWasTranscribed = false;

    if (isOwner && isVoiceMessage) {
        session.hasVoiceMessage = true;
        const transcription = await transcribeWaVoiceMessage(msg, replyLanguage);
        if (transcription.ok && transcription.text) {
            textBody = transcription.text;
            replyLanguage = detectReplyLanguage(textBody);
            voiceWasTranscribed = true;
            session.voiceInputReady = true;
            console.log(`[STT] Owner voice message transcribed (${transcription.durationSeconds || 0}s): ${textBody.slice(0, 120)}`);
        } else {
            console.warn(`[STT] Owner voice message was not transcribed: ${transcription.detail || 'unknown error'}`);
        }
    }

    if (isOwner && msg.hasMedia && !isVoiceMessage) {
        const financeImageOutcome = await extractOwnerFinanceImageAttachment(msg, chatId, replyLanguage, textBody);
        if (financeImageOutcome.handled) {
            if (financeImageOutcome.reply) {
                await client.sendMessage(chatId, financeImageOutcome.reply);
            }
            return;
        }

        const attachmentOutcome = await extractOwnerPdfAttachment(msg, chatId, replyLanguage);
        if (attachmentOutcome.stopProcessing) {
            if (attachmentOutcome.reply) {
                await client.sendMessage(chatId, attachmentOutcome.reply);
            }
            return;
        }

        if (attachmentOutcome.inputFile) {
            if (textBody) {
                session.pendingInputFiles = [attachmentOutcome.inputFile];
            } else {
                cacheOwnerPdfAttachment(chatId, attachmentOutcome.inputFile);
                await client.sendMessage(chatId, getLocalizedBridgeText('pdfStoredWaitingInstruction', replyLanguage));
                return;
            }
        }
    }
    
    // Combine messages
    if (isVoiceMessage && !voiceWasTranscribed) {
        session.buffer += "[voice message]. ";
    } else {
        session.buffer += textBody ? `${textBody}. ` : (isVoiceMessage ? "[voice message]. "
            : (msg.type === 'sticker' ? "[sticker]. " : "[document attachment]. "));
    }

    // Remove old timer if the user keeps typing
    if (session.timer) clearTimeout(session.timer);

    // Secretary timing starts from the latest incoming message.
    const waitTime = 0;

    if (waitTime > 0) {
        console.log(`Message buffered. Waiting ${waitTime/1000} seconds...`);
    } else {
        console.log(`Processing ${WA_PROFILE} message immediately for ${chatId}.`);
    }

    // Set a new timer
    session.timer = setTimeout(() => {
        session.messageCount++; // Increment message log history to trigger Voice Note
        void enqueueProcessMessages(chatId).catch((error) => {
            console.error(`Failed to process WhatsApp message for ${chatId}:`, error);
        });
    }, waitTime);
});

client.on('message_create', async (msg) => {
    if (!waClientReady) return;
    if (!msg.fromMe) return;
    if (msg.to === 'status@broadcast' || msg.id.participant) return;

    captureOutgoingProactiveMessage(msg);
    const chatId = msg.to || msg.from;
    if (!chatId) return;
    if (secretary.isOwnReply(chatId, msg.body)) return;
    inboxReview.ownerReplied(chatId);
    const handledInboxItem = externalInbox.find(item => item.chatId === chatId);
    if (handledInboxItem && inboxDelivery) {
        try { inboxDelivery.cancel(handledInboxItem.id); }
        catch { console.warn("[INBOX] Could not persist reminder cancellation."); }
    }
    secretary.ownerReplied(chatId);

    const session = sessionStats[chatId];
    if (session) {
        session.ownerReplyGeneration = Number(session.ownerReplyGeneration || 0) + 1;
    }
    cancelSecretaryAutoReply(chatId);
    console.log(`[SECRETARY MODE] Owner replied to ${chatId}. Auto-reply cancelled.`);
});

client.on('message_ack', (msg, ack) => {
    recordProactiveAck(msg, ack);
});

startBridgeControlServer();
startWaRuntimeReporting();
client.initialize().catch((error) => {
    updateWaClientState('initialization_failed');
    void reportWaRuntime();
    console.error('Lily WA client initialization failed:', error);
    setTimeout(() => process.exit(1), 1000);
});
