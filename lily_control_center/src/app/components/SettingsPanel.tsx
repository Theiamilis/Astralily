import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Check,
  CircleAlert,
  EyeOff,
  KeyRound,
  Mic,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react';
import { CORE_URL_STORAGE_KEY, coreFetch } from '../coreApi';
import { ListenerSettings } from './ListenerSettings';
import { DisplaySettings } from './DisplaySettings';
import {
  ADDRESS_TERM_OPTIONS,
  VOICE_ROUTE_OPTIONS,
  type AddressTermId,
  type VoiceRouteId
} from '../voiceRoutes';

type SettingsPanelProps = {
  apiBaseUrl: string;
  onClose: () => void;
  voiceRoute: VoiceRouteId;
  onVoiceRouteChange: (route: VoiceRouteId) => void;
  addressTerm: AddressTermId;
  onAddressTermChange: (term: AddressTermId) => void;
};

type SettingItem = {
  key: string;
  label: string;
  section: 'providers' | 'speech';
  secret: boolean;
  configured: boolean;
  value?: string;
};

type ModuleItem = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  required: boolean;
  status: string;
  url: string;
  setting_key?: string;
  token_key?: string;
  token_configured: boolean;
};

type SettingsResponse = {
  providers?: SettingItem[];
  speech?: SettingItem[];
  modules?: ModuleItem[];
  security?: {
    owner_auth_configured?: boolean;
    owner_auth_enforced?: boolean;
    secrets_returned?: boolean;
  };
};

type SectionId = 'overview' | 'providers' | 'speech' | 'modules' | 'listener' | 'display';

function statusTone(status: string, enabled: boolean) {
  if (!enabled) return 'bg-slate-100 text-slate-500';
  if (status === 'online' || status === 'configured') return 'bg-emerald-50 text-emerald-700';
  if (status === 'disabled') return 'bg-slate-100 text-slate-500';
  if (status === 'degraded') return 'bg-amber-50 text-amber-700';
  return 'bg-rose-50 text-rose-700';
}

function statusLabel(status: string, enabled: boolean) {
  if (!enabled || status === 'disabled') return 'Optional';
  if (status === 'online') return 'Online';
  if (status === 'configured') return 'Configured';
  if (status === 'degraded') return 'Limited';
  if (status === 'offline') return 'Offline';
  if (status === 'unconfigured') return 'No endpoint';
  return 'Not checked';
}

function prettyKey(key: string) {
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function SettingsPanel({
  apiBaseUrl,
  onClose,
  voiceRoute,
  onVoiceRouteChange,
  addressTerm,
  onAddressTermChange
}: SettingsPanelProps) {
  const [section, setSection] = useState<SectionId>('overview');
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [coreUrl, setCoreUrl] = useState(apiBaseUrl);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await coreFetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/settings`);
      if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
      const data = (await response.json()) as SettingsResponse;
      setSettings(data);
      const nextDraft: Record<string, string> = {};
      [...(data.providers ?? []), ...(data.speech ?? [])].forEach((item) => {
        if (!item.secret) nextDraft[item.key] = item.value ?? '';
      });
      (data.modules ?? []).forEach((module) => {
        if (module.setting_key) nextDraft[module.setting_key] = module.url;
      });
      setDraft(nextDraft);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load Core settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, [apiBaseUrl]);

  const allFields = useMemo(
    () => [...(settings?.providers ?? []), ...(settings?.speech ?? [])],
    [settings]
  );

  const setField = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    setError('');
    setNotice('');
    const values: Record<string, unknown> = {};
    allFields.forEach((item) => {
      const value = draft[item.key] ?? '';
      // Empty secret inputs mean “leave the existing secret alone”, not “erase it”.
      if (!item.secret || value.trim()) values[item.key] = value;
    });
    (settings.modules ?? []).forEach((module) => {
      if (module.setting_key) values[module.setting_key] = draft[module.setting_key] ?? module.url;
      if (module.token_key && draft[module.token_key]?.trim()) values[module.token_key] = draft[module.token_key];
    });
    values.disabled_components = (settings.modules ?? [])
      .filter((module) => !module.enabled)
      .map((module) => module.id);

    try {
      const response = await coreFetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(String(payload?.detail || `Settings save failed (${response.status})`));
      }
      const data = (await response.json()) as SettingsResponse & { changed?: string[] };
      setSettings(data);
      const changedCoreUrl = coreUrl.trim().replace(/\/+$/, '') !== apiBaseUrl.replace(/\/+$/, '');
      if (coreUrl.trim()) window.localStorage.setItem(CORE_URL_STORAGE_KEY, coreUrl.trim().replace(/\/+$/, ''));
      setNotice(
        changedCoreUrl
          ? 'Saved. Reload the dashboard to connect to the new Core address.'
          : `${data.changed?.length ?? 0} setting(s) applied to Core.`
      );
      const nextDraft: Record<string, string> = {};
      [...(data.providers ?? []), ...(data.speech ?? [])].forEach((item) => {
        if (!item.secret) nextDraft[item.key] = item.value ?? '';
      });
      (data.modules ?? []).forEach((module) => {
        if (module.setting_key) nextDraft[module.setting_key] = module.url;
      });
      setDraft(nextDraft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save Core settings.');
    } finally {
      setSaving(false);
    }
  };

  const toggleModule = (moduleId: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            modules: (current.modules ?? []).map((module) =>
              module.id === moduleId && !module.required ? { ...module, enabled: !module.enabled } : module
            )
          }
        : current
    );
    setNotice('');
  };

  const navigation = [
    { id: 'display' as const, label: 'Appearance', icon: Sparkles, detail: 'Dashboard mode' },
    { id: 'overview' as const, label: 'Overview', icon: Sparkles, detail: 'Lily runtime' },
    { id: 'providers' as const, label: 'Providers', icon: KeyRound, detail: 'LLM + vision' },
    { id: 'speech' as const, label: 'Speech', icon: Settings2, detail: 'Voice + STT' },
    { id: 'modules' as const, label: 'Modules', icon: Boxes, detail: 'Optional Vessels' },
    { id: 'listener' as const, label: 'Listener', icon: Mic, detail: 'Hands-free voice' }
  ];

  const renderField = (item: SettingItem) => (
    <label className="grid gap-2 rounded-[20px] border border-[#ead8e4] bg-white/75 p-3.5" key={item.key}>
      <span className="flex items-center justify-between gap-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[#81576f]">
        <span>{item.label}</span>
        {item.secret ? <EyeOff className="h-3.5 w-3.5 text-[#aa8298]" /> : null}
      </span>
      <input
        type={item.secret ? 'password' : 'text'}
        value={draft[item.key] ?? ''}
        onChange={(event) => setField(item.key, event.target.value)}
        placeholder={item.secret ? (item.configured ? 'Configured — enter to replace' : 'Not configured') : prettyKey(item.key)}
        autoComplete={item.secret ? 'new-password' : 'off'}
        className="min-w-0 rounded-[14px] border border-[#ead8e4] bg-white px-3 py-2.5 text-[13px] text-[#482b40] outline-none transition placeholder:text-[#b394a7] focus:border-[#c95c91] focus:ring-2 focus:ring-[#e9a8c9]/35"
      />
      {!item.secret && item.configured ? <span className="text-[10px] text-emerald-700">Active in Core</span> : null}
    </label>
  );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[#32182c]/35 p-5 backdrop-blur-md">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-heading" aria-describedby="settings-description" className="relative grid h-[min(820px,calc(100vh-24px))] w-[min(1180px,calc(100vw-24px))] grid-rows-[auto_minmax(0,1fr)] grid-cols-1 overflow-hidden rounded-[28px] border border-white/80 bg-[#fbf2f8] shadow-[0_30px_120px_rgba(61,27,55,0.32)] md:h-[min(820px,calc(100vh-40px))] md:w-[min(1180px,calc(100vw-40px))] md:grid-rows-1 md:grid-cols-[230px_minmax(0,1fr)] md:rounded-[34px]">
        <aside className="relative flex min-h-0 flex-col border-b border-[#eedbe7] bg-[linear-gradient(180deg,#fff8fc,#f7e8f2)] p-3 md:border-b-0 md:border-r md:p-5">
          <div className="mb-3 flex items-center gap-3 md:mb-7">
            <div className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-[#4f2c45] text-white shadow-[0_10px_24px_rgba(79,44,69,0.24)]">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a0748b]">Lily Console</p>
              <h2 className="text-[21px] font-semibold tracking-[-0.04em] text-[#3d2133]">Settings</h2>
            </div>
          </div>
          <nav className="flex flex-wrap gap-1 md:grid md:gap-2" aria-label="Settings sections">
            {navigation.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  className={`flex min-h-11 items-center gap-2 rounded-[16px] px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c4518b] md:gap-3 md:rounded-[18px] md:py-3 ${active ? 'bg-[#4f2c45] text-white shadow-[0_10px_24px_rgba(79,44,69,0.2)]' : 'text-[#76556b] hover:bg-white/75'}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <strong className="block text-[12px] font-semibold">{item.label}</strong>
                    <small className={`hidden text-[10px] md:block ${active ? 'text-white/65' : 'text-[#aa879b]'}`}>{item.detail}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="mt-auto hidden rounded-[20px] border border-[#ecd4e2] bg-white/70 p-3.5 text-[11px] leading-5 text-[#825e73] md:block">
            <ShieldCheck className="mb-2 h-4 w-4 text-emerald-600" />
            Secret values are write-only. Core keeps them locally and never sends them back to this screen.
          </div>
        </aside>

        <div className="flex min-h-0 flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-[#eedbe7] px-4 py-3 md:gap-4 md:px-7 md:py-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-[#a0748b]">{section === 'display' ? 'Your workspace' : section === 'listener' ? 'Device voice input' : 'AIRI-style runtime control'}</p>
              <h1 id="settings-heading" className="mt-1 text-[19px] font-semibold tracking-[-0.04em] text-[#3d2133] md:text-[28px] md:tracking-[-0.05em]">{section === 'display' ? 'Choose your Control Center.' : section === 'listener' ? 'Hands-free voice control' : 'Configure Lily without hunting through .env files.'}</h1>
              <p id="settings-description" className="mt-1 text-[11px] text-[#896a7d] md:text-[12px]">{section === 'display' ? 'Switch layouts to suit what you want to do.' : section === 'listener' ? 'Choose a Listener device and set how Lily responds to a call or double clap.' : 'URLs can point to another PC. Optional Vessels can be switched off safely.'}</p>
            </div>
            <button ref={closeButtonRef} type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#e7cbdc] bg-white/80 text-[#79536b] transition hover:border-[#c96b99] hover:text-[#4f2c45] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c4518b]" aria-label="Close settings">
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
            {section === 'display' ? <DisplaySettings /> : section === 'listener' ? (
              <ListenerSettings apiBaseUrl={apiBaseUrl} />
            ) : loading ? (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-[#8a687d]"><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading Core settings...</div>
            ) : error ? (
              <div className="rounded-[24px] border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800"><CircleAlert className="mb-2 h-5 w-5" />{error}<button type="button" onClick={() => void loadSettings()} className="mt-4 flex items-center gap-2 rounded-full bg-rose-700 px-4 py-2 text-xs font-bold text-white"><RefreshCw className="h-3.5 w-3.5" /> Retry</button></div>
            ) : settings ? (
              <>
                {section === 'overview' ? (
                  <div className="grid gap-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="grid gap-2 rounded-[24px] border border-[#ead8e4] bg-white/76 p-5">
                        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#81576f]"><Server className="h-4 w-4" /> Core connection</span>
                        <input value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} className="rounded-[14px] border border-[#ead8e4] bg-white px-3 py-3 text-[13px] text-[#482b40] outline-none focus:border-[#c95c91]" placeholder="http://100.x.x.x:8000" />
                        <span className="text-[11px] leading-5 text-[#98788b]">Dashboard-only address. Save it here, then reload the dashboard to use the new IP.</span>
                      </label>
                      <div className="rounded-[24px] border border-[#ead8e4] bg-[linear-gradient(135deg,#fff,#f7e8f2)] p-5">
                        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#81576f]"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Security</span>
                        <p className="mt-3 text-[20px] font-semibold text-[#43283b]">{settings.security?.owner_auth_enforced ? 'Owner token protected' : 'Local development mode'}</p>
                        <p className="mt-1 text-[11px] leading-5 text-[#98788b]">{settings.security?.secrets_returned === false ? 'Secrets are never returned by the API.' : 'Review Core authentication before exposing this dashboard.'}</p>
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                      {[
                        { label: 'Provider fields', value: allFields.length, detail: `${allFields.filter((item) => item.configured).length} configured`, icon: KeyRound },
                        { label: 'Enabled modules', value: (settings.modules ?? []).filter((module) => module.enabled).length, detail: `${(settings.modules ?? []).length} catalogued`, icon: Boxes },
                        { label: 'Runtime state', value: 'Live', detail: 'Changes apply to Core now', icon: Check }
                      ].map((card) => {
                        const Icon = card.icon;
                        return <div key={card.label} className="rounded-[22px] border border-[#ead8e4] bg-white/72 p-4"><Icon className="h-4 w-4 text-[#c4518b]" /><p className="mt-3 text-[11px] uppercase tracking-[0.15em] text-[#a0748b]">{card.label}</p><strong className="mt-1 block text-[24px] font-semibold text-[#43283b]">{card.value}</strong><span className="text-[11px] text-[#98788b]">{card.detail}</span></div>;
                      })}
                    </div>
                    <button type="button" onClick={() => setSection('modules')} className="flex items-center justify-between rounded-[24px] border border-[#e9c3d8] bg-[#fff5fb] p-5 text-left transition hover:border-[#c96b99]"><span><strong className="block text-[15px] text-[#4f2c45]">Make the stack lighter</strong><span className="mt-1 block text-[12px] text-[#916e82]">Turn off Vessels you are not using. Core chat and Brain stay protected.</span></span><Boxes className="h-5 w-5 text-[#c4518b]" /></button>
                  </div>
                ) : null}
                {section === 'providers' ? <div className="grid gap-4 md:grid-cols-2">{(settings.providers ?? []).map(renderField)}</div> : null}
                {section === 'speech' ? (
                  <div className="grid gap-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-[22px] border border-[#ead8e4] bg-white/76 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#81576f]">Chat voice route</p>
                            <p className="mt-1 text-[11px] leading-5 text-[#98788b]">Choose the engine used by dashboard chat requests.</p>
                          </div>
                          <span className="rounded-full bg-[#f6e6f0] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#985477]">{voiceRoute}</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Chat voice route">
                          {VOICE_ROUTE_OPTIONS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => onVoiceRouteChange(option.id)}
                              aria-pressed={voiceRoute === option.id}
                              title={option.detail}
                              className={`rounded-full border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition ${voiceRoute === option.id ? 'border-[#4f2c45] bg-[#4f2c45] text-white' : 'border-[#ead5e2] bg-white/70 text-[#875f76] hover:border-[#cda5ba]'}`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-[22px] border border-[#ead8e4] bg-white/76 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#81576f]">Address preference</p>
                            <p className="mt-1 text-[11px] leading-5 text-[#98788b]">How Lily addresses you in generated replies.</p>
                          </div>
                          <span className="rounded-full bg-[#f6e6f0] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#985477]">{addressTerm}</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Address preference">
                          {ADDRESS_TERM_OPTIONS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => onAddressTermChange(option.id)}
                              aria-pressed={addressTerm === option.id}
                              title={option.detail}
                              className={`rounded-full border px-2.5 py-1.5 text-[10px] font-semibold transition ${addressTerm === option.id ? 'border-[#d34183] bg-[#d34183] text-white' : 'border-[#ead5e2] bg-white/70 text-[#875f76] hover:border-[#cda5ba]'}`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">{(settings.speech ?? []).map(renderField)}</div>
                  </div>
                ) : null}
                {section === 'modules' ? (
                  <div className="grid gap-3">
                    <div className="mb-2 rounded-[22px] border border-[#ead8e4] bg-white/72 p-4 text-[12px] leading-6 text-[#806075]">Modules are optional by design. A disabled module is skipped in health aggregation and can be enabled again whenever its PC/service is available.</div>
                    {(settings.modules ?? []).map((module) => (
                      <div key={module.id} className="rounded-[22px] border border-[#ead8e4] bg-white/76 p-4">
                        <div className="flex items-center gap-4">
                        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] ${module.enabled ? 'bg-[#4f2c45] text-white' : 'bg-slate-100 text-slate-400'}`}><Boxes className="h-5 w-5" /></div>
                        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-[14px] text-[#43283b]">{module.label}</strong><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${statusTone(module.status, module.enabled)}`}>{statusLabel(module.status, module.enabled)}</span>{module.required ? <span className="rounded-full bg-[#f6e6f0] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#985477]">Required</span> : null}</div><p className="mt-1 text-[11px] text-[#98788b]">{module.description}</p>{module.url ? <p className="mt-1 truncate font-mono text-[10px] text-[#b0839b]">{module.url}</p> : null}</div>
                        <button type="button" disabled={module.required} onClick={() => toggleModule(module.id)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${module.enabled ? 'bg-[#d74f91]' : 'bg-slate-300'} disabled:cursor-not-allowed disabled:opacity-60`} aria-label={`${module.enabled ? 'Disable' : 'Enable'} ${module.label}`} aria-pressed={module.enabled}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition ${module.enabled ? 'left-6' : 'left-1'}`} /></button>
                        </div>
                        {module.setting_key ? <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <input value={draft[module.setting_key] ?? module.url} onChange={(event) => setField(module.setting_key ?? '', event.target.value)} className="min-w-0 rounded-[13px] border border-[#ead8e4] bg-white px-3 py-2.5 font-mono text-[11px] text-[#482b40] outline-none focus:border-[#c95c91]" placeholder="http://192.168.x.x:port" aria-label={`${module.label} URL`} />
                          {module.token_key ? <input type="password" value={draft[module.token_key] ?? ''} onChange={(event) => setField(module.token_key ?? '', event.target.value)} className="min-w-0 rounded-[13px] border border-[#ead8e4] bg-white px-3 py-2.5 text-[11px] text-[#482b40] outline-none focus:border-[#c95c91]" placeholder={module.token_configured ? 'Token configured — enter to replace' : 'Optional service token'} aria-label={`${module.label} token`} autoComplete="new-password" /> : null}
                        </div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#eedbe7] bg-white/45 px-4 py-3 md:flex-nowrap md:gap-4 md:px-7 md:py-4">
            <div className="min-w-0 text-[11px] text-[#896a7d]">{section === 'display' ? 'Appearance changes are saved immediately in this browser.' : section === 'listener' ? 'Listener controls go through Core; device tokens stay on Core.' : error ? <span className="flex items-center gap-1.5 text-rose-700"><CircleAlert className="h-3.5 w-3.5" />{error}</span> : notice ? <span className="flex items-center gap-1.5 text-emerald-700"><Check className="h-3.5 w-3.5" />{notice}</span> : 'Changes are stored by Lily Core.'}</div>
            {section !== 'listener' && section !== 'display' ? <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => void loadSettings()} className="flex min-h-11 items-center gap-2 rounded-full border border-[#dfc0d2] bg-white/80 px-4 py-2.5 text-xs font-bold text-[#76536a]"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button><button type="button" onClick={() => void saveSettings()} disabled={saving || loading || !settings} className="flex min-h-11 items-center gap-2 rounded-full bg-[#4f2c45] px-5 py-2.5 text-xs font-bold text-white shadow-[0_10px_24px_rgba(79,44,69,0.22)] disabled:cursor-not-allowed disabled:opacity-55">{saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save settings</button></div> : null}
          </footer>
        </div>
      </section>
    </div>
  );
}
