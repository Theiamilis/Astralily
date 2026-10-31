import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { readPrivateModelContext } from './modelAssignment'
import { browserCoreCsrf, browserCoreUrl } from './browserSession'

export type Sender = 'user' | 'lily'

export type ChatMessage = {
  sender: Sender
  text: string
  timestamp?: string
}

export type RealmMoodId = 'heart' | 'smile' | 'talk' | 'crown' | 'tune'

export type RealmMood = {
  id: RealmMoodId
  label: string
  title: string
  promptHint: string
}

export type RealmLanguageId = 'id' | 'ja' | 'en'
export type RealmEnglishVoiceProfileId = 'zeta_en' | 'watson_en'
export type RealmVoiceRouteId = 'sovits' | 'sovits2' | 'rvc' | 'alibaba'
export type RealmAddressTermId =
  | 'sayang'
  | 'cintaku'
  | 'beb'
  | 'love'
  | 'darling'
  | 'dear'
  | 'anata'
  | 'kimi'

export type RealmLanguage = {
  id: RealmLanguageId
  label: string
  title: string
  voiceProfile: string
  speechLang: string
  promptHint: string
}

export type VoiceQueueHealth = {
  waiting?: number
  active?: boolean
  last_error?: string
  last_mode?: string
}

export type ComponentHealth = {
  status?: string
  detail?: string
  mode?: string
  provider?: string
  queue?: VoiceQueueHealth
  remote_queue?: VoiceQueueHealth
  health_url?: string
}

export type HealthPayload = {
  status?: string
  components?: Record<string, ComponentHealth>
  owner_presence?: OwnerPresence
  owner_mood?: OwnerMood
}

export type OwnerMood = {
  mood?: string
  intensity?: number
  expression?: string
  updated_at?: number
}

export type OwnerPresenceStatus = 'available' | 'busy' | 'at_office' | 'sleeping' | 'gaming' | 'away'

export type OwnerPresence = {
  status: OwnerPresenceStatus | string
  label?: string
  note?: string
  source?: string
  updated_at?: string
  expires_at?: string | null
  active?: boolean
}

export type RealmStatusTone = 'good' | 'warn' | 'bad'

export type RealmVoiceStatusId =
  | 'ready'
  | 'text-only'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'voice-unavailable'

export type RealmVoiceStatus = {
  id: RealmVoiceStatusId
  label: string
  detail: string
  tone: RealmStatusTone
}

export type RealmHealthSummary = {
  coreLabel: string
  brainLabel: string
  voiceLabel: string
  detail: string
  coreTone: RealmStatusTone
  brainTone: RealmStatusTone
  voiceTone: RealmStatusTone
}

export type RealmExpressionResolution = {
  requested: string
  resolved: string
  source: 'direct' | 'alias' | 'idle_fallback' | 'first_fallback'
}

export type RealmVoiceProfileOption = {
  id: RealmEnglishVoiceProfileId
  label: string
  title: string
}

type RealmCapabilitiesPayload = {
  voice_routes?: Record<string, {
    label?: string
    detail?: string
    languages?: string[]
    emotion_mode?: 'native' | 'metadata_only'
    style_mode?: 'native' | 'metadata_only'
  }>
  stt?: {
    vad?: {
      enabled?: boolean
      mode?: string
      silence_ms?: number
      start_timeout_ms?: number
    }
  }
  voice_contract?: {
    request_fields?: string[]
    metadata_fields?: string[]
    strict_routes?: string[]
  }
  address_terms?: Record<string, RealmAddressTermOption[]>
}

export type RealmVoiceRouteOption = {
  id: RealmVoiceRouteId
  label: string
  title: string
}

export type RealmAddressTermOption = {
  id: RealmAddressTermId
  label: string
  spoken: string
  detail: string
  romaji?: string
}

export type RealmPresenceOption = {
  id: OwnerPresenceStatus
  label: string
  title: string
}

export const REALM_MOODS: RealmMood[] = [
  {
    id: 'heart',
    label: 'Heart',
    title: 'Affection mode',
    promptHint: 'Reply with extra warmth, reassurance, and soft affection.',
  },
  {
    id: 'smile',
    label: 'Smile',
    title: 'Bright mode',
    promptHint: 'Reply in a cheerful, light, optimistic tone.',
  },
  {
    id: 'talk',
    label: 'Talk',
    title: 'Conversation mode',
    promptHint: 'Reply naturally as a relaxed desktop companion.',
  },
  {
    id: 'crown',
    label: 'Crown',
    title: 'Confident mode',
    promptHint: 'Reply with playful confidence and gentle bossy-cute energy.',
  },
  {
    id: 'tune',
    label: 'Tune',
    title: 'Voice mode',
    promptHint: 'Reply with a voice-first feel, concise and easy to speak aloud.',
  },
]

export const REALM_LANGUAGES: RealmLanguage[] = [
  {
    id: 'id',
    label: 'ID',
    title: 'Indonesian',
    voiceProfile: 'id',
    speechLang: 'id-ID',
    promptHint: 'Reply in natural Indonesian. Keep Lily warm, playful, and concise.',
  },
  {
    id: 'ja',
    label: 'JP',
    title: 'Japanese',
    voiceProfile: 'ja',
    speechLang: 'ja-JP',
    promptHint: 'Reply in natural Japanese. Keep Lily warm, playful, and concise.',
  },
  {
    id: 'en',
    label: 'EN',
    title: 'English',
    voiceProfile: 'en',
    speechLang: 'en-US',
    promptHint: 'Reply in natural English. Keep Lily warm, playful, and concise.',
  },
]

export const REALM_ENGLISH_VOICE_OPTIONS: RealmVoiceProfileOption[] = [
  {
    id: 'zeta_en',
    label: 'Zeta',
    title: 'Soft and airy',
  },
  {
    id: 'watson_en',
    label: 'Watson',
    title: 'Clear and lively',
  },
]

export const REALM_VOICE_ROUTE_OPTIONS: RealmVoiceRouteOption[] = [
  { id: 'sovits', label: 'SoVITS', title: 'Local GPT-SoVITS voice' },
  { id: 'sovits2', label: 'SoVITS 2', title: 'Dedicated second GPT-SoVITS vessel' },
  { id: 'rvc', label: 'RVC', title: 'Stream voice vessel with RVC' },
  { id: 'alibaba', label: 'Alibaba', title: 'Qwen cloned voice route' },
]

export const REALM_ADDRESS_TERM_OPTIONS: Record<RealmLanguageId, RealmAddressTermOption[]> = {
  id: [
    { id: 'sayang', label: 'Sayang', spoken: 'sayang', detail: 'Natural and warm' },
    { id: 'cintaku', label: 'Cintaku', spoken: 'cintaku', detail: 'More romantic' },
    { id: 'beb', label: 'Beb', spoken: 'beb', detail: 'Casual and playful' },
  ],
  en: [
    { id: 'love', label: 'Love', spoken: 'love', detail: 'Natural and warm' },
    { id: 'darling', label: 'Darling', spoken: 'darling', detail: 'Romantic' },
    { id: 'dear', label: 'Dear', spoken: 'dear', detail: 'Soft and gentle' },
  ],
  ja: [
    { id: 'darling', label: 'ダーリン', spoken: 'ダーリン', detail: 'Romantic; natural TTS spelling', romaji: 'dārin' },
    { id: 'anata', label: 'あなた', spoken: 'あなた', detail: 'Intimate, spouse-like', romaji: 'anata' },
    { id: 'kimi', label: '君', spoken: '君', detail: 'Close and casual', romaji: 'kimi' },
  ],
}

export const REALM_PRESENCE_OPTIONS: RealmPresenceOption[] = [
  { id: 'available', label: 'Available', title: 'No special activity hint' },
  { id: 'busy', label: 'Busy', title: 'Keep replies concise' },
  { id: 'at_office', label: 'Office', title: 'Work mode, stay focused' },
  { id: 'sleeping', label: 'Sleep', title: 'Calm and low-interruption' },
  { id: 'gaming', label: 'Gaming', title: 'Short and actionable replies' },
  { id: 'away', label: 'Away', title: 'Hold non-urgent detail' },
]

const API_BASE = (import.meta.env.VITE_LILY_API_URL || '').replace(/\/$/, '')
const ownerHeaders = {}

function apiPath(path: string) {
  return browserCoreUrl(`${API_BASE}${path}`)
}

function mediaPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

function startLipSyncMeter(audio: HTMLAudioElement, onLevel: (level: number) => void) {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let frameId = 0

  if (!AudioContextCtor) {
    const start = window.performance.now()
    const tick = () => {
      onLevel(audio.paused || audio.ended ? 0 : 0.16 + Math.abs(Math.sin((window.performance.now() - start) / 90)) * 0.24)
      frameId = window.requestAnimationFrame(tick)
    }
    tick()
    return () => {
      window.cancelAnimationFrame(frameId)
      onLevel(0)
    }
  }

  try {
    const context = new AudioContextCtor()
    const source = context.createMediaElementSource(audio)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    const samples = new Uint8Array(analyser.fftSize)
    source.connect(analyser)
    analyser.connect(context.destination)

    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      let total = 0
      for (let index = 0; index < samples.length; index += 1) {
        const value = ((samples[index] ?? 128) - 128) / 128
        total += value * value
      }
      const rms = Math.sqrt(total / samples.length)
      onLevel(audio.paused || audio.ended ? 0 : Math.min(1, rms * 3.8))
      frameId = window.requestAnimationFrame(tick)
    }

    void context.resume().catch(() => undefined)
    tick()

    return () => {
      window.cancelAnimationFrame(frameId)
      source.disconnect()
      analyser.disconnect()
      void context.close().catch(() => undefined)
      onLevel(0)
    }
  } catch (error) {
    console.warn('Falling back to synthetic Live2D lip sync meter:', error)
    const start = window.performance.now()
    const tick = () => {
      onLevel(audio.paused || audio.ended ? 0 : 0.18 + Math.abs(Math.sin((window.performance.now() - start) / 86)) * 0.26)
      frameId = window.requestAnimationFrame(tick)
    }
    tick()
    return () => {
      window.cancelAnimationFrame(frameId)
      onLevel(0)
    }
  }
}

function getOrCreateUserId(): string {
  const key = 'lily_private_realm_user_id'
  const existing = localStorage.getItem(key)
  if (existing) return existing

  const randomId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const id = `private_realm_${randomId}`
  localStorage.setItem(key, id)
  return id
}

function readLanguagePreference(): RealmLanguageId {
  const value = localStorage.getItem('lily_private_realm_language')
  return value === 'en' || value === 'id' ? value : 'ja'
}

function readAddressTermPreference(): RealmAddressTermId {
  const value = localStorage.getItem('lily_private_realm_address_term')
  return REALM_ADDRESS_TERM_OPTIONS.id.concat(REALM_ADDRESS_TERM_OPTIONS.en, REALM_ADDRESS_TERM_OPTIONS.ja).some((option) => option.id === value)
    ? (value as RealmAddressTermId)
    : 'darling'
}

function readEnglishVoiceProfilePreference(): RealmEnglishVoiceProfileId {
  return localStorage.getItem('lily_private_realm_en_voice_profile') === 'watson_en' ? 'watson_en' : 'zeta_en'
}

function readVoiceRoutePreference(): RealmVoiceRouteId {
  const value = localStorage.getItem('lily_private_realm_voice_route')
  return REALM_VOICE_ROUTE_OPTIONS.some((option) => option.id === value)
    ? (value as RealmVoiceRouteId)
    : 'sovits'
}

function nowTimestamp() {
  return new Date().toISOString()
}

function parseLilyResponse(raw: unknown): string {
  if (typeof raw !== 'string') return ''

  try {
    const parsed = JSON.parse(raw)
    return parsed.voice_response || parsed.text || raw
  } catch {
    return raw
  }
}

function expressionFromEmotion(emotion?: string, moodId: RealmMoodId = 'talk') {
  if (emotion?.trim().toLowerCase() === 'happy') {
    if (moodId === 'heart') return 'Soft Love'
    if (moodId === 'smile') return 'Sparkle Mood'
  }

  switch (emotion?.trim().toLowerCase()) {
    case 'warning':
    case 'angry':
      return 'Angry'
    case 'happy':
      return 'Love'
    case 'sad':
      return 'Gloomy'
    case 'neutral':
      return 'Blush'
    default:
      return ''
  }
}

function normalizeHistory(rows: Array<Record<string, unknown>>): ChatMessage[] {
  return rows.flatMap((row) => {
    const timestamp = String(row.timestamp || '')
    const userMessage = String(row.user_message || '').trim()
    const botResponse = String(row.bot_response || '').trim()
    const messages: ChatMessage[] = []

    if (userMessage) {
      messages.push({ sender: 'user', text: userMessage, timestamp })
    }
    if (botResponse) {
      messages.push({ sender: 'lily', text: botResponse, timestamp })
    }
    return messages
  })
}

export function statusLabel(status?: string) {
  if (!status) return 'checking'
  if (status === 'ok') return 'online'
  if (status === 'degraded') return 'standby'
  return status
}

function componentTone(status?: string, fallback: RealmStatusTone = 'warn'): RealmStatusTone {
  if (!status) return fallback
  if (['ok', 'online', 'ready', 'active', 'connected'].includes(status)) return 'good'
  if (['offline', 'error', 'failed', 'unavailable', 'timeout'].includes(status)) return 'bad'
  return 'warn'
}

function componentLabel(status?: string) {
  if (!status) return 'checking'
  if (['ok', 'online', 'ready', 'active', 'connected'].includes(status)) return 'online'
  if (['offline', 'error', 'failed', 'unavailable', 'timeout'].includes(status)) return 'offline'
  if (status === 'degraded') return 'standby'
  if (status === 'busy') return 'busy'
  return status
}

function preferredVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/webm',
  ]
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ''
}

const VOICE_VAD_THRESHOLD = 0.028
const VOICE_VAD_SILENCE_MS = 1_100
const VOICE_VAD_START_TIMEOUT_MS = 6_000

function startVoiceVad(
  stream: MediaStream,
  onSpeechDetected: () => void,
  onSilenceDetected: (hadSpeech: boolean) => void,
) {
  const audioContextConstructor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!audioContextConstructor) return null

  const context = new audioContextConstructor()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.2
  source.connect(analyser)
  void context.resume()

  const samples = new Float32Array(analyser.fftSize)
  const startedAt = performance.now()
  let lastSpeechAt = 0
  let hadSpeech = false
  let active = true
  let frameId = 0

  const tick = () => {
    if (!active) return
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    const rms = Math.sqrt(sum / samples.length)
    const now = performance.now()

    if (rms >= VOICE_VAD_THRESHOLD) {
      if (!hadSpeech) onSpeechDetected()
      hadSpeech = true
      lastSpeechAt = now
    }

    const silenceReached = hadSpeech && now - lastSpeechAt >= VOICE_VAD_SILENCE_MS
    const startTimedOut = !hadSpeech && now - startedAt >= VOICE_VAD_START_TIMEOUT_MS
    if (silenceReached || startTimedOut) {
      active = false
      onSilenceDetected(hadSpeech)
      return
    }
    frameId = window.requestAnimationFrame(tick)
  }

  frameId = window.requestAnimationFrame(tick)
  return () => {
    active = false
    window.cancelAnimationFrame(frameId)
    source.disconnect()
    analyser.disconnect()
    void context.close()
  }
}

function voiceFileExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('ogg')) return 'ogg'
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a'
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  return 'webm'
}

export function usePrivateRealm() {
  const userId = useMemo(getOrCreateUserId, [])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [health, setHealth] = useState<HealthPayload | null>(null)
  const [capabilities, setCapabilities] = useState<RealmCapabilitiesPayload | null>(null)
  const [lastSync, setLastSync] = useState('offline')
  const [chatMode, setChatMode] = useState('Private Realm')
  const [chatError, setChatError] = useState('')
  const [activeMoodId, setActiveMoodId] = useState<RealmMoodId>('talk')
  const [activeLanguageId, setActiveLanguageId] = useState<RealmLanguageId>(() => readLanguagePreference())
  const [addressTermId, setAddressTermId] = useState<RealmAddressTermId>(() => readAddressTermPreference())
  const [englishVoiceProfile, setEnglishVoiceProfile] = useState<RealmEnglishVoiceProfileId>(() => readEnglishVoiceProfilePreference())
  const [voiceRoute, setVoiceRoute] = useState<RealmVoiceRouteId>(() => readVoiceRoutePreference())
  const [ownerPresence, setOwnerPresence] = useState<OwnerPresence>({
    status: 'available',
    label: 'Available',
    note: 'Owner is available.',
    active: false,
  })
  const [isPresenceUpdating, setIsPresenceUpdating] = useState(false)
  const [isVoiceListening, setIsVoiceListening] = useState(false)
  const [isVoiceTranscribing, setIsVoiceTranscribing] = useState(false)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [latestEmotion, setLatestEmotion] = useState<string | null>(null)
  const [latestExpression, setLatestExpression] = useState<string | null>(null)
  const [latestExpressionKey, setLatestExpressionKey] = useState<string | number | null>(null)
  const [latestExpressionSource, setLatestExpressionSource] = useState<string | null>(null)
  const [moodExpression, setMoodExpression] = useState('Blush')
  const [expressionResolution, setExpressionResolutionState] = useState<RealmExpressionResolution | null>(null)
  const [lipSyncLevel, setLipSyncLevel] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceSessionRef = useRef(0)
  const voiceStopRequestedRef = useRef(false)
  const voiceCancelledRef = useRef(false)
  const audioMeterCleanupRef = useRef<(() => void) | null>(null)
  const voiceVadCleanupRef = useRef<(() => void) | null>(null)
  const voiceVadAutoStopNoSpeechRef = useRef(false)

  const activeMood = useMemo(() => {
    const mood = REALM_MOODS.find((item) => item.id === activeMoodId) || REALM_MOODS[2]
    if (mood.id !== 'talk') return mood

    return {
      ...mood,
      title: isVoiceListening
        ? 'Listening for voice'
        : isVoiceTranscribing
          ? 'Transcribing voice'
          : 'Voice standby',
    }
  }, [activeMoodId, isVoiceListening, isVoiceTranscribing])

  const activeLanguage = useMemo(() => {
    const language = REALM_LANGUAGES.find((item) => item.id === activeLanguageId) || REALM_LANGUAGES[0]
    if (language.id !== 'en') {
      return language
    }
    return {
      ...language,
      voiceProfile: englishVoiceProfile,
    }
  }, [activeLanguageId, englishVoiceProfile])

  const activeEnglishVoiceOption = useMemo(() => {
    return REALM_ENGLISH_VOICE_OPTIONS.find((item) => item.id === englishVoiceProfile) || REALM_ENGLISH_VOICE_OPTIONS[0]
  }, [englishVoiceProfile])

  const components = health?.components || {}
  const availableVoiceRouteOptions = useMemo(() => {
    const configured = Object.keys(capabilities?.voice_routes || {})
    const options = REALM_VOICE_ROUTE_OPTIONS.filter((option) => configured.length === 0 || configured.includes(option.id))
    return options.length ? options : REALM_VOICE_ROUTE_OPTIONS
  }, [capabilities])
  const availableAddressTermOptions = useMemo(() => {
    const serverOptions = capabilities?.address_terms?.[activeLanguageId]
    return serverOptions?.length ? serverOptions : REALM_ADDRESS_TERM_OPTIONS[activeLanguageId]
  }, [activeLanguageId, capabilities])
  const voiceComponent = components.voice
  const voiceQueue = voiceComponent?.queue || {}
  const remoteVoiceQueue = voiceComponent?.remote_queue || {}
  const voiceQueueWaiting = Number(voiceQueue.waiting || 0) + Number(remoteVoiceQueue.waiting || 0)
  const voiceQueueActive = Boolean(voiceQueue.active || remoteVoiceQueue.active)
  const coreTone: RealmStatusTone = health?.status === 'ok' ? 'good' : health ? 'warn' : 'bad'
  const voiceTone = componentTone(voiceComponent?.status, health ? 'warn' : 'bad')
  const brainTone = componentTone(components.brain?.status, health ? 'warn' : 'bad')
  const latestLilyLine = useMemo(() => {
    return [...messages].reverse().find((message) => message.sender === 'lily')?.text
  }, [messages])

  const voiceStatus = useMemo<RealmVoiceStatus>(() => {
    if (isVoiceListening) {
      return {
        id: 'listening',
        label: 'Listening',
        detail: 'Speak naturally; Lily stops after a short silence and transcribes it.',
        tone: 'good',
      }
    }

    if (isVoiceTranscribing) {
      return {
        id: 'transcribing',
        label: 'Transcribing',
        detail: 'Lily is turning your recording into text.',
        tone: 'warn',
      }
    }

    if (isSending) {
      return {
        id: 'thinking',
        label: 'Thinking',
        detail: 'Lily is preparing a reply through the active core route.',
        tone: 'warn',
      }
    }

    if (voiceError) {
      return {
        id: 'voice-unavailable',
        label: 'Voice unavailable',
        detail: voiceError,
        tone: 'bad',
      }
    }

    if (!health) {
      return {
        id: 'text-only',
        label: 'Text only',
        detail: 'Core is offline from this room. Lily keeps chat in standby.',
        tone: 'bad',
      }
    }

    if (voiceTone === 'good' && (voiceQueueActive || voiceQueueWaiting > 0)) {
      return {
        id: 'thinking',
        label: 'Voice queue',
        detail: voiceQueueWaiting > 0
          ? `Voice vessel has ${voiceQueueWaiting} request${voiceQueueWaiting === 1 ? '' : 's'} waiting.`
          : 'Voice vessel is rendering audio now.',
        tone: 'warn',
      }
    }

    if (voiceTone === 'good') {
      const route = voiceComponent?.mode === 'remote'
        ? 'Remote voice vessel is online.'
        : 'Local SoVITS path is online.'
      return {
        id: 'ready',
        label: 'Voice ready',
        detail: `${route} Talk works as push-to-talk.`,
        tone: 'good',
      }
    }

    return {
      id: 'text-only',
      label: 'Text only',
      detail: voiceComponent?.detail || 'Core is reachable, but the voice path is not ready yet.',
      tone: 'warn',
    }
  }, [
    health,
    isSending,
    isVoiceListening,
    isVoiceTranscribing,
    voiceComponent?.detail,
    voiceComponent?.mode,
    voiceError,
    voiceQueueActive,
    voiceQueueWaiting,
    voiceTone,
  ])

  const healthSummary = useMemo<RealmHealthSummary>(() => {
    if (!health) {
      return {
        coreLabel: 'offline',
        brainLabel: 'standby',
        voiceLabel: 'standby',
        detail: 'Core is offline, so Lily keeps the room safe in text-only standby.',
        coreTone: 'bad',
        brainTone: 'warn',
        voiceTone: 'warn',
      }
    }

    const voicePath =
      voiceRoute === 'alibaba'
        ? 'Alibaba Qwen cloned voice'
        : voiceRoute === 'rvc'
          ? 'RVC stream voice vessel'
          : voiceComponent?.mode === 'remote'
            ? 'remote GPT-SoVITS vessel'
            : 'local SoVITS path'
    const detail = voiceTone === 'good'
      ? `Core and ${voicePath} are selected, so Lily can reply with chat and voice.`
      : voiceComponent?.detail || 'Core is reachable, but Lily will stay text-first until the voice path reports ready.'

    return {
      coreLabel: statusLabel(health.status),
      brainLabel: componentLabel(components.brain?.status),
      voiceLabel: componentLabel(voiceComponent?.status),
      detail,
      coreTone,
      brainTone,
      voiceTone,
    }
  }, [
    brainTone,
    components.brain?.status,
    coreTone,
    health,
    voiceComponent?.detail,
    voiceComponent?.mode,
    voiceComponent?.status,
    voiceTone,
    voiceRoute,
  ])

  useEffect(() => {
    localStorage.setItem('lily_private_realm_language', activeLanguageId)
  }, [activeLanguageId])

  useEffect(() => {
    localStorage.setItem('lily_private_realm_en_voice_profile', englishVoiceProfile)
  }, [englishVoiceProfile])

  const activeAddressTerm = useMemo(() => {
    const options = availableAddressTermOptions
    return options.find((item) => item.id === addressTermId) || options[0]
  }, [activeLanguageId, addressTermId, availableAddressTermOptions])

  useEffect(() => {
    localStorage.setItem('lily_private_realm_voice_route', voiceRoute)
  }, [voiceRoute])

  useEffect(() => {
    localStorage.setItem('lily_private_realm_address_term', addressTermId)
  }, [addressTermId])

  useEffect(() => {
    let cancelled = false

    async function loadHistory() {
      try {
        const { data } = await axios.get(apiPath('/api/history'), {
          headers: ownerHeaders,
          withCredentials: true,
          params: { user_id: userId, limit: 16 },
        })
        if (!cancelled && Array.isArray(data)) {
          setMessages(normalizeHistory(data))
        }
      } catch {
        // History is optional; Lily can still chat without MongoDB.
      }
    }

    loadHistory()
    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(() => {
    let cancelled = false
    let activeController: AbortController | null = null

    async function pollHealth() {
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller
      const timeoutId = window.setTimeout(() => controller.abort(), 8000)

      try {
        const response = await fetch(apiPath('/health'), { signal: controller.signal, headers: ownerHeaders, credentials: 'include' })
        if (!response.ok) {
          throw new Error(`Health check returned HTTP ${response.status}`)
        }

        const data = await response.json() as HealthPayload
        if (cancelled) return
        setHealth(data)
        try {
          const capabilitiesResponse = await fetch(apiPath('/api/system/capabilities'), {
            signal: controller.signal,
            headers: ownerHeaders,
            credentials: 'include',
          })
          if (capabilitiesResponse.ok) {
            setCapabilities(await capabilitiesResponse.json() as RealmCapabilitiesPayload)
          }
        } catch {
          // Health remains useful when an older Core does not expose capabilities yet.
        }
        if (data.owner_presence?.status) {
          setOwnerPresence(data.owner_presence)
        }
        if (data.owner_mood?.expression) {
          setMoodExpression(data.owner_mood.expression)
          setLatestExpression((current) => current || data.owner_mood?.expression || null)
          setLatestExpressionKey((current) => current || `mood-${data.owner_mood?.updated_at || 'initial'}`)
          setLatestExpressionSource((current) => current || 'owner_mood')
        }
        setLastSync(new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        }))
      } catch {
        if (cancelled || controller.signal.aborted) return
        if (cancelled) return
        setHealth(null)
        setLastSync('offline')
      } finally {
        if (activeController === controller) {
          activeController = null
        }
        window.clearTimeout(timeoutId)
      }
    }

    pollHealth()
    const timer = window.setInterval(pollHealth, 15_000)
    return () => {
      cancelled = true
      activeController?.abort()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isSending])

  useEffect(() => {
    return () => {
      voiceSessionRef.current += 1
      voiceCancelledRef.current = true
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      }
      mediaRecorderRef.current = null
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
      voiceStreamRef.current = null
      stopCurrentVoice()
    }
  }, [])

  function stopCurrentVoice() {
    const audio = audioRef.current

    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.onplaying = null
      audio.onended = null
      audio.onpause = null
    }

    audioMeterCleanupRef.current?.()
    audioMeterCleanupRef.current = null
    voiceVadCleanupRef.current?.()
    voiceVadCleanupRef.current = null
    voiceVadAutoStopNoSpeechRef.current = false
    setLipSyncLevel(0)
    setLatestExpression('Blush')
    setLatestExpressionKey(`voice-stop-${Date.now()}`)
    setExpressionResolutionState(null)
  }

  function setExpressionResolution(resolution: RealmExpressionResolution) {
    setExpressionResolutionState(resolution)
  }

  async function sendMessage(
    textOverride?: string,
    source: 'text' | 'voice' = 'text',
    forceVoiceReply = false,
  ) {
    const text = (textOverride ?? input).trim()
    if (!text || isSending) return

    stopCurrentVoice()
    setInput('')
    setVoiceTranscript('')
    setIsSending(true)
    setChatError('')
    setMessages((prev) => [...prev, { sender: 'user', text, timestamp: nowTimestamp() }])

    try {
      const { data } = await axios.post(apiPath('/api/chat'), {
        user_id: userId,
        message: text,
        want_voice: forceVoiceReply || voiceStatus.id === 'ready',
        context: {
          interface: 'lily_private_realm',
          ui_mood: activeMood.id,
          ui_mood_label: activeMood.label,
          ui_mood_title: activeMood.title,
          language: activeLanguage.id,
          language_label: activeLanguage.title,
          language_prompt_hint: activeLanguage.promptHint,
          voice_language: activeLanguage.id,
          voice_profile: activeLanguage.voiceProfile,
          voice_route: voiceRoute,
          address_term: activeAddressTerm.id,
          input_source: source,
          voice_listening: isVoiceListening,
          voice_status: voiceStatus.id,
          voice_status_label: voiceStatus.label,
          voice_status_detail: voiceStatus.detail,
          owner_presence: ownerPresence,
          chat_mode: chatMode,
          prompt_hint: `${activeLanguage.promptHint} ${activeMood.promptHint}`,
          ...readPrivateModelContext(),
        },
      }, { headers: { 'X-IRIS-CSRF': await browserCoreCsrf() }, withCredentials: true })
      const lilyText = parseLilyResponse(data?.text) || 'Lily is here, but the reply came back empty.'
      const responseEmotion = typeof data?.emotion === 'string' ? data.emotion.trim() : ''
      const responseExpression =
        typeof data?.expression === 'string' && data.expression.trim()
          ? data.expression.trim()
          : expressionFromEmotion(responseEmotion, activeMood.id)
      const responseExpressionSource =
        typeof data?.expression_source === 'string' && data.expression_source.trim()
          ? data.expression_source.trim()
          : responseExpression
            ? 'emotion_inferred'
            : ''
      const responseMoodExpression =
        typeof data?.mood_expression === 'string' && data.mood_expression.trim()
          ? data.mood_expression.trim()
          : ''

      setMessages((prev) => [...prev, { sender: 'lily', text: lilyText, timestamp: nowTimestamp() }])
      if (responseMoodExpression) {
        setMoodExpression(responseMoodExpression)
      }
      const applyResponseExpression = () => {
        if (!responseExpression) return

        setLatestEmotion(responseEmotion || 'neutral')
        setLatestExpression(responseExpression)
        setLatestExpressionKey(Date.now())
        setLatestExpressionSource(responseExpressionSource || 'emotion_inferred')
        setExpressionResolutionState(null)
      }
      setChatError('')

      if (data?.audio && audioRef.current) {
        const audio = audioRef.current
        audio.crossOrigin = 'anonymous'
        audio.src = mediaPath(String(data.audio))

        const stopSpeaking = () => {
          audioMeterCleanupRef.current?.()
          audioMeterCleanupRef.current = null
          setLipSyncLevel(0)
        }

        const startSpeaking = () => {
          applyResponseExpression()
          audioMeterCleanupRef.current = startLipSyncMeter(audio, setLipSyncLevel)
        }

        audio.onplaying = startSpeaking
        audio.onended = stopSpeaking
        audio.onpause = stopSpeaking

        audio.play().catch(() => {
          applyResponseExpression()
          stopSpeaking()
        })
      } else {
        applyResponseExpression()
      }
    } catch (error) {
      const errorMessage = axios.isAxiosError(error) && error.response
        ? `Core replied with ${error.response.status}.`
        : 'Core link is offline.'
      const fallbackText = activeLanguage.id === 'en'
        ? 'The core link is unstable, but Lily is still standing by here.'
        : activeLanguage.id === 'id'
          ? 'Tautan Core sedang tidak stabil, tapi Lily tetap menunggumu di sini.'
          : 'コアへの接続が少し不安定だけど、リリーはここで待っているよ。'
      setChatError(errorMessage)
      setMessages((prev) => [
        ...prev,
        {
          sender: 'lily',
          text: fallbackText,
          timestamp: nowTimestamp(),
        },
      ])
    } finally {
      setIsSending(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      sendMessage()
    }
  }

  function selectMood(moodId: RealmMoodId) {
    setActiveMoodId(moodId)
    if (moodId !== 'talk') {
      stopVoiceListening()
    }
  }

  function selectLanguage(languageId: RealmLanguageId) {
    setActiveLanguageId(languageId)
    const options = capabilities?.address_terms?.[languageId]?.length
      ? capabilities.address_terms[languageId]
      : REALM_ADDRESS_TERM_OPTIONS[languageId]
    if (!options.some((option) => option.id === addressTermId)) {
      setAddressTermId(options[0].id)
    }
  }

  function selectAddressTerm(termId: RealmAddressTermId) {
    if (availableAddressTermOptions.some((option) => option.id === termId)) {
      setAddressTermId(termId)
    }
  }

  async function selectOwnerPresence(status: OwnerPresenceStatus) {
    if (isPresenceUpdating) return

    const option = REALM_PRESENCE_OPTIONS.find((item) => item.id === status)
    setIsPresenceUpdating(true)
    setOwnerPresence((current) => ({
      ...current,
      status,
      label: option?.label || status,
      source: 'private_realm',
    }))

    try {
      const { data } = await axios.post(apiPath('/api/owner/presence'), {
        status,
        source: 'private_realm',
      }, { headers: { 'X-IRIS-CSRF': await browserCoreCsrf() }, withCredentials: true })
      if (data?.owner_presence?.status) {
        setOwnerPresence(data.owner_presence)
      }
    } catch {
      setChatError('Presence update could not reach Core.')
    } finally {
      setIsPresenceUpdating(false)
    }
  }

  function selectEnglishVoiceProfile(profileId: RealmEnglishVoiceProfileId) {
    setEnglishVoiceProfile(profileId)
  }

  function selectVoiceRoute(routeId: RealmVoiceRouteId) {
    setVoiceRoute(availableVoiceRouteOptions.some((option) => option.id === routeId) ? routeId : 'sovits')
  }

  function releaseVoiceStream(stream = voiceStreamRef.current) {
    stream?.getTracks().forEach((track) => track.stop())
    if (stream === voiceStreamRef.current) {
      voiceStreamRef.current = null
    }
  }

  function stopVoiceListening() {
    voiceSessionRef.current += 1
    voiceCancelledRef.current = true
    voiceStopRequestedRef.current = true
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    mediaRecorderRef.current = null
    releaseVoiceStream()
    setIsVoiceListening(false)
    setIsVoiceTranscribing(false)
    setVoiceTranscript('')
  }

  function finishVoiceListening() {
    voiceStopRequestedRef.current = true
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }

  async function transcribeVoiceBlob(blob: Blob, mimeType: string, sessionId: number) {
    if (voiceCancelledRef.current || voiceSessionRef.current !== sessionId) return

    setIsVoiceTranscribing(true)
    setVoiceTranscript('')
    const form = new FormData()
    const extension = voiceFileExtension(mimeType)
    form.append('file', blob, `private_realm_voice_${Date.now()}.${extension}`)
    form.append('language', activeLanguage.id)

    try {
      const { data } = await axios.post(apiPath('/api/stt/transcribe'), form, {
        headers: { 'X-IRIS-CSRF': await browserCoreCsrf() },
        withCredentials: true,
        timeout: 60_000,
      })
      if (voiceCancelledRef.current || voiceSessionRef.current !== sessionId) return

      const transcript = typeof data?.text === 'string' ? data.text.trim() : ''
      if (!transcript) {
        throw new Error('Speech transcription returned no text.')
      }

      setVoiceTranscript(transcript)
      setIsVoiceTranscribing(false)
      await sendMessage(transcript, 'voice', true)
    } catch (error) {
      if (voiceCancelledRef.current || voiceSessionRef.current !== sessionId) return
      const detail = axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string'
        ? error.response.data.detail
        : error instanceof Error
          ? error.message
          : 'Speech transcription failed.'
      setVoiceError(detail)
    } finally {
      if (voiceSessionRef.current === sessionId) {
        setIsVoiceTranscribing(false)
      }
    }
  }

  async function startVoiceListening() {
    if (isVoiceListening || isVoiceTranscribing || isSending) return
    stopCurrentVoice()
    setVoiceError('')
    setVoiceTranscript('')

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('This browser does not support microphone recording yet.')
      return
    }

    const sessionId = voiceSessionRef.current + 1
    voiceSessionRef.current = sessionId
    voiceCancelledRef.current = false
    voiceStopRequestedRef.current = false
    voiceChunksRef.current = []
    voiceVadAutoStopNoSpeechRef.current = false
    setIsVoiceListening(true)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (voiceSessionRef.current !== sessionId || voiceStopRequestedRef.current) {
        releaseVoiceStream(stream)
        setIsVoiceListening(false)
        return
      }

      voiceStreamRef.current = stream
      const requestedMimeType = preferredVoiceMimeType()
      const recorder = new MediaRecorder(stream, {
        ...(requestedMimeType ? { mimeType: requestedMimeType } : {}),
        audioBitsPerSecond: 24_000,
      })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data)
        }
      }
      recorder.onerror = () => {
        voiceCancelledRef.current = true
        voiceVadCleanupRef.current?.()
        voiceVadCleanupRef.current = null
        setVoiceError('Microphone recording stopped unexpectedly.')
        setIsVoiceListening(false)
        releaseVoiceStream(stream)
      }
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current
        const autoStoppedWithoutSpeech = voiceVadAutoStopNoSpeechRef.current
        voiceChunksRef.current = []
        mediaRecorderRef.current = null
        voiceVadCleanupRef.current?.()
        voiceVadCleanupRef.current = null
        voiceVadAutoStopNoSpeechRef.current = false
        releaseVoiceStream(stream)
        setIsVoiceListening(false)

        if (voiceCancelledRef.current || voiceSessionRef.current !== sessionId) return
        if (autoStoppedWithoutSpeech) {
          setVoiceError('No speech was detected. Try speaking a little closer to the microphone.')
          return
        }
        const mimeType = recorder.mimeType || requestedMimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })
        if (blob.size < 64) {
          setVoiceError('No speech was recorded. Hold Talk a little longer.')
          return
        }
        void transcribeVoiceBlob(blob, mimeType, sessionId)
      }
      recorder.start(250)
      voiceVadCleanupRef.current = startVoiceVad(
        stream,
        () => undefined,
        (hadSpeech) => {
          if (voiceSessionRef.current !== sessionId || voiceStopRequestedRef.current) return
          voiceVadAutoStopNoSpeechRef.current = !hadSpeech
          finishVoiceListening()
        },
      ) || null
    } catch (error) {
      releaseVoiceStream()
      const detail = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : 'Mic could not start. Try pressing Talk again.'
      setVoiceError(detail)
      setIsVoiceListening(false)
    }
  }

  function toggleVoiceListening() {
    if (isVoiceListening) {
      finishVoiceListening()
      return
    }
    startVoiceListening()
  }

  function startPushToTalk() {
    if (isVoiceListening) return
    startVoiceListening()
  }

  function finishPushToTalk() {
    if (!isVoiceListening) return
    finishVoiceListening()
  }

  return {
    audioRef,
    activeLanguage,
    activeLanguageId,
    activeAddressTerm,
    activeEnglishVoiceOption,
    activeVoiceRoute: availableVoiceRouteOptions.find((option) => option.id === voiceRoute) || availableVoiceRouteOptions[0],
    activeMood,
    activeMoodId,
    brainTone,
    chatError,
    chatEndRef,
    chatMode,
    components,
    coreTone,
    handleKeyDown,
    health,
    input,
    isVoiceListening,
    isSending,
    isPresenceUpdating,
    englishVoiceOptions: REALM_ENGLISH_VOICE_OPTIONS,
    englishVoiceProfile,
    voiceRoute,
    voiceRouteOptions: availableVoiceRouteOptions,
    isEnglishVoicePickerVisible: activeLanguageId === 'en',
    lastSync,
    latestLilyLine,
    latestEmotion,
    latestExpression,
    latestExpressionKey,
    latestExpressionSource,
    moodExpression,
    expressionResolution,
    lipSyncLevel,
    languages: REALM_LANGUAGES,
    messages,
    addressTermId,
    addressTermOptions: availableAddressTermOptions,
    ownerPresence,
    presenceOptions: REALM_PRESENCE_OPTIONS,
    sendMessage,
    selectEnglishVoiceProfile,
    selectAddressTerm,
    selectVoiceRoute,
    selectLanguage,
    selectOwnerPresence,
    selectMood,
    setActiveMoodId,
    setChatMode,
    setInput,
    startPushToTalk,
    finishPushToTalk,
    stopCurrentVoice,
    setExpressionResolution,
    toggleVoiceListening,
    voiceTone,
    voiceQueueActive,
    voiceQueueWaiting,
    voiceError,
    voiceStatus,
    healthSummary,
    voiceTranscript,
  }
}
