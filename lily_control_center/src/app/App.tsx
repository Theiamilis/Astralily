import type { ComponentType } from 'react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Bot,
  CheckCircle2,
  Cpu,
  LoaderCircle,
  Library,
  Paperclip,
  SendHorizontal,
  MessageCircleMore,
  MoonStar,
  Power,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  VolumeX,
  WifiOff,
  XCircle,
  Waves,
  UsersRound
} from 'lucide-react';
import { GlassCard } from './components/GlassCard';
import { Live2DDock, type DockExpressionResolution } from './components/Live2DDock';
import { StatusChip } from './components/StatusChip';
import { HomePanel } from './components/HomePanel';
import { ModelLibrary } from './components/ModelLibrary';
import { SettingsPanel } from './components/SettingsPanel';
import { FamilyPanel } from './components/FamilyPanel';
import { coreFetch, readCoreApiUrl, subscribeCoreEvents } from './coreApi';
import { launcherFetch } from './browserSession';
import type { Live2DModel } from './modelLibraryApi';
import { ControlCenterSweetRoom } from './variants/ControlCenterSweetRoom';
import { DISPLAY_CHANGE_EVENT, readDisplayVariant } from './displayPreferences';
import { useDashboardAudio } from './useDashboardAudio';
import {
  readAddressTermPreference,
  readVoiceRoutePreference,
  type AddressTermId,
  type VoiceRouteId
} from './voiceRoutes';

const API_BASE_URL = readCoreApiUrl(import.meta.env.VITE_LILY_API_URL ?? 'http://localhost:8000');
const BRIDGE_CONTROL_URL = import.meta.env.VITE_BRIDGE_CONTROL_URL ?? 'http://localhost:8091';
const CONTROL_CENTER_VARIANT =
  new URLSearchParams(window.location.search).get('variant') ??
  import.meta.env.VITE_CONTROL_CENTER_VARIANT ??
  'classic';
const DASHBOARD_USER_ID_KEY = 'lily_dashboard_user_id';
const DASHBOARD_LOCALE = 'en-GB';
const ControlCenterOverview = lazy(() => import('./variants/ControlCenterOverview').then((module) => ({ default: module.ControlCenterOverview })));

type ChatRole = 'owner' | 'lily';

type ChatMessage = {
  id: number;
  role: ChatRole;
  text: string;
  timestamp?: string;
  pending?: boolean;
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

type ServiceState = 'loading' | 'online' | 'offline' | 'degraded';

type HealthComponent = {
  status?: 'online' | 'offline' | 'degraded' | 'unknown';
  provider?: string;
  fallback_provider?: string;
  detail?: string;
  mode?: string;
  session_count?: number;
};

type BackendHealthResponse = {
  status?: string;
  service?: string;
  timestamp?: string;
  components?: {
    core?: HealthComponent;
    brain?: HealthComponent;
    vision?: HealthComponent;
    voice?: HealthComponent;
    openclaw?: HealthComponent;
  };
  owner_mood?: {
    mood?: string;
    intensity?: number;
    expression?: string;
    updated_at?: number;
  };
};

type OpenClawTask = {
  id: string;
  action: string;
  task: string;
  source: string;
  requester: string;
  status: string;
  risk: string;
  requires_approval?: boolean;
  created_at_iso?: string;
  updated_at_iso?: string;
  result_text?: string;
  error?: string;
  artifacts?: ToolArtifact[];
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
  enabled?: boolean;
  gateway_url?: string;
  gateway_reachable?: boolean;
  cli_available?: boolean;
  cli_path?: string;
  pending_count?: number;
  running_count?: number;
  recent?: OpenClawTask[];
  allowed_sources?: string[];
  blocked_sources?: string[];
};

type SystemLogItem = {
  time: string;
  title: string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
};

type InboxItem = {
  id: string | number;
  chatId?: string;
  sender: string;
  relation: string;
  time: string;
  priority: string;
  summary: string;
  preview: string;
  createdAt?: string;
};

const systemLogItems = [
  {
    time: '23:41:08',
    title: 'Core Systems: Offline',
    detail: 'The dashboard could not reach Lily Core, so text-only standby is being maintained.',
    icon: Cpu
  },
  {
    time: '23:40:21',
    title: 'Message routed to owner inbox',
    detail: 'Scarlett message summary successfully entered the external inbox.',
    icon: MessageCircleMore
  },
  {
    time: '23:39:54',
    title: 'WA Bridge active',
    detail: 'WhatsApp session is connected and ready to send reply.',
    icon: Waves
  }
] as const;

function priorityTone(priority: string) {
  if (priority === 'high') {
    return 'bg-rose-500/15 text-rose-700 border border-rose-300/60';
  }

  if (priority === 'medium') {
    return 'bg-amber-400/15 text-amber-700 border border-amber-300/60';
  }

  return 'bg-slate-500/10 text-slate-600 border border-slate-300/60';
}

function formatRelativeInboxTime(value?: string) {
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

function inferInboxPriority(createdAt?: string) {
  if (!createdAt) return 'medium';

  const timestamp = new Date(createdAt).getTime();
  if (Number.isNaN(timestamp)) return 'medium';

  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));

  if (diffMinutes <= 10) return 'high';
  if (diffMinutes <= 60) return 'medium';
  return 'low';
}

function isRenderableInboxItem(item: Record<string, unknown>) {
  const chatId = String(item.chatId ?? '');
  const message = String(item.originalMessage ?? item.summary ?? '').trim();

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

function dedupeInboxItemsByChat(items: InboxItem[]) {
  const latestByChat = new Map<string, InboxItem>();

  items.forEach((item) => {
    const key = item.chatId || String(item.id);
    const existing = latestByChat.get(key);
    const itemTime = new Date(item.createdAt ?? 0).getTime();
    const existingTime = existing ? new Date(existing.createdAt ?? 0).getTime() : 0;

    if (!existing || itemTime >= existingTime) {
      latestByChat.set(key, item);
    }
  });

  return [...latestByChat.values()].sort(
    (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
  );
}

function createDashboardUserId() {
  if (typeof window === 'undefined') {
    return 'dashboard_local';
  }

  const existing = window.localStorage.getItem(DASHBOARD_USER_ID_KEY);

  if (existing) {
    return existing;
  }

  const generated = `dashboard_${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(DASHBOARD_USER_ID_KEY, generated);
  return generated;
}

function normalizeServiceState(status?: string): ServiceState {
  if (status === 'online') return 'online';
  if (status === 'degraded') return 'degraded';
  if (status === 'offline') return 'offline';
  return 'loading';
}

function serviceStateToChip(state: ServiceState): 'ready' | 'limited' | 'offline' | 'unknown' {
  if (state === 'online') return 'ready';
  if (state === 'degraded') return 'limited';
  if (state === 'offline') return 'offline';
  return 'unknown';
}

function formatProviderName(provider?: string) {
  if (!provider) return 'Ready';
  if (provider === 'lmstudio') return 'LM Studio';
  if (provider === 'sovits') return 'SoVITS';
  if (provider === 'claude') return 'Claude';
  if (provider === 'openai_compat') return 'Cloud 1430';
  return provider;
}

function formatAgentProvider(provider?: string) {
  const value = provider?.trim().toLowerCase();
  if (value === 'hermes') return 'Hermes';
  if (value === 'openclaw') return 'OpenClaw';
  return provider?.trim() || '';
}

function openClawStatusTone(status?: string) {
  if (status === 'completed' || status === 'approved' || status === 'running') {
    return 'bg-emerald-500/12 text-emerald-700 border border-emerald-300/60';
  }
  if (status === 'pending') {
    return 'bg-amber-400/15 text-amber-700 border border-amber-300/60';
  }
  if (status === 'failed' || status === 'denied' || status === 'blocked') {
    return 'bg-rose-500/12 text-rose-700 border border-rose-300/60';
  }
  return 'bg-slate-500/10 text-slate-600 border border-slate-300/60';
}

function formatOpenClawTaskTime(value?: string) {
  if (!value) return 'just now';

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'just now';

  return new Date(timestamp).toLocaleTimeString(DASHBOARD_LOCALE, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function resolveCoreDownloadUrl(downloadUrl?: string) {
  const value = (downloadUrl || '').trim();
  if (!value) return '#';
  if (/^https?:\/\//i.test(value)) return value;
  return `${API_BASE_URL.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

function truncateMiddle(value: string, maxLength = 110) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function mapHistoryToMessages(history: Array<{ user_message: string; bot_response: string; timestamp?: string }>): ChatMessage[] {
  const messages: ChatMessage[] = [];

  history.forEach((item, index) => {
    messages.push({
      id: index * 2 + 1,
      role: 'owner',
      text: item.user_message,
      timestamp: item.timestamp
    });
    messages.push({
      id: index * 2 + 2,
      role: 'lily',
      text: item.bot_response,
      timestamp: item.timestamp
    });
  });

  return messages;
}

function isSweetRoomVariant(value: string) {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'sweet-room' || normalized === 'sweet';
}

function openSweetRoomVariant() {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', 'sweet-room');
  window.location.assign(url.toString());
}

export default function App() {
  const [variant, setVariant] = useState(() => readDisplayVariant(CONTROL_CENTER_VARIANT));
  useEffect(() => {
    const changed = () => setVariant(readDisplayVariant(CONTROL_CENTER_VARIANT));
    window.addEventListener(DISPLAY_CHANGE_EVENT, changed);
    window.addEventListener('popstate', changed);
    return () => { window.removeEventListener(DISPLAY_CHANGE_EVENT, changed); window.removeEventListener('popstate', changed); };
  }, []);
  if (isSweetRoomVariant(variant)) {
    return <ControlCenterSweetRoom />;
  }

  return <ControlCenterClassic overview={variant === 'overview'} />;
}

function ControlCenterClassic({ overview = false }: { overview?: boolean }) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: 'lily',
      text: 'Lily standby.'
    }
  ]);
  const [dashboardUserId, setDashboardUserId] = useState('dashboard_local');
  const [voiceRoute, setVoiceRoute] = useState<VoiceRouteId>(() => readVoiceRoutePreference());
  const [addressTerm, setAddressTerm] = useState<AddressTermId>(() => readAddressTermPreference());
  const [isSending, setIsSending] = useState(false);
  const [latestAudioUrl, setLatestAudioUrl] = useState<string | null>(null);
  const [isExpressionDebugVisible, setIsExpressionDebugVisible] = useState(false);
  const [latestEmotion, setLatestEmotion] = useState<string | null>(null);
  const [latestExpression, setLatestExpression] = useState<string | null>(null);
  const [latestExpressionKey, setLatestExpressionKey] = useState<string | number | null>(null);
  const [latestExpressionSource, setLatestExpressionSource] = useState<string | null>(null);
  const [moodExpression, setMoodExpression] = useState('Blush');
  const [resolvedExpressionDebug, setResolvedExpressionDebug] = useState<DockExpressionResolution | null>(null);
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);
  const [isLive2DSpeaking, setIsLive2DSpeaking] = useState(false);
  const dashboardAudio = useDashboardAudio(latestAudioUrl, voiceStopSignal);
  useEffect(() => { setIsLive2DSpeaking(dashboardAudio.playing); }, [dashboardAudio.playing]);
  const [isModelLibraryOpen, setIsModelLibraryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFamilyOpen, setIsFamilyOpen] = useState(false);
  const [activeLive2DModel, setActiveLive2DModel] = useState<Live2DModel | null>(null);
  const [coreState, setCoreState] = useState<ServiceState>('loading');
  const [brainState, setBrainState] = useState<ServiceState>('loading');
  const [voiceState, setVoiceState] = useState<ServiceState>('loading');
  const [bridgeState, setBridgeState] = useState<ServiceState>('loading');
  const [backendHealth, setBackendHealth] = useState<BackendHealthResponse | null>(null);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusResponse | null>(null);
  const [openClawTaskInput, setOpenClawTaskInput] = useState('');
  const [isOpenClawBusy, setIsOpenClawBusy] = useState(false);
  const [healthUpdatedAt, setHealthUpdatedAt] = useState('checking...');
  const [systemLog, setSystemLog] = useState<SystemLogItem[]>([...systemLogItems]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [viewport, setViewport] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080
  });

  useEffect(() => {
    window.localStorage.setItem('lily_control_center_voice_route', voiceRoute);
  }, [voiceRoute]);

  useEffect(() => {
    window.localStorage.setItem('lily_control_center_address_term', addressTerm);
  }, [addressTerm]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const userId = createDashboardUserId();
    setDashboardUserId(userId);
  }, []);

  useEffect(() => {
    if (!dashboardUserId) {
      return;
    }

    let isMounted = true;

    const loadHistory = async () => {
      try {
        const response = await coreFetch(
          `${API_BASE_URL}/api/history?user_id=${encodeURIComponent(dashboardUserId)}&limit=12`
        );

        if (!response.ok) {
          throw new Error(`history request failed: ${response.status}`);
        }

        const data = await response.json();

        if (!isMounted || !Array.isArray(data) || data.length === 0) {
          return;
        }

        setChatMessages(mapHistoryToMessages(data));
      } catch (error) {
        console.warn('Failed to load Lily history into dashboard:', error);
      }
    };

    void loadHistory();

    return () => {
      isMounted = false;
    };
  }, [dashboardUserId]);

  useEffect(() => {
    let isMounted = true;

    const checkHealth = async () => {
      try {
        const response = await coreFetch(`${API_BASE_URL}/health`);

        if (!response.ok) {
          throw new Error(`health request failed: ${response.status}`);
        }

        const data = await response.json();

        if (!isMounted) {
          return;
        }

        const components = data?.components ?? {};
        const nextCoreState = normalizeServiceState(components?.core?.status ?? (data?.status === 'ok' ? 'online' : 'offline'));
        const nextBrainState = normalizeServiceState(components?.brain?.status);
        const nextVoiceState = normalizeServiceState(components?.voice?.status);
        const timeLabel = new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
          hour: '2-digit',
          minute: '2-digit'
        });

        setBackendHealth(data);
        if (typeof data?.owner_mood?.expression === 'string' && data.owner_mood.expression.trim()) {
          const nextMoodExpression = data.owner_mood.expression.trim();
          setMoodExpression(nextMoodExpression);
          setLatestExpression((current) => current || nextMoodExpression);
          setLatestExpressionKey((current) => current || `mood-${data.owner_mood.updated_at || 'initial'}`);
          setLatestExpressionSource((current) => current || 'owner_mood');
        }
        setCoreState(nextCoreState);
        setBrainState(nextBrainState);
        setVoiceState(nextVoiceState);
        setHealthUpdatedAt(timeLabel);

        setSystemLog((current) => [
          {
            time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }),
            title: nextCoreState === 'online' ? 'Core Systems: Online' : nextCoreState === 'degraded' ? 'Core Systems: Degraded' : 'Core Systems: Offline',
            detail:
              String(components?.core?.detail || '').trim() ||
              (nextCoreState === 'online'
                ? 'All backend modules are reporting stable connectivity.'
                : nextCoreState === 'degraded'
                  ? 'Core routing is up, but one or more backend modules need attention.'
                  : 'The dashboard could not reach Lily Core, so text-only standby is being maintained.'),
            icon: Cpu
          },
          ...current.slice(0, 2)
        ]);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setBackendHealth(null);
        setCoreState('offline');
        setBrainState('offline');
        setVoiceState('offline');
        setHealthUpdatedAt('offline');
      }
    };

    void checkHealth();

    const timer = window.setInterval(() => {
      void checkHealth();
    }, 15000);
    const unsubscribe = subscribeCoreEvents(API_BASE_URL, (event) => {
      if (event.type !== 'heartbeat') void checkHealth();
    });

    return () => {
      isMounted = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadBridgeInbox = async () => {
      try {
        const healthResponse = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/health`);

        if (!healthResponse.ok) {
          throw new Error(`bridge health request failed: ${healthResponse.status}`);
        }

        if (overview) {
          const health = await healthResponse.json();
          if (isMounted) setBridgeState(health.ready === false || health.status === 'degraded' ? 'degraded' : 'online');
          return;
        }

        const response = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/api/inbox?limit=8`);

        if (!response.ok) {
          throw new Error(`inbox request failed: ${response.status}`);
        }

        const data = await response.json();
        const items = Array.isArray(data?.items) ? data.items.filter(isRenderableInboxItem) : [];

        if (!isMounted) {
          return;
        }

        setBridgeState('online');
        setInboxItems(
          dedupeInboxItemsByChat(items.map((item: Record<string, unknown>, index: number) => ({
            id: String(item.id ?? `bridge_inbox_${index}`),
            chatId: String(item.chatId ?? ''),
            sender: String(item.name ?? item.phoneNumber ?? item.chatId ?? 'Unknown'),
            relation: String(item.relation ?? 'unknown'),
            time: formatRelativeInboxTime(String(item.createdAt ?? '')),
            priority: inferInboxPriority(String(item.createdAt ?? '')),
            summary: String(item.summary ?? item.originalMessage ?? ''),
            preview: String(item.originalMessage ?? item.summary ?? ''),
            createdAt: String(item.createdAt ?? '')
          })))
        );
      } catch (error) {
        console.warn('Failed to load external WA inbox from bridge:', error);

        if (!isMounted) {
          return;
        }

        setBridgeState('offline');
        setInboxItems([]);
      }
    };

    void loadBridgeInbox();

    const handleVisibilityRefresh = () => {
      if (document.visibilityState === 'visible') {
        void loadBridgeInbox();
      }
    };

    const handleWindowFocus = () => {
      void loadBridgeInbox();
    };

    const timer = window.setInterval(() => {
      void loadBridgeInbox();
    }, overview ? 15000 : 5000);

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityRefresh);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityRefresh);
    };
  }, [overview]);

  useEffect(() => {
    if (overview) return;
    let isMounted = true;

    const loadOpenClawStatus = async () => {
      try {
        const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/status?limit=8`);

        if (!response.ok) {
          throw new Error(`openclaw status request failed: ${response.status}`);
        }

        const data = await response.json();

        if (isMounted) {
          setOpenClawStatus(data);
        }
      } catch (error) {
        console.warn('Failed to load OpenClaw status:', error);

        if (isMounted) {
          setOpenClawStatus({
            status: 'offline',
            enabled: false,
            recent: [],
            pending_count: 0,
            running_count: 0
          });
        }
      }
    };

    void loadOpenClawStatus();
    const timer = window.setInterval(() => {
      void loadOpenClawStatus();
    }, 5000);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [overview]);

  const focusedInbox =
    inboxItems[0] ??
    ({
      id: 'empty',
      sender: 'No saved messages',
      relation: 'idle',
      time: '-',
      priority: 'low',
      summary: 'No saved WhatsApp messages are available right now.',
      preview: 'The latest non-owner message saved by the bridge will appear here.'
    } satisfies InboxItem);
  const canvasWidth = 1920;
  const canvasHeight = 1080;
  const scale = Math.min(viewport.width / canvasWidth, viewport.height / canvasHeight);
  const agentProviderName = formatAgentProvider(openClawStatus?.provider);
  const agentDisplayName = agentProviderName ? `Agent · ${agentProviderName}` : 'Agent';
  const statusChips = useMemo(
    () => [
      {
        label: `Core - ${coreState === 'online' ? 'Online' : coreState === 'degraded' ? 'Degraded' : coreState === 'loading' ? 'Checking' : 'Offline'}`,
        status: serviceStateToChip(coreState)
      },
      {
        label: `Brain - ${
          brainState === 'online'
            ? `${formatProviderName(backendHealth?.components?.brain?.provider)}`
            : brainState === 'degraded'
              ? 'Fallback'
              : brainState === 'loading'
                ? 'Checking'
                : 'Offline'
        }`,
        status: serviceStateToChip(brainState)
      },
      {
        label: `Voice - ${voiceState === 'online' ? 'Online' : voiceState === 'degraded' ? 'Limited' : voiceState === 'loading' ? 'Checking' : 'Offline'}`,
        status: serviceStateToChip(voiceState)
      },
      {
        label: `WA Bridge - ${bridgeState === 'online' ? 'Active' : bridgeState === 'degraded' ? 'Limited' : bridgeState === 'loading' ? 'Checking' : 'Offline'}`,
        status: serviceStateToChip(bridgeState)
      },
      {
        label: `${agentDisplayName} - ${
          openClawStatus?.status === 'online'
            ? 'Ready'
            : openClawStatus?.status === 'offline'
              ? 'Offline'
              : openClawStatus?.status === 'degraded'
                ? 'Limited'
                : 'Checking'
        }`,
        status: serviceStateToChip(normalizeServiceState(openClawStatus?.status))
      },
      { label: `Inbox - ${inboxItems.length} Pending`, status: 'limited' as const }
    ],
    [agentDisplayName, backendHealth?.components?.brain?.provider, brainState, bridgeState, coreState, inboxItems.length, openClawStatus?.status, voiceState]
  );
  const isCoreOffline = coreState === 'offline';
  const openClawRecent = openClawStatus?.recent ?? [];
  const openClawReady = openClawStatus?.status === 'online';
  const openClawBadgeLabel = `${agentProviderName ? `${agentProviderName} ` : ''}${openClawReady ? 'Ready' : openClawStatus?.status === 'degraded' ? 'Limited' : 'Offline'}`;

  const refreshOpenClawStatus = async () => {
    const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/status?limit=8`);
    if (!response.ok) {
      throw new Error(`openclaw status request failed: ${response.status}`);
    }
    const data = await response.json();
    setOpenClawStatus(data);
    return data as OpenClawStatusResponse;
  };

  const handleCreateOpenClawTask = async () => {
    const task = openClawTaskInput.trim();
    if (!task || isOpenClawBusy) {
      return;
    }

    setIsOpenClawBusy(true);

    try {
      const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          task,
          source: 'dashboard',
          requester: 'control_center',
          session_id: dashboardUserId || 'dashboard-tools',
          require_approval: false
        })
      });

      if (!response.ok) {
        throw new Error(`openclaw task request failed: ${response.status}`);
      }

      setOpenClawTaskInput('');
      await refreshOpenClawStatus();
      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: 'Tool request sent',
          detail: truncateMiddle(task, 72),
          icon: TerminalSquare
        },
        ...current.slice(0, 2)
      ]);
    } catch (error) {
      console.warn('Failed to create OpenClaw task:', error);
      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: 'Tool request failed',
          detail: "Control Center could not reach Lily's tool route.",
          icon: ShieldAlert
        },
        ...current.slice(0, 2)
      ]);
    } finally {
      setIsOpenClawBusy(false);
    }
  };

  const handleOpenClawApproval = async (taskId: string, action: 'approve' | 'deny') => {
    if (!taskId || isOpenClawBusy) {
      return;
    }

    setIsOpenClawBusy(true);

    try {
      const response = await coreFetch(`${API_BASE_URL}/api/tools/openclaw/${encodeURIComponent(taskId)}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          approver: 'control_center'
        })
      });

      if (!response.ok) {
        throw new Error(`openclaw ${action} request failed: ${response.status}`);
      }

      await refreshOpenClawStatus();
      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: action === 'approve' ? 'Tool request approved' : 'Tool request denied',
          detail: action === 'approve' ? `${taskId} is cleared to run.` : `${taskId} will not run.`,
          icon: action === 'approve' ? CheckCircle2 : XCircle
        },
        ...current.slice(0, 2)
      ]);
    } catch (error) {
      console.warn(`Failed to ${action} OpenClaw task:`, error);
    } finally {
      setIsOpenClawBusy(false);
    }
  };

  const stopDashboardVoice = () => {
    setVoiceStopSignal((current) => current + 1);
    setLatestAudioUrl(null);
    setIsLive2DSpeaking(false);
  };

  const handleSendMessage = async () => {
    const trimmed = chatInput.trim();

    if (!trimmed || isSending) {
      return;
    }

    stopDashboardVoice();

    const ownerMessageId = Date.now();
    const pendingMessageId = ownerMessageId + 1;

    setChatMessages((current) => [
      ...current,
      { id: ownerMessageId, role: 'owner', text: trimmed },
      {
        id: pendingMessageId,
        role: 'lily',
        text: 'Lily is thinking...',
        pending: true
      }
    ]);
    setChatInput('');

    setIsSending(true);

    try {
      const response = await coreFetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: trimmed,
          user_id: dashboardUserId,
          context: {
            interface: 'lily_control_center',
            voice_route: voiceRoute,
            address_term: addressTerm,
            live2d_model_id: activeLive2DModel?.model_id,
            live2d_expression_options: activeLive2DModel?.expression_options ?? []
          }
        })
      });

      if (!response.ok) {
        throw new Error(`chat request failed: ${response.status}`);
      }

      const data = await response.json();
      const responseEmotion = typeof data?.emotion === 'string' ? data.emotion.trim() : '';
      const responseExpression =
        typeof data?.expression === 'string' && data.expression.trim()
          ? data.expression.trim()
          : expressionFromEmotion(responseEmotion);
      const responseExpressionSource =
        typeof data?.expression_source === 'string' && data.expression_source.trim()
          ? data.expression_source.trim()
          : responseExpression
            ? 'emotion_inferred'
            : '';
      if (typeof data?.mood_expression === 'string' && data.mood_expression.trim()) {
        setMoodExpression(data.mood_expression.trim());
      }

      if (data?.audio) {
        const resolvedAudioUrl =
          typeof data.audio === 'string' && /^https?:\/\//i.test(data.audio)
            ? data.audio
            : `${API_BASE_URL}${String(data.audio).startsWith('/') ? data.audio : `/${data.audio}`}`;
        setLatestAudioUrl(resolvedAudioUrl);
      }

      if (responseExpression) {
        setLatestEmotion(responseEmotion || 'neutral');
        setLatestExpression(responseExpression);
        setLatestExpressionKey(pendingMessageId);
        setLatestExpressionSource(responseExpressionSource || 'emotion_inferred');
      }

      setChatMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: 'lily',
                text: data?.text || 'Lily received the message, but the reply came back empty.',
                timestamp: new Date().toISOString()
              }
            : message
        )
      );

      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: 'Message sent from dashboard',
          detail: `The owner sent a dashboard message: "${trimmed.slice(0, 48)}${trimmed.length > 48 ? '...' : ''}"`,
          icon: MessageCircleMore
        },
        ...current.slice(0, 2)
      ]);
    } catch (error) {
      console.warn('Failed to send message to Lily backend:', error);

      setChatMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: 'lily',
                text: 'The dashboard could not reach the Lily backend. Make sure the `localhost:8000` server is running.'
              }
            : message
        )
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleQuickAction = async (label: string) => {
    if (label !== 'Turn On PC') {
      return;
    }

    setSystemLog((current) => [
      {
        time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        title: 'Wake request queued',
        detail: 'The dashboard queued a PC wake request through the shared power API.',
        icon: Power
      },
      ...current.slice(0, 2)
    ]);

    try {
      const response = await launcherFetch('wa', `${BRIDGE_CONTROL_URL}/api/power/wake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: 'dashboard_control_center',
          reason: 'Turn On PC quick action from Lily Control Center'
        })
      });

      if (!response.ok) {
        throw new Error(`wake request failed: ${response.status}`);
      }

      const data = await response.json();

      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: 'Wake request delivered',
          detail: `The PC wake request was delivered to the bridge via ${data?.mode || 'unknown'} mode.`,
          icon: Power
        },
        ...current.slice(0, 2)
      ]);
    } catch (error) {
      console.warn('Failed to send wake request:', error);

      setSystemLog((current) => [
        {
          time: new Date().toLocaleTimeString(DASHBOARD_LOCALE, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          title: 'Wake request failed',
          detail: 'The dashboard could not reach the bridge executor to wake the PC.',
          icon: Power
        },
        ...current.slice(0, 2)
      ]);
    }
  };

  const overlays = <>
    {isModelLibraryOpen ? <ModelLibrary onClose={() => setIsModelLibraryOpen(false)} /> : null}
    {isSettingsOpen ? <SettingsPanel apiBaseUrl={API_BASE_URL} onClose={() => setIsSettingsOpen(false)} voiceRoute={voiceRoute} onVoiceRouteChange={setVoiceRoute} addressTerm={addressTerm} onAddressTermChange={setAddressTerm} /> : null}
    {isFamilyOpen ? <FamilyPanel apiBaseUrl={API_BASE_URL} onClose={() => setIsFamilyOpen(false)} /> : null}
  </>;
  if (overview) {
    return <Suspense fallback={<p className="p-6 text-[#633d53]">Opening Overview…</p>}><ControlCenterOverview
      apiBaseUrl={API_BASE_URL}
      stage={<Live2DDock externalPlayback expressionPanelOpen={false} audioLevelRef={dashboardAudio.levelRef} audioUrl={latestAudioUrl} expression={latestExpression} expressionKey={latestExpressionKey} idleExpression={moodExpression} stopSignal={voiceStopSignal} onExpressionResolved={setResolvedExpressionDebug} onModelContextChange={setActiveLive2DModel} />}
      audio={dashboardAudio}
      messages={chatMessages} input={chatInput} onInput={setChatInput}
      onSend={() => void handleSendMessage()} onStopVoice={stopDashboardVoice} sending={isSending}
      services={[{ label: 'Core', state: coreState }, { label: 'Brain', state: brainState }, { label: 'Voice', state: voiceState }, { label: 'WhatsApp', state: bridgeState }]}
      healthUpdatedAt={healthUpdatedAt}
      onSettings={() => setIsSettingsOpen(true)} onFamily={() => setIsFamilyOpen(true)} onModels={() => setIsModelLibraryOpen(true)}
    >{overlays}</ControlCenterOverview></Suspense>;
  }
  return (
    <div
      className="control-center-classic relative h-screen w-screen overflow-hidden bg-[#f8ebf3] text-slate-800"
      style={{
        backgroundImage: 'linear-gradient(135deg, #f7f1f4 0%, #efe8ed 52%, #ebe6eb 100%)'
      }}
    >
      <div className="control-center-grid absolute inset-0 bg-[linear-gradient(rgba(88,55,75,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(88,55,75,0.045)_1px,transparent_1px)] bg-[size:120px_120px]" />

      <div className="control-center-frame absolute left-1/2 top-1/2 origin-center" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className="control-center-canvas relative grid h-[1080px] w-[1920px] grid-cols-[360px_1fr] gap-4 p-5">
          <GlassCard className="control-center-sidebar relative flex min-h-0 flex-col overflow-hidden rounded-[34px] border-[#fff3fb] bg-white/52 p-6 shadow-[0_30px_80px_rgba(98,41,83,0.14)]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.82),transparent_48%),linear-gradient(180deg,rgba(255,222,239,0.58),rgba(255,255,255,0.16)_34%,rgba(164,111,154,0.14)_100%)]" />
          <div className="relative flex items-start justify-between">
            <div>
              <p className="text-[13px] uppercase tracking-[0.32em] text-[#9a6a86]">Lily Console</p>
              <h1 className="mt-3 text-[34px] font-semibold tracking-[-0.04em] text-[#3d2133]">Lily</h1>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="rounded-full bg-white/70 px-3 py-2 text-[11px] font-medium text-[#7e5573] shadow-sm">
                Owner Mode
              </div>
              <button
                type="button"
                onClick={openSweetRoomVariant}
                className="flex items-center gap-2 rounded-full bg-[#f2519a] px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-white shadow-[0_12px_28px_rgba(242,81,154,0.28)] transition hover:bg-[#dc3f88]"
                title="Switch to sweet room control center"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Sweet Room
              </button>
              <button
                type="button"
                onClick={() => setIsModelLibraryOpen(true)}
                className="flex items-center gap-2 rounded-full border border-[#dfb4ca] bg-white/80 px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#75445f] shadow-sm transition hover:border-[#ca7fa5] hover:text-[#4f2c45]"
                title="Open Live2D model library"
              >
                <Library className="h-3.5 w-3.5" />
                Models
              </button>
              <button
                type="button"
                onClick={() => setIsFamilyOpen(true)}
                className="flex items-center gap-2 rounded-full border border-[#dfb4ca] bg-white/80 px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#75445f] shadow-sm transition hover:border-[#ca7fa5] hover:text-[#4f2c45]"
                title="Open owner-only Family devices"
              >
                <UsersRound className="h-3.5 w-3.5" />
                Family
              </button>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="flex items-center gap-2 rounded-full border border-[#dfb4ca] bg-white/80 px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#75445f] shadow-sm transition hover:border-[#ca7fa5] hover:text-[#4f2c45]"
                title="Open Lily runtime settings"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Settings
              </button>
            </div>
          </div>

          <div className="control-center-avatar-stage relative mt-5 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[30px] border border-white/65 bg-[linear-gradient(180deg,rgba(255,244,250,0.96),rgba(241,225,239,0.7))]">
            <div className="absolute inset-x-10 top-10 h-24 rounded-full bg-[#ffd4e7]/45 blur-3xl" />
            <div className="absolute bottom-12 left-1/2 h-44 w-44 -translate-x-1/2 rounded-full bg-[#dfc4f8]/35 blur-3xl" />
            <Live2DDock
              externalPlayback
              audioLevelRef={dashboardAudio.levelRef}
              audioUrl={latestAudioUrl}
              expression={latestExpression}
              expressionKey={latestExpressionKey}
              idleExpression={moodExpression}
              stopSignal={voiceStopSignal}
              onExpressionResolved={setResolvedExpressionDebug}
              onModelContextChange={setActiveLive2DModel}
            />
          </div>

          <div className="relative z-20 mt-3 flex items-center justify-between gap-3 rounded-[20px] border border-white/70 bg-white/48 px-3.5 py-3 text-[#6f425f] shadow-[0_12px_24px_rgba(97,56,88,0.08)]">
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-[#efcade] bg-white/82 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#7f556c] transition hover:border-[#deabc7] hover:text-[#5c2f4d]"
              onClick={() => setIsExpressionDebugVisible((current) => !current)}
              aria-pressed={isExpressionDebugVisible}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Debug
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-[#efcade] bg-white/82 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#7f556c] transition hover:border-[#deabc7] hover:text-[#5c2f4d]"
              onClick={stopDashboardVoice}
              title="Stop current Lily voice"
            >
              <VolumeX className="h-3.5 w-3.5" />
              Stop
            </button>
            {isCoreOffline ? (
              <span
                className="ml-auto flex shrink-0 items-center gap-1.5 text-right text-[12px] font-extrabold text-[#d93f79]"
                title="Dashboard is in local standby until Lily Core reconnects"
              >
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span>Offline</span>
              </span>
            ) : (
              <span className="min-w-0 truncate text-right text-[12px] font-extrabold">
                {isLive2DSpeaking ? 'Voice playing' : latestExpression ?? 'Expression standby'}
              </span>
            )}
          </div>

          {isExpressionDebugVisible ? (
            <div className="relative z-20 mt-2 grid grid-cols-3 gap-2 rounded-[18px] border border-white/70 bg-white/58 p-3 text-[11px] shadow-[0_14px_28px_rgba(97,56,88,0.1)]">
              <span className="grid gap-1 text-[#9d7188]">Emotion <strong className="truncate text-[#442738]">{latestEmotion ?? 'neutral'}</strong></span>
              <span className="grid gap-1 text-[#9d7188]">Requested <strong className="truncate text-[#442738]">{resolvedExpressionDebug?.requested ?? latestExpression ?? 'Blush'}</strong></span>
              <span className="grid gap-1 text-[#9d7188]">Resolved <strong className="truncate text-[#442738]">{resolvedExpressionDebug?.resolved ?? 'Blush'}</strong></span>
              <span className="grid gap-1 text-[#9d7188]">Source <strong className="truncate text-[#442738]">{latestExpressionSource ?? 'standby'}</strong></span>
              <span className="grid gap-1 text-[#9d7188]">Resolver <strong className="truncate text-[#442738]">{resolvedExpressionDebug?.source ?? 'standby'}</strong></span>
              <span className="grid gap-1 text-[#9d7188]">Voice <strong className="truncate text-[#442738]">{isLive2DSpeaking ? 'playing' : 'idle'}</strong></span>
            </div>
          ) : null}

          <div className="relative mt-auto grid grid-cols-2 gap-3 pt-4">
            <div className="rounded-[22px] border border-white/70 bg-white/54 p-3.5">
              <p className="text-[11px] uppercase tracking-[0.24em] text-[#9d7188]">Mood</p>
              <p className="mt-2 text-base font-semibold text-[#442738]">Soft Focus</p>
            </div>
            <div className="rounded-[22px] border border-white/70 bg-white/54 p-3.5">
              <p className="text-[11px] uppercase tracking-[0.24em] text-[#9d7188]">Presence</p>
              <p className="mt-2 text-base font-semibold text-emerald-600">Listening</p>
            </div>
          </div>
          </GlassCard>

          <div className="control-center-workspace grid min-h-0 grid-rows-[148px_532px_332px] gap-4">
            <div className="relative z-20 grid grid-cols-[150px_minmax(0,1fr)] gap-4">
              <GlassCard className="flex h-[148px] flex-col items-center justify-center rounded-[28px] border-white/70 bg-white/62 px-4 text-center shadow-[0_20px_50px_rgba(97,56,88,0.1)]">
              <p className="text-[34px] font-light tracking-[-0.05em] text-[#412738]">
                {currentTime.toLocaleTimeString(DASHBOARD_LOCALE, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false
                })}
              </p>
              <p className="mt-2 text-[11px] uppercase tracking-[0.28em] text-[#987187]">
                {currentTime.toLocaleDateString(DASHBOARD_LOCALE, { weekday: 'long' })}
              </p>
              <p className="mt-1 text-[11px] text-[#7c6172]">
                {currentTime.toLocaleDateString(DASHBOARD_LOCALE, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
                })}
              </p>
              </GlassCard>

              <GlassCard className="h-[148px] rounded-[28px] border-white/70 bg-white/58 px-5 py-4 shadow-[0_20px_50px_rgba(97,56,88,0.1)]">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[13px] uppercase tracking-[0.28em] text-[#9a6c83]">System Status</p>
                  <h2 className="mt-1 text-[21px] font-semibold tracking-[-0.04em] text-[#392130]">Assistant Readiness</h2>
                </div>
                <div className="rounded-full border border-white/70 bg-white/58 px-3 py-2 text-xs text-[#78586b]">
                  last sync {healthUpdatedAt}
                </div>
              </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                {statusChips.map((chip) => (
                  <StatusChip key={chip.label} label={chip.label} status={chip.status} />
                ))}
                </div>
              </GlassCard>
            </div>

            <GlassCard className="relative z-10 min-h-0 overflow-hidden rounded-b-[30px] rounded-t-[18px] border-white/70 bg-white/58 p-5 shadow-[0_24px_60px_rgba(97,56,88,0.12)]">
              <div className="grid h-full min-h-0 grid-cols-[0.92fr_1.08fr] gap-4">
                <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.28em] text-[#9a6c83]">Outside Inbox</p>
                    <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.04em] text-[#392130]">Saved messages</h2>
                  </div>
                  <div className="rounded-full bg-[#4f2c45] px-3 py-2 text-xs font-medium text-white">
                    {inboxItems.length} active
                  </div>
                </div>

                <div className="mt-4 grid min-h-0 gap-2.5 overflow-hidden content-start">
                  {inboxItems.length > 0 ? (
                    inboxItems.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-[22px] border border-white/80 bg-white/66 p-3 shadow-[0_10px_30px_rgba(97,56,88,0.06)]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-[15px] font-semibold text-[#35202c]">{item.sender}</p>
                              <span className="rounded-full bg-[#f2e7ee] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[#8f667c]">
                                {item.relation}
                              </span>
                            </div>
                            <p className="mt-1.5 text-[12px] leading-5 text-[#6f5567]">{item.summary}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-[#8a6c7d]">{item.time}</p>
                            <span className={`mt-3 inline-flex rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${priorityTone(item.priority)}`}>
                              {item.priority}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="flex h-full min-h-[220px] items-center justify-center rounded-[22px] border border-dashed border-white/80 bg-white/42 px-6 text-center text-[13px] leading-6 text-[#7c6172]">
                      No saved WhatsApp messages yet. The newest non-owner message captured by the bridge will appear here.
                    </div>
                  )}
                </div>
                </div>

                <div className="flex min-h-0 flex-col overflow-hidden rounded-[26px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,250,253,0.92),rgba(245,234,242,0.82))] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.28em] text-[#9a6c83]">Focused Thread</p>
                    <h3 className="mt-2 text-[22px] font-semibold tracking-[-0.04em] text-[#3d2435]">{focusedInbox.sender}</h3>
                  </div>
                  <Bell className="h-5 w-5 text-[#8e6d7f]" />
                </div>

                <div className="mt-4 rounded-[22px] bg-[#4e2c44] p-4 text-white shadow-[0_18px_44px_rgba(61,31,51,0.22)]">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/64">Lily summary</p>
                  <p className="mt-3 text-[15px] leading-8 text-white/92">
                    {focusedInbox.summary || 'No summary is available for this thread yet.'}
                  </p>
                </div>

                <div className="mt-4 min-h-[170px] shrink-0 rounded-[22px] border border-[#eccdde] bg-white/84 p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-[#9f768c]">Owner Chat</p>
                  </div>

                  <div className="mt-3 max-h-[72px] space-y-2.5 overflow-y-auto pr-1">
                    {chatMessages.slice(-4).map((message) => {
                      const isOwner = message.role === 'owner';

                      return (
                        <div
                          key={message.id}
                          className={`flex ${isOwner ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[78%] rounded-[18px] px-3.5 py-2.5 text-[12px] leading-6 ${
                              isOwner
                                ? 'bg-[#4e2c44] text-white'
                                : 'bg-[#f8eef4] text-[#5f4354]'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              {message.pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                              <span>{message.text}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex items-center gap-2 rounded-[18px] border border-[#ead5e2] bg-white px-2.5 py-2">
                    <input
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          handleSendMessage();
                        }
                      }}
                      placeholder="Message Lily from this dashboard..."
                      className="flex-1 bg-transparent px-2 text-[12px] text-[#5d4454] outline-none placeholder:text-[#a78999]"
                    />
                    <button
                      onClick={handleSendMessage}
                      disabled={isSending}
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-[#4f2c45] text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="mt-4 shrink-0 rounded-[22px] border border-[#eccdde] bg-white/84 p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-[#9f768c]">Original Message</p>
                  <p className="mt-3 text-[13px] leading-7 text-[#6b5364]">
                    {focusedInbox.preview || 'No original message preview has been saved yet.'}
                  </p>
                </div>

                <div className="mt-4 flex shrink-0 items-center gap-3 pt-1">
                  <button className="rounded-full bg-[#4f2c45] px-5 py-2.5 text-sm font-medium text-white shadow-[0_12px_30px_rgba(79,44,69,0.28)]">
                    Open thread
                  </button>
                  <button className="rounded-full border border-[#d9b2c8] bg-white/75 px-5 py-2.5 text-sm font-medium text-[#6f5164]">
                    Mark as routed
                  </button>
                </div>
                </div>
              </div>
            </GlassCard>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)]">
              <GlassCard className="h-[332px] overflow-hidden rounded-[28px] border-white/70 bg-white/58 p-4 shadow-[0_20px_50px_rgba(97,56,88,0.1)]">
              <HomePanel apiBaseUrl={API_BASE_URL} onWakePc={() => void handleQuickAction('Turn On PC')} />
              </GlassCard>

              <GlassCard className="flex h-[332px] min-h-0 flex-col overflow-hidden rounded-[28px] border-white/70 bg-white/58 p-4 shadow-[0_20px_50px_rgba(97,56,88,0.1)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] uppercase tracking-[0.28em] text-[#9a6c83]">Agent Desk</p>
                  <h3 className="mt-1.5 text-[22px] font-semibold tracking-[-0.04em] text-[#392130]">Owner agent requests</h3>
                </div>
                <div className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] ${openClawReady ? 'bg-emerald-500/12 text-emerald-700' : openClawStatus?.status === 'degraded' ? 'bg-amber-400/15 text-amber-700' : 'bg-rose-500/10 text-rose-700'}`}>
                  {openClawReady ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                  {openClawBadgeLabel}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-[20px] border border-[#eccdde] bg-white/78 px-3 py-2.5">
                <input
                  value={openClawTaskInput}
                  onChange={(event) => setOpenClawTaskInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void handleCreateOpenClawTask();
                    }
                  }}
                  placeholder="Ask Lily to make a file, check the web, or run a tool task..."
                  className="min-w-0 bg-transparent px-1 text-[12px] text-[#5d4454] outline-none placeholder:text-[#aa8a9d]"
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleCreateOpenClawTask();
                  }}
                  disabled={isOpenClawBusy || !openClawTaskInput.trim()}
                  className="flex h-9 min-w-9 items-center justify-center rounded-full bg-[#4f2c45] px-3 text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isOpenClawBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <TerminalSquare className="h-4 w-4" />}
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-[18px] bg-white/70 px-3 py-2.5">
                  <p className="uppercase tracking-[0.18em] text-[#9c7288]">Pending</p>
                  <p className="mt-1 text-base font-semibold text-[#44293b]">{openClawStatus?.pending_count ?? 0}</p>
                </div>
                <div className="rounded-[18px] bg-white/70 px-3 py-2.5">
                  <p className="uppercase tracking-[0.18em] text-[#9c7288]">Running</p>
                  <p className="mt-1 text-base font-semibold text-[#44293b]">{openClawStatus?.running_count ?? 0}</p>
                </div>
              </div>

              <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {openClawRecent.length > 0 ? (
                  openClawRecent.map((task) => (
                    <div key={task.id} className="rounded-[18px] border border-white/75 bg-white/72 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-extrabold text-[#3f2536]">{truncateMiddle(task.task, 74)}</p>
                          <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#9c7288]">
                            {task.action} / {task.source} / {formatOpenClawTaskTime(task.created_at_iso)}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${openClawStatusTone(task.status)}`}>
                          {task.status || 'queued'}
                        </span>
                      </div>

                      {task.result_text || task.error ? (
                        <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-[#715567]">
                          {truncateMiddle(task.result_text || task.error || '', 160)}
                        </p>
                      ) : null}

                      {task.artifacts?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {task.artifacts.map((artifact) => (
                            <a
                              key={artifact.id}
                              href={resolveCoreDownloadUrl(artifact.download_url)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#efb5d1] bg-white/72 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#a64e7c] shadow-[0_8px_20px_rgba(244,91,158,0.08)]"
                              title={`${artifact.name} (${artifact.mime_type})`}
                            >
                              <Paperclip className="h-3 w-3 shrink-0" />
                              <span className="truncate">{truncateMiddle(artifact.name || artifact.id, 34)}</span>
                            </a>
                          ))}
                        </div>
                      ) : null}

                      {task.status === 'pending' ? (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void handleOpenClawApproval(task.id, 'approve');
                            }}
                            className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-white"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void handleOpenClawApproval(task.id, 'deny');
                            }}
                            className="flex items-center gap-1.5 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-[11px] font-bold text-rose-600"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            Deny
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="flex h-full min-h-[78px] items-center justify-center rounded-[18px] border border-dashed border-white/80 bg-white/42 px-4 text-center text-[12px] leading-6 text-[#7c6172]">
                    No agent requests yet. WhatsApp owner commands and dashboard tasks will appear here.
                  </div>
                )}
              </div>
              </GlassCard>

              <GlassCard className="h-[332px] overflow-hidden rounded-[28px] border-white/70 bg-white/58 p-4 shadow-[0_20px_50px_rgba(97,56,88,0.1)]">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[13px] uppercase tracking-[0.28em] text-[#9a6c83]">System Log</p>
                  <h3 className="mt-1.5 text-[22px] font-semibold tracking-[-0.04em] text-[#392130]">Live events around Lily</h3>
                </div>
                <div className="rounded-full bg-[#4f2c45] px-3 py-2 text-[11px] font-medium text-white">
                  realtime
                </div>
              </div>

              <div className="mt-4 space-y-2.5">
                {systemLog.map((item, index) => {
                  const Icon = item.icon;

                  return (
                    <div
                      key={`${item.time}-${item.title}-${index}`}
                      className="rounded-[20px] border border-white/70 bg-white/74 p-3.5"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#ce7197,#7a4a71)] text-white">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-[#392130]">{item.title}</p>
                            <span className="text-[11px] text-[#8f6e80]">{item.time}</span>
                          </div>
                          <p className="mt-1.5 text-[12px] leading-6 text-[#76586a]">{item.detail}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between rounded-[20px] bg-[#4f2c45] px-4 py-3 text-white">
                <div className="flex items-center gap-2">
                  <MoonStar className="h-4 w-4" />
                  <span className="text-sm">Monitoring heartbeat 3 events / 60 sec</span>
                </div>
                <Bot className="h-4 w-4 text-white/70" />
              </div>
              </GlassCard>
            </div>
          </div>
        </div>
      </div>
      {overlays}
    </div>
  );
}

