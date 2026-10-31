import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@mui/material';
import {
  Bell,
  Bot,
  ChevronLeft,
  Heart,
  Library,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Power,
  RefreshCcw,
  Settings2,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Volume2,
  VolumeX,
  Waves,
  X,
  UsersRound
} from 'lucide-react';
import { Live2DDock } from '../components/Live2DDock';
import { HomePanel } from '../components/HomePanel';
import { ModelLibrary } from '../components/ModelLibrary';
import { SettingsPanel } from '../components/SettingsPanel';
import { FamilyPanel } from '../components/FamilyPanel';
import { coreFetch, readCoreApiUrl, subscribeCoreEvents } from '../coreApi';
import { launcherFetch } from '../browserSession';
import type { Live2DModel } from '../modelLibraryApi';
import {
  readAddressTermPreference,
  readVoiceRoutePreference,
  type AddressTermId,
  type VoiceRouteId
} from '../voiceRoutes';
import './ControlCenterSweetRoom.css';

const API_BASE_URL = readCoreApiUrl(import.meta.env.VITE_LILY_API_URL ?? 'http://localhost:8000');
const BRIDGE_CONTROL_URL = import.meta.env.VITE_BRIDGE_CONTROL_URL ?? 'http://localhost:8091';
const DASHBOARD_USER_ID_KEY = 'lily_dashboard_user_id';
const DASHBOARD_LOCALE = 'en-GB';

type ServiceState = 'checking' | 'online' | 'offline' | 'degraded';
type ChatRole = 'owner' | 'lily';

type ChatMessage = {
  id: number;
  role: ChatRole;
  text: string;
  pending?: boolean;
};

type HealthComponent = {
  status?: string;
  provider?: string;
  detail?: string;
};

type BackendHealthResponse = {
  status?: string;
  components?: {
    core?: HealthComponent;
    brain?: HealthComponent;
    voice?: HealthComponent;
    openclaw?: HealthComponent;
  };
  owner_presence?: OwnerPresence;
  owner_mood?: {
    mood?: string;
    intensity?: number;
    expression?: string;
    updated_at?: number;
  };
};

type OwnerPresence = {
  status: string;
  label?: string;
  note?: string;
  source?: string;
  updated_at?: string;
  expires_at?: string | null;
  active?: boolean;
};

const PRESENCE_OPTIONS = [
  { status: 'available', label: 'Available' },
  { status: 'busy', label: 'Busy' },
  { status: 'at_office', label: 'Office' },
  { status: 'sleeping', label: 'Sleep' },
  { status: 'gaming', label: 'Gaming' },
  { status: 'away', label: 'Away' },
] as const;

type InboxItem = {
  id: string;
  chatId?: string;
  sender: string;
  relation: string;
  priority: string;
  summary: string;
  preview: string;
  createdAt?: string;
};

type OpenClawTask = {
  id: string;
  action: string;
  task: string;
  source: string;
  status: string;
  risk?: string;
  result_text?: string;
  error?: string;
  artifacts?: ToolArtifact[];
  created_at_iso?: string;
};

type ToolArtifact = {
  id: string;
  name: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  sha256?: string;
  download_url: string;
};

type OpenClawStatusResponse = {
  status?: string;
  provider?: string;
  pending_count?: number;
  running_count?: number;
  recent?: OpenClawTask[];
};

type SweetLogItem = {
  id: number;
  title: string;
  detail: string;
  time: string;
};

function expressionFromEmotion(emotion?: string) {
  switch (emotion?.trim().toLowerCase()) {
    case 'warning':
    case 'angry':
      return 'Angry';
    case 'happy':
      return 'Love';
    case 'sad':
      return 'Gloomy';
    case 'neutral':
      return 'Blush';
    default:
      return '';
  }
}

function createDashboardUserId() {
  const existing = window.localStorage.getItem(DASHBOARD_USER_ID_KEY);

  if (existing) {
    return existing;
  }

  const generated = `dashboard_${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(DASHBOARD_USER_ID_KEY, generated);
  return generated;
}

function normalizeServiceState(status?: string): ServiceState {
  if (status === 'ok' || status === 'online') return 'online';
  if (status === 'degraded') return 'degraded';
  if (status === 'offline') return 'offline';
  return 'checking';
}

function serviceText(status: ServiceState) {
  if (status === 'online') return 'Online';
  if (status === 'degraded') return 'Limited';
  if (status === 'offline') return 'Offline';
  return 'Checking';
}

function formatProvider(provider?: string) {
  if (!provider) return 'standby';
  if (provider === 'lmstudio') return 'LM Studio';
  if (provider === 'openai_compat') return 'Cloud';
  return provider;
}

function formatAgentProvider(provider?: string) {
  const value = provider?.trim().toLowerCase();
  if (value === 'hermes') return 'Hermes';
  if (value === 'openclaw') return 'OpenClaw';
  return provider?.trim() || '';
}

function formatRelativeTime(value?: string) {
  if (!value) return 'just now';

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'just now';

  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function inferPriority(createdAt?: string) {
  if (!createdAt) return 'low';
  const timestamp = new Date(createdAt).getTime();
  if (Number.isNaN(timestamp)) return 'low';
  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (diffMinutes <= 10) return 'high';
  if (diffMinutes <= 60) return 'medium';
  return 'low';
}

function truncate(value: string, maxLength = 120) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function resolveCoreDownloadUrl(downloadUrl?: string) {
  const value = (downloadUrl || '').trim();
  if (!value) return '#';
  if (/^https?:\/\//i.test(value)) return value;
  return `${API_BASE_URL.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

function openClassicVariant() {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', 'classic');
  window.location.assign(url.toString());
}

export function ControlCenterSweetRoom() {
  const [dashboardUserId, setDashboardUserId] = useState('dashboard_local');
  const [voiceRoute, setVoiceRoute] = useState<VoiceRouteId>(() => readVoiceRoutePreference());
  const [addressTerm, setAddressTerm] = useState<AddressTermId>(() => readAddressTermPreference());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [coreState, setCoreState] = useState<ServiceState>('checking');
  const [brainState, setBrainState] = useState<ServiceState>('checking');
  const [voiceState, setVoiceState] = useState<ServiceState>('checking');
  const [bridgeState, setBridgeState] = useState<ServiceState>('checking');
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusResponse | null>(null);
  const [backendHealth, setBackendHealth] = useState<BackendHealthResponse | null>(null);
  const [ownerPresence, setOwnerPresence] = useState<OwnerPresence>({
    status: 'available',
    label: 'Available',
    note: 'Owner is available.'
  });
  const [isPresenceBusy, setIsPresenceBusy] = useState(false);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [toolInput, setToolInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isToolBusy, setIsToolBusy] = useState(false);
  const [latestAudioUrl, setLatestAudioUrl] = useState<string | null>(null);
  const [latestEmotion, setLatestEmotion] = useState('neutral');
  const [latestExpression, setLatestExpression] = useState('Blush');
  const [latestExpressionKey, setLatestExpressionKey] = useState<string | number>('init');
  const [moodExpression, setMoodExpression] = useState('Blush');
  const [hasMoodLoaded, setHasMoodLoaded] = useState(false);
  const [isExpressionDebugOpen, setIsExpressionDebugOpen] = useState(false);
  const [expressionPanelTarget, setExpressionPanelTarget] = useState<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);
  const [isLive2DSpeaking, setIsLive2DSpeaking] = useState(false);
  const [activeLive2DModel, setActiveLive2DModel] = useState<Live2DModel | null>(null);
  const [isModelLibraryOpen, setIsModelLibraryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFamilyOpen, setIsFamilyOpen] = useState(false);
  const [logs, setLogs] = useState<SweetLogItem[]>([
    {
      id: 1,
      title: 'Sweet room loaded',
      detail: 'Control Center is running in soft dashboard mode.',
      time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: 'lily',
      text: 'Sweet room control center is ready.'
    }
  ]);

  useEffect(() => {
    window.localStorage.setItem('lily_control_center_voice_route', voiceRoute);
  }, [voiceRoute]);

  useEffect(() => {
    window.localStorage.setItem('lily_control_center_address_term', addressTerm);
  }, [addressTerm]);

  const onlineCount = useMemo(
    () => [coreState, brainState, voiceState, bridgeState, normalizeServiceState(openClawStatus?.status)].filter(
      (item) => item === 'online'
    ).length,
    [brainState, bridgeState, coreState, openClawStatus?.status, voiceState]
  );

  const openClawRecent = openClawStatus?.recent ?? [];
  const focusedInbox = inboxItems[0];

  const addLog = (title: string, detail: string) => {
    setLogs((current) => [
      {
        id: Date.now(),
        title,
        detail,
        time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, { hour: '2-digit', minute: '2-digit' })
      },
      ...current.slice(0, 4)
    ]);
  };

  const stopVoice = () => {
    setVoiceStopSignal((current) => current + 1);
    setLatestAudioUrl(null);
    setIsLive2DSpeaking(false);
    addLog('Voice stopped', 'Frontend playback and lip sync were reset.');
  };

  const refreshHealth = async () => {
    try {
      const response = await coreFetch(`${API_BASE_URL}/health`);
      if (!response.ok) throw new Error(`health request failed: ${response.status}`);
      const data = await response.json();
      const components = data?.components ?? {};

      setBackendHealth(data);
      setCoreState(normalizeServiceState(components?.core?.status ?? (data?.status === 'ok' ? 'online' : 'offline')));
      setBrainState(normalizeServiceState(components?.brain?.status));
      setVoiceState(normalizeServiceState(components?.voice?.status));
      if (data?.owner_presence?.status) {
        setOwnerPresence(data.owner_presence);
      }
      if (typeof data?.owner_mood?.expression === 'string' && data.owner_mood.expression.trim()) {
        const nextMoodExpression = data.owner_mood.expression.trim();
        setMoodExpression(nextMoodExpression);
        setHasMoodLoaded(true);
      }
    } catch (error) {
      console.warn('Sweet room failed to load core health:', error);
      setBackendHealth(null);
      setCoreState('offline');
      setBrainState('offline');
      setVoiceState('offline');
    }
  };

  useEffect(() => {
    if (!hasMoodLoaded || latestExpressionKey !== 'init') return;
    setLatestExpression(moodExpression);
    setLatestExpressionKey(`mood-${moodExpression}`);
  }, [hasMoodLoaded, latestExpressionKey, moodExpression]);

  const updatePresence = async (status: string) => {
    if (isPresenceBusy) return;

    setIsPresenceBusy(true);
    const option = PRESENCE_OPTIONS.find((item) => item.status === status);
    const optimistic: OwnerPresence = {
      status,
      label: option?.label ?? status,
      source: 'control_center'
    };
    setOwnerPresence((current) => ({ ...current, ...optimistic }));

    try {
      const response = await coreFetch(`${API_BASE_URL}/api/owner/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          source: 'control_center'
        })
      });
      if (!response.ok) throw new Error(`presence request failed: ${response.status}`);
      const data = await response.json();
      if (data?.owner_presence?.status) {
        setOwnerPresence(data.owner_presence);
      }
      addLog('Presence updated', `Owner status is ${option?.label ?? status}.`);
    } catch (error) {
      console.warn('Sweet room failed to update owner presence:', error);
      addLog('Presence update failed', 'Core presence endpoint is unavailable.');
    } finally {
      setIsPresenceBusy(false);
    }
  };

  const refreshBridge = async () => {
    try {
      const healthResponse = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/health`);
      if (!healthResponse.ok) throw new Error(`bridge health request failed: ${healthResponse.status}`);
      const health = await healthResponse.json();
      setBridgeState(normalizeServiceState(health?.status));

      const inboxResponse = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/api/inbox?limit=6`);
      if (!inboxResponse.ok) throw new Error(`inbox request failed: ${inboxResponse.status}`);
      const data = await inboxResponse.json();
      const parsed = Array.isArray(data?.items)
        ? data.items.map((item: Record<string, unknown>, index: number) => {
            const summary = String(item.summary ?? item.originalMessage ?? '').trim();
            const createdAt = String(item.createdAt ?? '');
            return {
              id: String(item.id ?? `wa_${index}`),
              chatId: String(item.chatId ?? ''),
              sender: String(item.name ?? item.phoneNumber ?? item.chatId ?? 'Unknown'),
              relation: String(item.relation ?? 'guest'),
              priority: inferPriority(createdAt),
              summary: summary || 'No saved summary yet.',
              preview: String(item.originalMessage ?? summary ?? ''),
              createdAt
            };
          })
        : [];

      setInboxItems(parsed.filter((item: InboxItem) => item.summary && item.sender));
    } catch (error) {
      console.warn('Sweet room failed to load bridge inbox:', error);
      setBridgeState('offline');
      setInboxItems([]);
    }
  };

  const refreshOpenClaw = async () => {
    try {
      const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/status?limit=8`);
      if (!response.ok) throw new Error(`OpenClaw status request failed: ${response.status}`);
      const data = await response.json();
      setOpenClawStatus(data);
    } catch (error) {
      console.warn('Sweet room failed to load OpenClaw status:', error);
      setOpenClawStatus({
        status: 'offline',
        pending_count: 0,
        running_count: 0,
        recent: []
      });
    }
  };

  const refreshAll = async () => {
    await Promise.all([refreshHealth(), refreshBridge(), refreshOpenClaw()]);
    addLog('Dashboard refreshed', 'Core, bridge, and tool status were checked.');
  };

  const sendChat = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || isSending) return;

    stopVoice();
    const ownerMessageId = Date.now();
    const pendingMessageId = ownerMessageId + 1;
    setIsSending(true);
    setChatInput('');
    setChatMessages((current) => [
      ...current,
      { id: ownerMessageId, role: 'owner', text: trimmed },
      { id: pendingMessageId, role: 'lily', text: 'Lily is thinking...', pending: true }
    ]);

    try {
      const response = await coreFetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          user_id: dashboardUserId,
          context: {
            interface: 'lily_control_center',
            voice_route: voiceRoute,
            address_term: addressTerm,
            owner_presence: ownerPresence,
            live2d_model_id: activeLive2DModel?.model_id,
            live2d_expression_options: activeLive2DModel?.expression_options ?? []
          }
        })
      });
      if (!response.ok) throw new Error(`chat request failed: ${response.status}`);

      const data = await response.json();
      const emotion = typeof data?.emotion === 'string' ? data.emotion.trim() : 'neutral';
      const expression =
        typeof data?.expression === 'string' && data.expression.trim()
          ? data.expression.trim()
          : expressionFromEmotion(emotion) || 'Blush';
      if (typeof data?.mood_expression === 'string' && data.mood_expression.trim()) {
        setMoodExpression(data.mood_expression.trim());
      }

      if (data?.audio) {
        const audio =
          typeof data.audio === 'string' && /^https?:\/\//i.test(data.audio)
            ? data.audio
            : `${API_BASE_URL}${String(data.audio).startsWith('/') ? data.audio : `/${data.audio}`}`;
        setLatestAudioUrl(audio);
      }

      setLatestEmotion(emotion);
      setLatestExpression(expression);
      setLatestExpressionKey(pendingMessageId);
      setChatMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: 'lily',
                text: data?.text || 'Lily received an empty response.'
              }
            : message
        )
      );
      addLog('Chat routed', truncate(trimmed, 72));
    } catch (error) {
      console.warn('Sweet room failed to send dashboard chat:', error);
      setChatMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: 'lily',
                text: 'Control Center could not reach Lily Core.'
              }
            : message
        )
      );
      addLog('Chat failed', 'Core chat endpoint is unavailable.');
    } finally {
      setIsSending(false);
    }
  };

  const queueTool = async () => {
    const task = toolInput.trim();
    if (!task || isToolBusy) return;

    setIsToolBusy(true);
    try {
      const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          source: 'dashboard',
          requester: 'control_center_sweet_room',
          session_id: dashboardUserId || 'dashboard-tools',
          require_approval: false
        })
      });
      if (!response.ok) throw new Error(`tool request failed: ${response.status}`);

      setToolInput('');
      await refreshOpenClaw();
      addLog('Tool request sent', truncate(task, 76));
    } catch (error) {
      console.warn('Sweet room failed to queue tool task:', error);
      addLog('Tool request failed', "Lily's tool route is unavailable right now.");
    } finally {
      setIsToolBusy(false);
    }
  };

  const wakePc = async () => {
    try {
      const response = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/api/power/wake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: 'dashboard_control_center_sweet_room',
          reason: 'Turn On PC quick action from Lily Control Center sweet room'
        })
      });
      if (!response.ok) throw new Error(`wake request failed: ${response.status}`);
      addLog('Wake request sent', 'The bridge accepted the power command.');
    } catch (error) {
      console.warn('Sweet room wake request failed:', error);
      addLog('Wake request failed', 'Bridge power endpoint is unavailable.');
    }
  };

  useEffect(() => {
    setDashboardUserId(createDashboardUserId());
    void refreshAll();

    const clock = window.setInterval(() => setCurrentTime(new Date()), 1000);
    const healthTimer = window.setInterval(() => {
      void refreshHealth();
    }, 15000);
    const bridgeTimer = window.setInterval(() => {
      void refreshBridge();
    }, 5000);
    const toolTimer = window.setInterval(() => {
      void refreshOpenClaw();
    }, 5000);
    const unsubscribe = subscribeCoreEvents(API_BASE_URL, (event) => {
      if (event.type === 'heartbeat') return;
      void refreshHealth();
      if (event.type.startsWith('tool.') || event.type === 'core.result') void refreshOpenClaw();
    });

    return () => {
      window.clearInterval(clock);
      window.clearInterval(healthTimer);
      window.clearInterval(bridgeTimer);
      window.clearInterval(toolTimer);
      unsubscribe();
    };
  }, []);

  const services = [
    {
      label: 'Core',
      status: coreState,
      detail: backendHealth?.components?.core?.detail || 'routing'
    },
    {
      label: 'Brain',
      status: brainState,
      detail: formatProvider(backendHealth?.components?.brain?.provider)
    },
    {
      label: 'Voice',
      status: voiceState,
      detail: isLive2DSpeaking ? 'speaking' : 'standby'
    },
    {
      label: 'WA',
      status: bridgeState,
      detail: `${inboxItems.length} inbox`
    },
    {
      label: formatAgentProvider(openClawStatus?.provider)
        ? `Agent · ${formatAgentProvider(openClawStatus?.provider)}`
        : 'Agent',
      status: normalizeServiceState(openClawStatus?.status),
      detail: `${openClawStatus?.pending_count ?? 0} pending`
    }
  ];

  const latestMessage = chatMessages[chatMessages.length - 1]?.text ?? 'Sweet room control center is ready.';

  return (
    <main className="control-sweet-room">
      <div className="control-sweet-dust" aria-hidden="true" />
      <div className="control-sweet-shell">
        <aside className="control-sweet-sidebar" aria-label="Control Center navigation">
          <div className="control-sweet-brand">
            <span className="control-sweet-flower">L</span>
            <div>
              <strong>Lily</strong>
              <small>Control Center</small>
            </div>
          </div>

          <div className="control-sweet-onair">
            <span>Sweet Room</span>
            <strong>{onlineCount}/5 online</strong>
            <p>{currentTime.toLocaleTimeString(DASHBOARD_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
          </div>

          <nav className="control-sweet-routes">
            <a href="#voice"><Volume2 size={17} /> Voice dock</a>
            <a href="#inbox"><MessageCircle size={17} /> Inbox</a>
            <a href="#tools"><TerminalSquare size={17} /> Tool desk</a>
            <button type="button" onClick={() => setIsModelLibraryOpen(true)}><Library size={17} /> Models</button>
            <button type="button" onClick={() => setIsFamilyOpen(true)}><UsersRound size={17} /> Family</button>
            <a href="#logs"><Bell size={17} /> Logs</a>
          </nav>

          <button className="control-sweet-classic" type="button" onClick={openClassicVariant}>
            <ChevronLeft size={16} />
            Classic
          </button>
        </aside>

        <section className="control-sweet-stage-shell" id="voice">
          <header className="control-sweet-topbar">
            <div>
              <p>Private operations surface</p>
              <h1>Lily Sweet Room</h1>
              <span><i /> {latestMessage}</span>
            </div>
            <div className="control-sweet-top-actions">
              <button type="button" onClick={() => setIsSettingsOpen(true)} title="Settings" aria-label="Settings">
                <Settings2 size={18} />
              </button>
              <button type="button" onClick={() => void refreshAll()} title="Refresh services">
                <RefreshCcw size={18} />
                Refresh
              </button>
              <button type="button" onClick={stopVoice} title="Stop voice playback">
                <VolumeX size={18} />
                Stop Voice
              </button>
            </div>
          </header>

          <section className="control-sweet-dashboard">
            <article className="control-sweet-live-card">
              <div className="control-sweet-stage-stars" aria-hidden="true" />
              <div className="control-sweet-orbit" aria-hidden="true" />

              <Live2DDock
                audioUrl={latestAudioUrl}
                expression={latestExpression}
                expressionKey={latestExpressionKey}
                idleExpression={moodExpression}
                stopSignal={voiceStopSignal}
                viewportScale={0.74}
                viewportResetKey="sweet-room-control-panel-full-body"
                expressionPanelOpen={false}
                expressionPanelTarget={expressionPanelTarget}
                onSpeakingChange={setIsLive2DSpeaking}
                onModelContextChange={setActiveLive2DModel}
              />

              <div className="control-sweet-bottom-dock" aria-label="Lily controls">
                <button type="button" aria-haspopup="dialog" onClick={() => setIsExpressionDebugOpen(true)}><Settings2 size={16} />Expressions</button>
                <button type="button" onClick={() => chatInputRef.current?.focus()}><MessageCircle size={16} />Chat</button>
                <button type="button" onClick={stopVoice}>Stop Voice</button>
              </div>
            </article>

            <aside className="control-sweet-status-card">
              <div className="control-sweet-card-title">
                <Heart size={20} />
                <div>
                  <p>Assistant Readiness</p>
                  <h2>{onlineCount}/5 modules online</h2>
                </div>
              </div>
              <div className="control-sweet-service-list">
                {services.map((service) => (
                  <div className={`control-sweet-service is-${service.status}`} key={service.label}>
                    <span>{service.label}</span>
                    <strong>{serviceText(service.status)}</strong>
                    <small>{service.detail}</small>
                  </div>
                ))}
              </div>

              <div className="control-sweet-presence">
                <div>
                  <span>Owner Presence</span>
                  <strong>{ownerPresence.label ?? 'Available'}</strong>
                  <small>{ownerPresence.note ?? 'Manual activity hint for Lily.'}</small>
                </div>
                <div className="control-sweet-presence-grid" role="group" aria-label="Owner presence">
                  {PRESENCE_OPTIONS.map((option) => (
                    <button
                      key={option.status}
                      type="button"
                      className={ownerPresence.status === option.status ? 'is-active' : ''}
                      aria-pressed={ownerPresence.status === option.status}
                      disabled={isPresenceBusy}
                      onClick={() => void updatePresence(option.status)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <section className="control-sweet-expression">
                <button
                  type="button"
                  className="control-sweet-expression-toggle"
                  aria-haspopup="dialog"
                  onClick={() => setIsExpressionDebugOpen(true)}
                >
                  <strong>Expression Debug</strong>
                  <Settings2 size={18} aria-hidden="true" />
                </button>
              </section>
            </aside>
          </section>

          <section className="control-sweet-workgrid">
            <article className="control-sweet-panel control-sweet-chat-panel">
              <div className="control-sweet-panel-heading">
                <div>
                  <p>Owner Chat</p>
                  <h2>Talk to Lily</h2>
                </div>
                <Bot size={22} />
              </div>
              <div className="control-sweet-chat-log">
                {chatMessages.slice(-5).map((message) => (
                  <div className={`control-sweet-message is-${message.role}`} key={message.id}>
                    <strong>{message.role === 'owner' ? 'You' : 'Lily'}</strong>
                    <span>{message.text}</span>
                    {message.pending ? <LoaderCircle className="control-sweet-spin" size={14} /> : null}
                  </div>
                ))}
              </div>
              <div className="control-sweet-composer">
                <input
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void sendChat();
                    }
                  }}
                  placeholder="Send a dashboard message to Lily..."
                />
                <button type="button" onClick={() => void sendChat()} disabled={isSending}>
                  {isSending ? <LoaderCircle size={17} /> : <SendHorizontal size={17} />}
                </button>
              </div>
            </article>

            <article className="control-sweet-panel" id="inbox">
              <div className="control-sweet-panel-heading">
                <div>
                  <p>WA Inbox</p>
                  <h2>{focusedInbox?.sender ?? 'No active thread'}</h2>
                </div>
                <Waves size={22} />
              </div>
              {focusedInbox ? (
                <div className="control-sweet-focused-thread">
                  <span>{focusedInbox.relation} / {formatRelativeTime(focusedInbox.createdAt)}</span>
                  <p>{focusedInbox.summary}</p>
                  <small>{focusedInbox.preview}</small>
                </div>
              ) : (
                <div className="control-sweet-empty">No saved WhatsApp messages yet.</div>
              )}
              <div className="control-sweet-mini-list">
                {inboxItems.slice(0, 4).map((item) => (
                  <div key={item.id}>
                    <strong>{item.sender}</strong>
                    <span>{truncate(item.summary, 58)}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="control-sweet-panel" id="tools">
              <div className="control-sweet-panel-heading">
                <div>
                  <p>{formatAgentProvider(openClawStatus?.provider) || 'Agent'} Vessel</p>
                  <h2>Agent Desk</h2>
                </div>
                <ShieldCheck size={22} />
              </div>
              <div className="control-sweet-tool-input">
                <input
                  value={toolInput}
                  onChange={(event) => setToolInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void queueTool();
                    }
                  }}
                  placeholder="Ask Lily to make a file or queue a tool task..."
                />
                <button type="button" onClick={() => void queueTool()} disabled={isToolBusy || !toolInput.trim()}>
                  {isToolBusy ? <LoaderCircle size={16} /> : <TerminalSquare size={16} />}
                </button>
              </div>
              <div className="control-sweet-mini-list">
                {openClawRecent.length ? (
                  openClawRecent.slice(0, 4).map((task) => (
                    <div key={task.id}>
                      <strong>{task.action} / {task.status}</strong>
                      <span>{truncate(task.result_text || task.error || task.task, 70)}</span>
                      {task.artifacts?.length ? (
                        <span className="control-sweet-artifact-row">
                          {task.artifacts.slice(0, 3).map((artifact) => (
                            <a
                              key={artifact.id}
                              href={resolveCoreDownloadUrl(artifact.download_url)}
                              target="_blank"
                              rel="noreferrer"
                              title={`${artifact.name} (${artifact.mime_type})`}
                            >
                              <Paperclip size={12} />
                              {truncate(artifact.name || artifact.id, 24)}
                            </a>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="control-sweet-empty">No tool requests yet.</div>
                )}
              </div>
            </article>

            <article className="control-sweet-panel control-sweet-home-panel" id="home">
              <HomePanel apiBaseUrl={API_BASE_URL} onWakePc={() => void wakePc()} />
            </article>

            <article className="control-sweet-panel" id="logs">
              <div className="control-sweet-panel-heading">
                <div>
                  <p>Quick Controls</p>
                  <h2>Operator Actions</h2>
                </div>
                <Sparkles size={22} />
              </div>
              <div className="control-sweet-action-grid">
                <button type="button" onClick={() => void wakePc()}>
                  <Power size={17} />
                  Wake PC
                </button>
                <button type="button" onClick={() => void refreshAll()}>
                  <RefreshCcw size={17} />
                  Sync All
                </button>
                <button type="button" onClick={stopVoice}>
                  <Square size={17} />
                  Reset Voice
                </button>
              </div>
              <div className="control-sweet-log-list">
                {logs.map((item) => (
                  <div key={item.id}>
                    <span>{item.time}</span>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </section>
      </div>
      <Dialog
        open={isExpressionDebugOpen}
        onClose={() => setIsExpressionDebugOpen(false)}
        aria-labelledby="sweet-expression-title"
        className="control-sweet-expression-dialog"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="sweet-expression-title">
          Expression Debug
          <button type="button" aria-label="Close expression debug" onClick={() => setIsExpressionDebugOpen(false)}><X size={20} /></button>
        </DialogTitle>
        <DialogContent id="sweet-expression-controls">
          <p className="control-sweet-expression-emotion">Chat emotion: <b>{latestEmotion}</b></p>
          <div ref={setExpressionPanelTarget} />
        </DialogContent>
      </Dialog>
      {isModelLibraryOpen ? <ModelLibrary onClose={() => setIsModelLibraryOpen(false)} /> : null}
      {isSettingsOpen ? <SettingsPanel apiBaseUrl={API_BASE_URL} onClose={() => setIsSettingsOpen(false)} voiceRoute={voiceRoute} onVoiceRouteChange={setVoiceRoute} addressTerm={addressTerm} onAddressTermChange={setAddressTerm} /> : null}
      {isFamilyOpen ? <FamilyPanel apiBaseUrl={API_BASE_URL} onClose={() => setIsFamilyOpen(false)} /> : null}
    </main>
  );
}
