import { useEffect, useState } from 'react';
import { CircleAlert, Headphones, Mic, Pause, Play, RefreshCw, Save, Settings2, Trash2, Volume2 } from 'lucide-react';
import { coreFetch } from '../coreApi';

type ListenerNode = { id: string; label: string; url: string; token_configured: boolean };
type AudioDevice = { id: number; name: string; inputs: number; outputs: number; default_input?: boolean; default_output?: boolean };
type ListenerOptions = {
  input_device: number | null;
  output_device: number | null;
  activation: 'clap_or_phrase' | 'clap_phrase' | 'clap';
  clap_peak: number;
  speech_rms: number;
  silence_seconds: number;
  input_language: string;
  voice_language: 'en' | 'ja';
  voice_profile: string;
};
type ListenerStatus = {
  device_id: string;
  state: string;
  enabled: boolean;
  autostart: boolean;
  last_error: string;
  last_outcome: string;
  completed: number;
  greeting: string;
  options: ListenerOptions;
  capabilities: { clap: boolean; phrase_after_clap: boolean; continuous_wake_word: boolean };
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await coreFetch(url, init);
  } catch {
    throw new Error('Could not reach Lily Core. Check the Core URL and whether Core is running.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : null;
    throw new Error(typeof detail === 'string' ? detail : `Listener request failed (${response.status}).`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('Listener returned an invalid response.');
  return payload as T;
}

function listenerStateLabel(status: ListenerStatus | null) {
  if (!status) return 'Connecting';
  const labels: Record<string, string> = {
    paused: 'Paused', standby: status.options.activation === 'clap_or_phrase' ? 'Listening for claps or Lily' : 'Listening for two claps', queued: 'Starting request',
    listening_for_call: 'Waiting for wake phrase', listening: 'Listening to you',
    recognizing_call: 'Checking wake phrase', greeting: 'Playing greeting',
    transcribing: 'Transcribing speech', processing: 'Lily is thinking',
    speaking: 'Lily is replying', reconnecting: 'Reconnecting microphone', error: 'Needs attention'
  };
  return labels[status.state] ?? status.state.replaceAll('_', ' ');
}

function stateTone(status: ListenerStatus | null, error: string) {
  if (error || status?.state === 'error' || status?.last_error) return 'border-rose-200 bg-rose-50 text-rose-800';
  if (status?.enabled) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return 'border-[#ead8e4] bg-white/75 text-[#76536a]';
}

const fieldClass = 'min-h-11 w-full rounded-[14px] border border-[#ead8e4] bg-white px-3 py-2.5 text-[13px] text-[#482b40] outline-none transition focus-visible:border-[#c95c91] focus-visible:ring-2 focus-visible:ring-[#e9a8c9]/45';
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c4518b] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function ListenerSettings({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [listeners, setListeners] = useState<ListenerNode[]>([]);
  const [registryDraft, setRegistryDraft] = useState<ListenerNode[]>([]);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryAvailable, setRegistryAvailable] = useState(false);
  const [registrySaving, setRegistrySaving] = useState(false);
  const [newDevice, setNewDevice] = useState({ id: 'lily-core-host', label: 'lily-core-host', url: '', token: '' });
  const [listenerId, setListenerId] = useState('');
  const [status, setStatus] = useState<ListenerStatus | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [audioDeviceError, setAudioDeviceError] = useState('');
  const [audioDeviceLoading, setAudioDeviceLoading] = useState(false);
  const [options, setOptions] = useState<ListenerOptions | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingOptions, setSavingOptions] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');

  useEffect(() => {
    let cancelled = false;
    setRegistryLoading(true);
    setError('');
    void requestJson<{ listeners: ListenerNode[] }>(`${baseUrl}/api/listeners/registry`)
      .then(({ listeners: nextListeners }) => {
        if (cancelled) return;
        const available = Array.isArray(nextListeners) ? nextListeners : [];
        setRegistryAvailable(true);
        setListeners(available);
        setRegistryDraft(available);
        setRegistryOpen(available.length === 0);
        setListenerId((current) => available.some((item) => item.id === current) ? current : (available[0]?.id ?? ''));
      })
      .catch((loadError) => {
        if (!cancelled) {
          setRegistryAvailable(false);
          setError(loadError instanceof Error ? loadError.message : 'Could not load Listener devices.');
        }
      })
      .finally(() => { if (!cancelled) setRegistryLoading(false); });
    return () => { cancelled = true; };
  }, [baseUrl]);

  useEffect(() => {
    if (!listenerId) {
      setStatus(null);
      setOptions(null);
      setDevices([]);
      setAudioDeviceError('');
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    setStatusLoading(true);
    setStatus(null);
    setOptions(null);
    setDevices([]);
    setAudioDeviceError('');

    const statusUrl = `${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/status`;
    const refresh = async () => {
      try {
        const nextStatus = await requestJson<ListenerStatus>(statusUrl);
        if (cancelled) return;
        setStatus(nextStatus);
        setOptions(nextStatus.options);
        setError('');
        setAudioDeviceLoading(true);
        try {
          const deviceResponse = await requestJson<{ devices: AudioDevice[] }>(`${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/devices`);
          if (cancelled) return;
          setDevices(Array.isArray(deviceResponse.devices) ? deviceResponse.devices : []);
          setAudioDeviceError('');
        } catch (deviceError) {
          if (!cancelled) setAudioDeviceError(deviceError instanceof Error ? deviceError.message : 'Could not list audio devices.');
        } finally {
          if (!cancelled) setAudioDeviceLoading(false);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not connect to this Listener.');
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };
    void refresh();

    const poll = async () => {
      try {
        const nextStatus = await requestJson<ListenerStatus>(statusUrl);
        if (!cancelled) {
          setStatus(nextStatus);
          setError('');
        }
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : 'Listener status could not be refreshed.');
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 5000);
      }
    };
    timer = window.setTimeout(() => void poll(), 5000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [baseUrl, listenerId]);

  const updateOption = <K extends keyof ListenerOptions>(key: K, value: ListenerOptions[K]) => {
    setOptions((current) => current ? { ...current, [key]: value } : current);
    setNotice('');
  };

  const refreshRegistry = async () => {
    setRegistryLoading(true);
    setError('');
    try {
      const data = await requestJson<{ listeners: ListenerNode[] }>(`${baseUrl}/api/listeners/registry`);
      const available = Array.isArray(data.listeners) ? data.listeners : [];
      setRegistryAvailable(true);
      setListeners(available);
      setRegistryDraft(available);
      setListenerId((current) => available.some((item) => item.id === current) ? current : (available[0]?.id ?? ''));
      setNotice('Listener registry refreshed.');
    } catch (loadError) {
      setRegistryAvailable(false);
      setError(loadError instanceof Error ? loadError.message : 'Could not load Listener devices.');
    } finally {
      setRegistryLoading(false);
    }
  };

  const saveRegistry = async () => {
    const hasNewDevice = Boolean(newDevice.id.trim() && newDevice.url.trim() && newDevice.token.trim());
    const hasRemoval = registryDraft.length < listeners.length;
    if (!hasNewDevice && !hasRemoval) return;
    setRegistrySaving(true);
    setError('');
    setNotice('');
    try {
      const entries: Array<{ id: string; label: string; url: string; token?: string }> = registryDraft.map(({ id, label, url }) => ({ id, label, url }));
      if (hasNewDevice) entries.push({
        id: newDevice.id.trim(), label: newDevice.label.trim(), url: newDevice.url.trim(), token: newDevice.token.trim()
      });
      const result = await requestJson<{ listeners: ListenerNode[] }>(`${baseUrl}/api/listeners/registry`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listeners: entries })
      });
      const available = Array.isArray(result.listeners) ? result.listeners : [];
      setListeners(available);
      setRegistryDraft(available);
      setListenerId((current) => available.some((item) => item.id === current) ? current : (available[0]?.id ?? ''));
      setNewDevice({ id: '', label: '', url: '', token: '' });
      setRegistryOpen(false);
      setNotice('Listener registry saved on Core. The device must still be running and reachable.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save Listener registry.');
    } finally {
      setRegistrySaving(false);
    }
  };

  const refreshStatus = async () => {
    if (!listenerId) return;
    setStatusLoading(true);
    setError('');
    try {
      const nextStatus = await requestJson<ListenerStatus>(`${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/status`);
      setStatus(nextStatus);
      setOptions(nextStatus.options);
      setNotice('Listener status refreshed.');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not connect to this Listener.');
    } finally {
      setStatusLoading(false);
    }
  };

  const refreshAudioDevices = async () => {
    if (!listenerId) return;
    setAudioDeviceLoading(true);
    setAudioDeviceError('');
    try {
      const response = await requestJson<{ devices: AudioDevice[] }>(`${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/devices`);
      setDevices(Array.isArray(response.devices) ? response.devices : []);
      setNotice('Audio devices refreshed.');
    } catch (deviceError) {
      setAudioDeviceError(deviceError instanceof Error ? deviceError.message : 'Could not list audio devices.');
    } finally {
      setAudioDeviceLoading(false);
    }
  };

  const performAction = async (action: 'enable' | 'pause' | 'cancel' | 'listen' | 'test-greeting') => {
    if (!listenerId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const nextStatus = await requestJson<ListenerStatus>(`${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'control_center' })
      });
      setStatus(nextStatus);
      setOptions(nextStatus.options);
      const messages: Record<typeof action, string> = {
        enable: 'Listener is active. It will release the mic when paused.',
        pause: 'Listener paused; the microphone is released.',
        cancel: 'Current interaction cancelled.',
        listen: 'One voice request queued for this dashboard.',
        'test-greeting': 'Greeting queued for immediate playback.'
      };
      setNotice(messages[action]);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Listener action failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveOptions = async () => {
    if (!listenerId || !options) return;
    setSavingOptions(true);
    setError('');
    setNotice('');
    try {
      const nextStatus = await requestJson<ListenerStatus>(`${baseUrl}/api/listeners/${encodeURIComponent(listenerId)}/options`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options)
      });
      setStatus(nextStatus);
      setOptions(nextStatus.options);
      setNotice('Audio and wake settings saved on the Listener device.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save Listener options.');
    } finally {
      setSavingOptions(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const idle = status?.state === 'standby';
  const optionDisabled = !options || enabled || savingOptions;
  const inputs = devices.filter((device) => device.inputs > 0);
  const outputs = devices.filter((device) => device.outputs > 0);
  const missingInput = options?.input_device != null && !inputs.some((device) => device.id === options.input_device);
  const missingOutput = options?.output_device != null && !outputs.some((device) => device.id === options.output_device);
  const defaultInput = inputs.find((device) => device.default_input)?.name;
  const defaultOutput = outputs.find((device) => device.default_output)?.name;
  const hasNewDevice = Boolean(newDevice.id.trim() && newDevice.url.trim() && newDevice.token.trim());
  const hasRegistryChanges = hasNewDevice || registryDraft.length < listeners.length;

  return (
    <div className="grid gap-4">
      <section className={`rounded-[24px] border p-4 md:p-5 ${stateTone(status, error)}`} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-white/80 text-[#4f2c45]"><Mic className="h-5 w-5" /></div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">Hands-free voice</p>
              <h2 className="mt-0.5 truncate text-[18px] font-semibold">{error ? 'Unavailable' : !registryLoading && listeners.length === 0 ? 'No Listener registered' : listenerStateLabel(status)}</h2>
              {status ? <p className="mt-0.5 text-[11px] opacity-75">{listeners.find((item) => item.id === listenerId)?.label ?? status.device_id} · {status.completed} replies completed</p> : null}
            </div>
          </div>
          <div className="grid min-w-[190px] flex-1 gap-2 md:max-w-[270px]">
            <label className="grid gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em]">
              Listener device
              <select className={fieldClass} value={listenerId} onChange={(event) => { setListenerId(event.target.value); setNotice(''); setError(''); }} disabled={registryLoading || Boolean(error) || listeners.length === 0}>
                {listeners.length === 0 ? <option value="">{registryLoading ? 'Loading Listener list…' : error ? 'Listener list unavailable' : 'No Listener registered'}</option> : null}
                {listeners.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            {!registryLoading && registryAvailable ? <button type="button" className={`${buttonClass} w-full border-[#dfc0d2] bg-white/80 text-[#76536a] hover:border-[#c96b99]`} onClick={() => {
              if (!registryOpen) {
                setRegistryDraft(listeners);
                setNewDevice({ id: listeners.length ? '' : 'lily-core-host', label: listeners.length ? '' : 'lily-core-host', url: '', token: '' });
              }
              setRegistryOpen((current) => !current);
              setError('');
              setNotice('');
            }}><Settings2 className="h-3.5 w-3.5" /> {registryOpen ? 'Close device setup' : 'Manage devices'}</button> : null}
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-5 opacity-80">The mic stays open on the Listener device while active. Two claps are checked locally. In clap-or-phrase mode, short speech segments also go to local STT to check for Lily's name.</p>
        {status ? <p className="mt-2 text-[11px] opacity-75">Mic autostart {status.autostart ? 'enabled on this device' : 'off; the mic starts paused after a service restart'}.</p> : null}
        {status?.last_error ? <p className="mt-3 rounded-[14px] border border-rose-200 bg-white/75 px-3 py-2 text-[12px] text-rose-800" role="status">{status.last_error}</p> : null}
      </section>

      {error ? <div className="flex items-start gap-2 rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] leading-5 text-rose-800" role="alert"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <p className="rounded-[16px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12px] text-emerald-800" role="status">{notice}</p> : null}

      {!registryLoading && registryAvailable && registryOpen ? (
        <section className="grid gap-4 rounded-[22px] border border-[#ead8e4] bg-white/76 p-4 md:p-5">
          <div>
            <h3 className="text-[15px] font-semibold text-[#43283b]">Connect an always-on Listener</h3>
            <p className="mt-1 text-[12px] leading-5 text-[#98788b]">On lily-core-host, run <code className="rounded bg-[#f6e6f0] px-1.5 py-0.5">bash setup_linux.sh</code>, set its Core URL and owner token in <code className="rounded bg-[#f6e6f0] px-1.5 py-0.5">.env</code>, and bind the Listener to its private network interface. Then enter its private LAN or Tailscale address and service token below. Setup generates that token locally and keeps the .env file private.</p>
            <p className="mt-2 text-[11px] leading-5 text-[#98788b]">Registration only saves the Core route; it does not contact or activate the microphone. For boot-time microphone startup after hardware is ready, run <code className="rounded bg-[#f6e6f0] px-1.5 py-0.5">bash install_user_service.sh --start-on-boot</code> on lily-core-host.</p>
          </div>
          {registryDraft.length ? <div className="grid gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#81576f]">Registered devices</p>
            {registryDraft.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-[16px] border border-[#ead8e4] bg-white p-3">
              <div className="min-w-0 flex-1"><strong className="block text-[12px] text-[#43283b]">{item.label}</strong><span className="block truncate font-mono text-[10px] text-[#98788b]">{item.id} · {item.url} · token configured</span></div>
              <button type="button" className={`${buttonClass} border-rose-200 bg-rose-50 px-3 text-rose-800 hover:border-rose-300`} onClick={() => setRegistryDraft((current) => current.filter((node) => node.id !== item.id))} aria-label={`Remove ${item.label} from Core registry`} title="Remove this Core route"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
            </div>)}
          </div> : null}
          {registryDraft.length < 16 ? <div className="grid gap-3 border-t border-[#ead8e4] pt-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">Device ID
              <input className={fieldClass} value={newDevice.id} onChange={(event) => setNewDevice((current) => ({ ...current, id: event.target.value }))} placeholder="lily-core-host" autoComplete="off" />
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Must match LILY_LISTENER_DEVICE_ID on the device.</span>
            </label>
            <label className="grid gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">Display name
              <input className={fieldClass} value={newDevice.label} onChange={(event) => setNewDevice((current) => ({ ...current, label: event.target.value }))} placeholder="lily-core-host" maxLength={80} autoComplete="off" />
            </label>
            <label className="grid gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">Listener URL
              <input className={fieldClass} type="url" value={newDevice.url} onChange={(event) => setNewDevice((current) => ({ ...current, url: event.target.value }))} placeholder="http://100.x.y.z:10892" autoComplete="url" />
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Use an address reachable from Core on a private or Tailscale network.</span>
            </label>
            <label className="grid gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">Listener service token
              <input className={fieldClass} type="password" value={newDevice.token} onChange={(event) => setNewDevice((current) => ({ ...current, token: event.target.value }))} placeholder="Copy from lily-core-host's lily_listener_vessel/.env" autoComplete="new-password" />
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Stored in Core's protected runtime settings; never returned to this screen.</span>
            </label>
          </div> : <p className="text-[12px] text-[#98788b]">Core supports up to 16 Listener devices.</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" className={`${buttonClass} border-[#dfc0d2] bg-white/80 text-[#76536a] hover:border-[#c96b99]`} onClick={() => void refreshRegistry()} disabled={registryLoading}><RefreshCw className={`h-3.5 w-3.5 ${registryLoading ? 'animate-spin' : ''}`} /> Refresh registry</button>
            <button type="button" className={`${buttonClass} border-[#d34183] bg-[#d34183] text-white hover:bg-[#bb3972]`} onClick={() => void saveRegistry()} disabled={registrySaving || !hasRegistryChanges || Boolean(newDevice.token.trim() && (!newDevice.id.trim() || !newDevice.url.trim()))}><Save className="h-3.5 w-3.5" /> {registrySaving ? 'Saving…' : 'Save device list'}</button>
          </div>
        </section>
      ) : null}

      {listenerId ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-[#ead8e4] bg-white/76 px-4 py-3">
            <p className="text-[12px] text-[#76536a]">Choose audio devices connected to {listeners.find((item) => item.id === listenerId)?.label ?? listenerId}. Changes are saved while Listener is paused.</p>
            <button type="button" className={`${buttonClass} border-[#dfc0d2] bg-white text-[#76536a] hover:border-[#c96b99]`} onClick={() => void refreshAudioDevices()} disabled={audioDeviceLoading || statusLoading}><RefreshCw className={`h-3.5 w-3.5 ${audioDeviceLoading ? 'animate-spin' : ''}`} /> Refresh audio devices</button>
          </div>
          {audioDeviceError ? <p className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800" role="alert">{audioDeviceError}</p> : null}
          <section className="grid gap-4 rounded-[22px] border border-[#ead8e4] bg-white/76 p-4 md:grid-cols-2 md:p-5">
            <label className="grid content-start gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              <span className="flex items-center gap-2"><Mic className="h-3.5 w-3.5" /> Microphone</span>
              <select className={fieldClass} value={options?.input_device ?? ''} onChange={(event) => updateOption('input_device', event.target.value === '' ? null : Number(event.target.value))} disabled={optionDisabled}>
                <option value="">System default{defaultInput ? ` · ${defaultInput}` : ''}</option>
                {missingInput ? <option value={options?.input_device ?? ''}>Unavailable · device {options?.input_device}</option> : null}
                {inputs.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.inputs} in{device.default_input ? ' · default' : ''}</option>)}
              </select>
              {!audioDeviceLoading && !audioDeviceError && inputs.length === 0 ? <span className="text-[11px] font-normal normal-case tracking-normal text-rose-700">No microphone detected on this Listener device.</span> : null}
            </label>
            <label className="grid content-start gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              <span className="flex items-center gap-2"><Volume2 className="h-3.5 w-3.5" /> Speaker</span>
              <select className={fieldClass} value={options?.output_device ?? ''} onChange={(event) => updateOption('output_device', event.target.value === '' ? null : Number(event.target.value))} disabled={optionDisabled}>
                <option value="">System default{defaultOutput ? ` · ${defaultOutput}` : ''}</option>
                {missingOutput ? <option value={options?.output_device ?? ''}>Unavailable · device {options?.output_device}</option> : null}
                {outputs.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.outputs} out{device.default_output ? ' · default' : ''}</option>)}
              </select>
              {!audioDeviceLoading && !audioDeviceError && outputs.length === 0 ? <span className="text-[11px] font-normal normal-case tracking-normal text-rose-700">No speaker detected on this Listener device.</span> : null}
            </label>
            <label className="grid content-start gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              Wake method
              <select className={fieldClass} value={options?.activation ?? 'clap_or_phrase'} onChange={(event) => updateOption('activation', event.target.value as ListenerOptions['activation'])} disabled={optionDisabled}>
                <option value="clap_or_phrase">Two claps or say “Lily wake up / Lily okite”</option>
                <option value="clap">Two claps, greeting, then speak</option>
                <option value="clap_phrase">Two claps, then say “Lily wakeup” or “Lily okite”</option>
              </select>
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Two claps greet in English. A spoken call uses local STT, then greets in English or Japanese based on the phrase.</span>
            </label>
            <label className="grid content-start gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              Speech language
              <select className={fieldClass} value={options?.input_language ?? 'auto'} onChange={(event) => updateOption('input_language', event.target.value)} disabled={optionDisabled}>
                <option value="auto">Auto-detect</option><option value="id">Indonesian</option><option value="en">English</option><option value="ja">Japanese</option>
              </select>
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Auto accepts Indonesian, English, or Japanese commands. Choose a language only if detection struggles.</span>
            </label>
            <div className="grid content-start gap-1.5 rounded-[14px] border border-[#ead8e4] bg-[#fff9fc] px-3 py-3 text-[11px] leading-5 text-[#81576f]">
              <strong className="text-[10px] uppercase tracking-[0.13em]">Spoken replies use English or Japanese</strong>
              <span>“Lily okite” selects Japanese; claps and English calls select English. Indonesian commands still work.</span>
            </div>
            <label className="grid gap-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              <span className="flex items-center justify-between gap-3">Clap threshold <output className="rounded-full bg-[#f6e6f0] px-2.5 py-1 text-[11px] font-semibold normal-case tracking-normal text-[#985477]">{options?.clap_peak.toFixed(2) ?? '—'}</output></span>
              <input className="w-full accent-[#c4518b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c4518b]" type="range" min="0.05" max="0.95" step="0.01" value={options?.clap_peak ?? 0.35} onChange={(event) => updateOption('clap_peak', Number(event.target.value))} disabled={optionDisabled} aria-label="Clap volume threshold" />
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Lower values detect softer claps; raise it if room noise triggers Lily.</span>
            </label>
            <label className="grid gap-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#81576f]">
              <span className="flex items-center justify-between gap-3">End-of-speech pause <output className="rounded-full bg-[#f6e6f0] px-2.5 py-1 text-[11px] font-semibold normal-case tracking-normal text-[#985477]">{options ? `${options.silence_seconds.toFixed(1)} s` : '—'}</output></span>
              <input className="w-full accent-[#c4518b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c4518b]" type="range" min="0.4" max="3" step="0.1" value={options?.silence_seconds ?? 0.9} onChange={(event) => updateOption('silence_seconds', Number(event.target.value))} disabled={optionDisabled} aria-label="Pause length before sending speech" />
              <span className="text-[11px] font-normal normal-case tracking-normal text-[#98788b]">Longer pauses give you more time between sentences.</span>
            </label>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {enabled ? (
                <button type="button" className={`${buttonClass} border-[#4f2c45] bg-[#4f2c45] text-white hover:bg-[#613752]`} onClick={() => void performAction('pause')} disabled={busy}><Pause className="h-3.5 w-3.5" /> Pause and release mic</button>
              ) : (
                <button type="button" className={`${buttonClass} border-[#4f2c45] bg-[#4f2c45] text-white hover:bg-[#613752]`} onClick={() => void performAction('enable')} disabled={busy || statusLoading || !status}><Play className="h-3.5 w-3.5" /> Start listening</button>
              )}
              <button type="button" title="Start one voice request now" className={`${buttonClass} border-[#dfc0d2] bg-white/80 text-[#76536a] hover:border-[#c96b99]`} onClick={() => void performAction('listen')} disabled={busy || !enabled || !idle}>Listen once now</button>
              <button type="button" className={`${buttonClass} border-[#dfc0d2] bg-white/80 text-[#76536a] hover:border-[#c96b99]`} onClick={() => void performAction('test-greeting')} disabled={busy || !enabled || !idle}>Test greeting</button>
              {enabled && status?.state !== 'standby' ? <button type="button" className={`${buttonClass} border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-300`} onClick={() => void performAction('cancel')} disabled={busy}>Cancel request</button> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`${buttonClass} border-[#dfc0d2] bg-white/80 text-[#76536a] hover:border-[#c96b99]`} onClick={() => void refreshStatus()} disabled={statusLoading}><RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? 'animate-spin' : ''}`} /> Refresh status</button>
              <button type="button" className={`${buttonClass} border-[#d34183] bg-[#d34183] text-white hover:bg-[#bb3972]`} onClick={() => void saveOptions()} disabled={optionDisabled || statusLoading || missingInput || missingOutput}><Save className="h-3.5 w-3.5" /> Save audio and wake settings</button>
            </div>
          </div>
          {enabled ? <p className="text-[11px] text-[#98788b]">Pause first to change microphone settings. To start hands-free after reboot, enable autostart on the Listener device.</p> : null}
        </>
      ) : null}
      {registryLoading || statusLoading ? <p className="flex items-center gap-2 text-[11px] text-[#98788b]" role="status"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> {registryLoading ? 'Loading Listener registry…' : 'Connecting to Listener…'}</p> : null}
      {status?.capabilities?.continuous_wake_word ? <p className="flex items-center gap-2 text-[11px] text-[#98788b]"><Headphones className="h-3.5 w-3.5" /> In clap-or-phrase mode, speech in the room is checked by local STT for a wake phrase. A mic and speaker on the Listener host are required.</p> : <p className="flex items-center gap-2 text-[11px] text-[#98788b]"><Headphones className="h-3.5 w-3.5" /> This Listener version supports two-clap detection only.</p>}
    </div>
  );
}
