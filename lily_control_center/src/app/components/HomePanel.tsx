import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BriefcaseBusiness,
  Gamepad2,
  House,
  Lightbulb,
  LoaderCircle,
  MoonStar,
  MonitorCog,
  Palette,
  Power,
  PowerOff,
  RefreshCcw,
  Save,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { coreFetch, subscribeCoreEvents } from '../coreApi';
import { DevicePowerPanel } from './DevicePowerPanel';

type HomeDevice = {
  id: string;
  provider: string;
  kind: string;
  name: string;
  room: string;
  aliases: string[];
};

type HomeState = {
  device_id: string;
  online: boolean;
  connection?: 'online' | 'reconnecting' | 'offline';
  last_seen?: string | null;
  consecutive_failures?: number;
  state?: boolean | null;
  brightness?: number | null;
  temperature_kelvin?: number | null;
  rgb?: number[] | null;
};

type HomeScene = {
  id: string;
  name: string;
  action_count: number;
  read_only: boolean;
};

type HomePanelProps = {
  apiBaseUrl: string;
  onWakePc?: () => void;
  lightsOnly?: boolean;
  compact?: boolean;
};

type HomeNotice = {
  tone: 'good' | 'warning';
  text: string;
};

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.detail || `Home request failed: ${response.status}`));
  }
  return payload;
}

function sceneIdFromName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `scene_${Date.now()}`;
}

function formatLastSeen(value?: string | null) {
  if (!value) return 'Never reached';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Last seen unavailable';
  return `Last seen ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function sceneIcon(sceneId: string) {
  const iconClass = 'h-3.5 w-3.5 shrink-0';
  if (sceneId === 'work') return <BriefcaseBusiness className={iconClass} />;
  if (sceneId === 'gaming') return <Gamepad2 className={iconClass} />;
  if (sceneId === 'chill') return <Sparkles className={iconClass} />;
  if (sceneId === 'sleep') return <MoonStar className={iconClass} />;
  if (sceneId === 'all_off') return <PowerOff className={iconClass} />;
  if (sceneId === 'all_on') return <Power className={iconClass} />;
  return <House className={iconClass} />;
}

export function HomePanel({ apiBaseUrl, onWakePc, lightsOnly = false, compact = false }: HomePanelProps) {
  const [view, setView] = useState<'lights' | 'computers'>('lights');
  const [devices, setDevices] = useState<HomeDevice[]>([]);
  const [states, setStates] = useState<Record<string, HomeState>>({});
  const [scenes, setScenes] = useState<HomeScene[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [brightnessDraft, setBrightnessDraft] = useState(50);
  const [kelvinDraft, setKelvinDraft] = useState(4000);
  const [sceneName, setSceneName] = useState('');
  const [scenePage, setScenePage] = useState(0);
  const [editingScene, setEditingScene] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<HomeNotice | null>(null);
  const previousStatesRef = useRef<Record<string, HomeState> | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((nextNotice: HomeNotice) => {
    setNotice(nextNotice);
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8_000);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const [devicePayload, scenePayload] = await Promise.all([
        coreFetch(`${apiBaseUrl}/api/home/devices`).then(readJson),
        coreFetch(`${apiBaseUrl}/api/home/scenes`).then(readJson),
      ]);
      const nextDevices = Array.isArray(devicePayload?.devices) ? devicePayload.devices : [];
      const stateRows = await Promise.all(
        nextDevices.map(async (device: HomeDevice) => {
          try {
            const state = await coreFetch(`${apiBaseUrl}/api/home/devices/${encodeURIComponent(device.id)}/state`).then(readJson);
            return [device.id, state] as const;
          } catch {
            return [device.id, { device_id: device.id, online: false, connection: 'offline' }] as const;
          }
        }),
      );
      const nextStates = Object.fromEntries(stateRows) as Record<string, HomeState>;
      const previousStates = previousStatesRef.current;
      if (previousStates) {
        const wentOffline = nextDevices.filter((device: HomeDevice) => (
          previousStates[device.id]?.connection !== 'offline'
          && nextStates[device.id]?.connection === 'offline'
        ));
        const recovered = nextDevices.filter((device: HomeDevice) => (
          previousStates[device.id]?.connection !== 'online'
          && nextStates[device.id]?.connection === 'online'
        ));
        if (wentOffline.length) {
          showNotice({ tone: 'warning', text: `${wentOffline.map((device: HomeDevice) => device.name).join(', ')} went offline.` });
        } else if (recovered.length) {
          showNotice({ tone: 'good', text: `${recovered.map((device: HomeDevice) => device.name).join(', ')} is back online.` });
        }
      }
      previousStatesRef.current = nextStates;
      setDevices(nextDevices);
      setStates(nextStates);
      setScenes(Array.isArray(scenePayload?.scenes) ? scenePayload.scenes : []);
      setSelectedDeviceId((current) => current || nextDevices[0]?.id || '');
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Home controls are unavailable.');
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl, showNotice]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 15_000);
    const unsubscribe = subscribeCoreEvents(apiBaseUrl, (event) => {
      if (event.type.startsWith('home.')) void refresh(true);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    };
  }, [refresh]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? devices[0],
    [devices, selectedDeviceId],
  );
  const selectedState = selectedDevice ? states[selectedDevice.id] : undefined;

  useEffect(() => {
    setBrightnessDraft(selectedState?.brightness ?? 50);
    setKelvinDraft(selectedState?.temperature_kelvin ?? 4000);
  }, [selectedDevice?.id, selectedState?.brightness, selectedState?.temperature_kelvin]);

  const controlDevice = async (deviceId: string, payload: Record<string, unknown>) => {
    const response = await coreFetch(`${apiBaseUrl}/api/home/devices/${encodeURIComponent(deviceId)}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    return readJson(response);
  };

  const control = async (payload: Record<string, unknown>) => {
    if (!selectedDevice) return;
    setBusy(true);
    try {
      const result = await controlDevice(selectedDevice.id, payload);
      if (result?.state) setStates((current) => ({ ...current, [selectedDevice.id]: result.state }));
      else await refresh(true);
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Home control failed.');
    } finally {
      setBusy(false);
    }
  };

  const controlAll = async (state: 'on' | 'off') => {
    const reachableDevices = devices.filter((device) => states[device.id]?.connection !== 'offline');
    if (!reachableDevices.length) return;
    setBusy(true);
    try {
      await Promise.all(reachableDevices.map((device) => controlDevice(device.id, { state })));
      await refresh(true);
      showNotice({ tone: 'good', text: `All reachable lights turned ${state}.` });
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Home control failed.');
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };

  const activateScene = async (sceneId: string) => {
    setBusy(true);
    try {
      await coreFetch(`${apiBaseUrl}/api/home/scenes/${encodeURIComponent(sceneId)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: false }),
      }).then(readJson);
      await refresh(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Scene activation failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveScene = async () => {
    const name = sceneName.trim();
    if (!name) return;
    const actions = devices.flatMap((device) => {
      const currentState = states[device.id];
      if (!currentState?.online) return [];
      const action: Record<string, unknown> = {
        device: device.id,
        state: currentState.state === false ? 'off' : 'on',
      };
      if (currentState.state !== false) {
        if (currentState.brightness != null) action.brightness = currentState.brightness;
        if (currentState.temperature_kelvin != null) action.temperature_kelvin = currentState.temperature_kelvin;
        else if (currentState.rgb) action.rgb = currentState.rgb;
      }
      return [action];
    });
    if (!actions.length) return;
    setBusy(true);
    try {
      await coreFetch(`${apiBaseUrl}/api/home/scenes/${encodeURIComponent(sceneIdFromName(name))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, aliases: [], actions }),
      }).then(readJson);
      setSceneName('');
      await refresh(true);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Scene save failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteScene = async (sceneId: string) => {
    setBusy(true);
    try {
      await coreFetch(`${apiBaseUrl}/api/home/scenes/${encodeURIComponent(sceneId)}`, { method: 'DELETE' }).then(readJson);
      await refresh(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Scene delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const swatches = [
    { label: 'Rose', color: '#f43f5e', rgb: [255, 45, 90] },
    { label: 'Amber', color: '#f59e0b', rgb: [255, 150, 20] },
    { label: 'Mint', color: '#22c55e', rgb: [35, 255, 145] },
    { label: 'Sky', color: '#38bdf8', rgb: [30, 175, 255] },
    { label: 'Violet', color: '#a855f7', rgb: [155, 50, 255] },
    { label: 'Pink', color: '#ec4899', rgb: [255, 45, 175] },
  ];

  const kelvinPresets = [
    { label: 'Warm', value: 2700 },
    { label: 'Neutral', value: 4000 },
    { label: 'Focus', value: 5500 },
  ];

  const selectedConnection = selectedState?.connection ?? (selectedState?.online ? 'online' : 'offline');
  const reachableDeviceCount = devices.filter((device) => states[device.id]?.connection !== 'offline').length;
  const hasOnlineDevice = devices.some((device) => states[device.id]?.online);

  if (compact) {
    const currentScenePage = Math.min(scenePage, Math.max(0, Math.ceil(scenes.length / 2) - 1));
    const adjustmentKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    return <section className="home-quick-controls" aria-label="Home controls">
      <header className="overview-section-heading"><h2>Lights</h2><div>{devices.length > 1 ? <select aria-label="Home light" value={selectedDevice?.id ?? ''} onChange={event => setSelectedDeviceId(event.target.value)}>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select> : null}<button type="button" aria-label="Refresh Home" title="Refresh Home" disabled={busy} onClick={() => void refresh()}><RefreshCcw size={15} /></button></div></header>
      {selectedDevice ? <>
        <div className="home-quick-device"><div><strong>{selectedDevice.name}</strong><p role={error ? 'alert' : 'status'} title={error || notice?.text || selectedDevice.room}>{error ? 'Controls unavailable' : notice?.text || `${selectedDevice.room || 'Home'} · ${selectedConnection}`}</p></div><button type="button" role="switch" aria-label={`Power ${selectedDevice.name}`} aria-checked={Boolean(selectedState?.state)} disabled={!selectedState?.online || busy} onClick={() => void control({ state: selectedState?.state ? 'off' : 'on' })} className="home-power-switch"><span /></button><button type="button" disabled={!reachableDeviceCount || busy} onClick={() => void controlAll('on')}>All on</button><button type="button" disabled={!reachableDeviceCount || busy} onClick={() => void controlAll('off')}>All off</button></div>
        <div className="home-range-grid">
          <label><span>Brightness <b>{brightnessDraft}%</b></span><input aria-label="Brightness" type="range" min="1" max="100" value={brightnessDraft} disabled={!selectedState?.online || busy} onChange={event => setBrightnessDraft(Number(event.target.value))} onPointerUp={() => void control({ state: 'on', brightness: brightnessDraft })} onKeyUp={event => { if (adjustmentKeys.includes(event.key)) void control({ state: 'on', brightness: brightnessDraft }); }} /></label>
          <label><span>White <b>{kelvinDraft} K</b></span><input aria-label="White temperature" type="range" min="2200" max="6500" step="100" value={kelvinDraft} disabled={!selectedState?.online || busy} onChange={event => setKelvinDraft(Number(event.target.value))} onPointerUp={() => void control({ state: 'on', temperature_kelvin: kelvinDraft })} onKeyUp={event => { if (adjustmentKeys.includes(event.key)) void control({ state: 'on', temperature_kelvin: kelvinDraft }); }} /></label>
        </div>
        <div className="home-white-presets">{kelvinPresets.map(preset => <button key={preset.value} type="button" aria-pressed={kelvinDraft === preset.value} disabled={!selectedState?.online || busy} onClick={() => { setKelvinDraft(preset.value); void control({ state: 'on', temperature_kelvin: preset.value }); }}>{preset.label}</button>)}</div>
        <div className="home-color-presets"><span>Color</span>{swatches.map(swatch => <button key={swatch.label} type="button" title={swatch.label} aria-label={swatch.label} disabled={!selectedState?.online || busy} onClick={() => void control({ state: 'on', rgb: swatch.rgb })} style={{ '--swatch': swatch.color } as CSSProperties}><span /></button>)}</div>
        <div className="home-quick-scenes">
          {editingScene ? <>
            <input aria-label="Scene name" placeholder="Scene name" value={sceneName} onChange={event => setSceneName(event.target.value)} />
            <button type="button" aria-label="Save all current lights" disabled={!sceneName.trim() || busy || !hasOnlineDevice} onClick={() => void saveScene().then(saved => { if (saved) setEditingScene(false); })}><Save size={15} /></button>
            <button type="button" onClick={() => setEditingScene(false)}>Cancel</button>
          </> : <>
            <span>Scenes</span>
            <div>{scenes.slice(currentScenePage * 2, currentScenePage * 2 + 2).map(scene => <div key={scene.id}>
              <button type="button" title={scene.name} disabled={busy} onClick={() => void activateScene(scene.id)}>{scene.name}</button>
              {!scene.read_only ? <button type="button" disabled={busy} aria-label={`Delete ${scene.name}`} onClick={() => void deleteScene(scene.id)}><Trash2 size={13} /></button> : null}
            </div>)}</div>
            {scenes.length > 2 ? <button type="button" aria-label="Next scenes" onClick={() => setScenePage((currentScenePage + 1) % Math.ceil(scenes.length / 2))}>Next</button> : null}
            <button type="button" aria-label="Name current scene" title="Name current scene" onClick={() => setEditingScene(true)}><Save size={15} /></button>
          </>}
        </div>
      </> : <p className="overview-muted">{busy ? 'Checking lights…' : error ? 'Home controls unavailable.' : 'No lights configured.'}</p>}
    </section>;
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Home controls">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-[#8d687b]">Home Operations</p>
          <h3 className="mt-1 text-[21px] font-semibold text-[#38222f]">{view === 'lights' ? (selectedDevice?.name ?? 'Local devices') : 'Computers'}</h3>
        </div>
        <div className="flex gap-1.5">
          {view === 'lights' && onWakePc ? (
            <button type="button" onClick={onWakePc} className="flex h-9 w-9 items-center justify-center rounded-full bg-[#4f2c45] text-white" title="Wake PC">
              <Power className="h-4 w-4" />
            </button>
          ) : null}
          {view === 'lights' ? <button type="button" onClick={() => void refresh()} disabled={busy} className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e5bfd2] bg-white text-[#754b62]" title="Refresh Home">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </button> : null}
        </div>
      </div>

      {!lightsOnly ? <div className="my-2 grid h-8 shrink-0 grid-cols-2 rounded-md border border-[#e7c9d8] bg-white/70 p-0.5" aria-label="Home operations view">
        <button type="button" onClick={() => setView('lights')} className={`flex items-center justify-center gap-1.5 rounded-[5px] text-[10px] font-bold transition ${view === 'lights' ? 'bg-[#4f2c45] text-white' : 'text-[#76596a]'}`}><Lightbulb className="h-3.5 w-3.5" /> Lights</button>
        <button type="button" onClick={() => setView('computers')} className={`flex items-center justify-center gap-1.5 rounded-[5px] text-[10px] font-bold transition ${view === 'computers' ? 'bg-[#4f2c45] text-white' : 'text-[#76596a]'}`}><MonitorCog className="h-3.5 w-3.5" /> Computers</button>
      </div> : null}

      {view === 'computers' && !lightsOnly ? <DevicePowerPanel apiBaseUrl={apiBaseUrl} /> : <>

      {devices.length > 1 ? (
        <select aria-label="Home light" value={selectedDevice?.id ?? ''} onChange={(event) => setSelectedDeviceId(event.target.value)} className="mt-2 w-full rounded-md border border-[#e7c9d8] bg-white px-2 py-1.5 text-xs text-[#604657]">
          {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
        </select>
      ) : null}

      {error ? <p className="mt-2 rounded-md bg-rose-50 px-2.5 py-2 text-[11px] text-rose-700">{error}</p> : null}
      {notice ? (
        <p className={`mt-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] font-semibold ${notice.tone === 'good' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
          {notice.tone === 'good' ? <Wifi className="h-3.5 w-3.5 shrink-0" /> : <WifiOff className="h-3.5 w-3.5 shrink-0" />}
          {notice.text}
        </p>
      ) : null}

      {selectedDevice ? (
        <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-md border border-[#ead0dc] bg-white px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className={`flex min-w-0 items-center gap-1.5 text-xs font-semibold ${selectedConnection === 'online' ? 'text-emerald-700' : selectedConnection === 'reconnecting' ? 'text-amber-700' : 'text-rose-600'}`}>
                <Lightbulb className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {selectedConnection === 'online'
                    ? `${selectedDevice.room || 'Home'} - ${selectedState?.brightness ?? 0}%`
                    : selectedConnection === 'reconnecting' ? 'Reconnecting' : 'Offline'}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(selectedState?.state)}
                disabled={!selectedState?.online || busy}
                onClick={() => void control({ state: selectedState?.state ? 'off' : 'on' })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${selectedState?.state ? 'bg-emerald-500' : 'bg-slate-300'} disabled:opacity-40`}
                title={selectedState?.state ? 'Turn off' : 'Turn on'}
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${selectedState?.state ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            <p className="mt-1 pl-[22px] text-[10px] text-[#76586a]">
              {selectedConnection === 'online' ? 'Connected locally' : formatLastSeen(selectedState?.last_seen)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" disabled={!reachableDeviceCount || busy} onClick={() => void controlAll('on')} className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#4f2c45] px-2 text-[11px] font-semibold text-white disabled:opacity-40">
              <Power className="h-3.5 w-3.5" /> All On
            </button>
            <button type="button" disabled={!reachableDeviceCount || busy} onClick={() => void controlAll('off')} className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#dfbdcf] bg-white px-2 text-[11px] font-semibold text-[#634357] disabled:opacity-40">
              <PowerOff className="h-3.5 w-3.5" /> All Off
            </button>
          </div>

          <label className="block text-[11px] font-semibold text-[#76596a]">
            <span className="flex justify-between"><span>Brightness</span><span>{brightnessDraft}%</span></span>
            <input type="range" min="1" max="100" value={brightnessDraft} disabled={!selectedState?.online || busy} onChange={(event) => setBrightnessDraft(Number(event.target.value))} onPointerUp={() => void control({ state: 'on', brightness: brightnessDraft })} onKeyUp={() => void control({ state: 'on', brightness: brightnessDraft })} className="mt-1 w-full accent-[#d34f91]" />
          </label>

          <div>
            <div className="flex items-center justify-between text-[11px] font-semibold text-[#76596a]"><span>White temperature</span><span>{kelvinDraft}K</span></div>
            <input aria-label="White temperature" type="range" min="2200" max="6500" step="100" value={kelvinDraft} disabled={!selectedState?.online || busy} onChange={(event) => setKelvinDraft(Number(event.target.value))} onPointerUp={() => void control({ state: 'on', temperature_kelvin: kelvinDraft })} onKeyUp={() => void control({ state: 'on', temperature_kelvin: kelvinDraft })} className="mt-1 w-full accent-[#f0a53c]" />
            <div className="mt-1 grid grid-cols-3 gap-1">
              {kelvinPresets.map((preset) => (
                <button key={preset.value} type="button" disabled={!selectedState?.online || busy} onClick={() => { setKelvinDraft(preset.value); void control({ state: 'on', temperature_kelvin: preset.value }); }} className={`h-7 rounded-md border px-1 text-[10px] font-semibold ${kelvinDraft === preset.value ? 'border-[#d45a95] bg-[#fff0f7] text-[#a6336d]' : 'border-[#e7c9d8] bg-white text-[#775568]'} disabled:opacity-40`}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[#76596a]"><Palette className="h-3.5 w-3.5" /> Color</div>
            <div className="grid grid-cols-6 gap-1.5">
              {swatches.map((swatch) => (
                <button key={swatch.label} type="button" title={swatch.label} aria-label={swatch.label} disabled={!selectedState?.online || busy} onClick={() => void control({ state: 'on', rgb: swatch.rgb })} className="aspect-square w-full rounded-full border-2 border-white shadow-sm outline outline-1 outline-[#e7c9d8] disabled:opacity-40" style={{ backgroundColor: swatch.color }} />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[#76596a]">Scenes</span>
              <span className="text-[10px] text-[#76586a]">{scenes.length} saved</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {scenes.map((scene) => (
                <div key={scene.id} className="flex min-w-0 gap-1">
                  <button type="button" disabled={busy} onClick={() => void activateScene(scene.id)} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[#e7c9d8] bg-white px-2 text-left text-[11px] font-semibold text-[#5b3e50] disabled:opacity-50">
                    {sceneIcon(scene.id)}
                    <span className="truncate">{scene.name}</span>
                  </button>
                  {!scene.read_only ? (
                    <button type="button" disabled={busy} onClick={() => void deleteScene(scene.id)} className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md border border-rose-200 bg-white text-rose-600" title={`Delete ${scene.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-1.5 border-t border-[#edd7e1] pt-2">
            <input value={sceneName} onChange={(event) => setSceneName(event.target.value)} placeholder="Save current Home scene" className="h-8 min-w-0 flex-1 rounded-md border border-[#e7c9d8] bg-white px-2 text-[11px] outline-none" />
            <button type="button" disabled={!sceneName.trim() || busy || !hasOnlineDevice} onClick={() => void saveScene()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#4f2c45] text-white disabled:opacity-40" title="Save all current lights"><Save className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-1 items-center justify-center text-center text-xs text-[#806477]">No Home devices available.</div>
      )}
      </>}
    </section>
  );
}
