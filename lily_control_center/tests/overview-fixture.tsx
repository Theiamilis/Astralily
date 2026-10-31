import { createRoot } from 'react-dom/client';
import App from '../src/app/App';
import '../src/styles/index.css';

const fixtureUrl = new URL(window.location.href);
const familyUnavailable = fixtureUrl.searchParams.get('scenario') === 'family-unavailable';
fixtureUrl.searchParams.set('variant', 'overview');
window.history.replaceState({}, '', fixtureUrl);
window.localStorage.setItem('lily_overview_live2d', 'false');
const stamp = Date.now() / 1000;
let sseOpened = 0;
let sseActive = 0;
let mutations = 0;
let deviceReads = 0;
let lightOn = true;
let lightBrightness = 65;
let lightTemperature = 4000;
let lightRgb: number[] | undefined;
let fixtureScenes = [{ id: 'work', name: 'Work', action_count: 1, read_only: true }];
const commands: Record<string, object[]> = {};
const audioInstances: HTMLAudioElement[] = [];
const rate = 8000;
const seconds = 60;
const wave = new ArrayBuffer(44 + rate * seconds * 2);
const bytes = new DataView(wave);
const text = (offset: number, value: string) => [...value].forEach((char, i) => bytes.setUint8(offset + i, char.charCodeAt(0)));
text(0, 'RIFF'); bytes.setUint32(4, wave.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, 'data'); bytes.setUint32(40, wave.byteLength - 44, true);
for (let i = 0; i < rate * seconds; i++) bytes.setInt16(44 + i * 2, Math.sin(i / rate * Math.PI * 440) * 900, true);
const tone = URL.createObjectURL(new Blob([wave], { type: 'audio/wav' }));
window.Audio = new Proxy(window.Audio, { construct(target, args) {
  const audio = new target(args[0]?.includes('/qa-tone.wav') ? tone : args[0]);
  if (fixtureUrl.searchParams.get('scenario') === 'audio-blocked') {
    const play = audio.play.bind(audio);
    let first = true;
    audio.play = () => {
      if (first) { first = false; return Promise.reject(new DOMException('Fixture autoplay blocked', 'NotAllowedError')); }
      return play();
    };
  }
  audioInstances.push(audio);
  return audio;
} });
const fixturePhones = [
  { id: 'a'.repeat(32), name: 'Demo Dad', online: true, sharing_enabled: true, location_permission: true, location_mode: 'eco', last_seen_at: stamp },
  { id: 'b'.repeat(32), name: 'Demo Mom', online: false, sharing_enabled: false, location_permission: true, location_mode: 'paused', last_seen_at: stamp - 3600 },
  { id: 'd'.repeat(32), name: 'Demo Phone 3', online: true, sharing_enabled: true, location_permission: true, location_mode: 'eco', last_seen_at: stamp - 120 },
  { id: 'e'.repeat(32), name: 'Demo Phone 4', online: false, sharing_enabled: true, location_permission: true, location_mode: 'eco', last_seen_at: stamp - 2100 },
  { id: 'c'.repeat(32), name: 'Revoked fixture phone', revoked: true },
];
if (fixtureUrl.searchParams.get('scenario') === 'extra-phones') {
  fixturePhones.push({ id: 'f'.repeat(32), name: 'Demo Phone 5', online: true, sharing_enabled: true, location_permission: true, location_mode: 'eco', last_seen_at: stamp });
}
const fixturePoints = {
  a: { latitude: -6.544, longitude: 106.802, label: 'Cilebut Barat, Sukaraja, Bogor', ago: 0 },
  b: { latitude: -6.6, longitude: 106.802, label: 'Bogor, Jawa Barat', ago: 3600 },
  d: { latitude: -6.556, longitude: 106.794, label: 'Cilebut Timur, Sukaraja, Bogor', ago: 120 },
  e: { latitude: -6.591, longitude: 106.81, label: 'Tanah Sareal, Bogor', ago: 2100 },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), window.location.href);
  if (url.port !== '5240') return realFetch(input, init);
  const path = url.pathname.replace(/^\/browser\/(core|wa|model)/, '');
  if ((init.method || 'GET') !== 'GET') mutations++;
  if (path === '/api/browser-session') return response({ csrf: 'fixture-csrf' });
  if (path === '/api/events/stream') {
    sseOpened++; sseActive++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(': fixture heartbeat\n\n'));
      init.signal?.addEventListener('abort', () => { sseActive--; controller.error(new Error('fixture aborted')); }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (path === '/api/history') return response([]);
  if (path === '/health') return response({ status: 'ok', components: { core: { status: 'online' }, brain: { status: 'degraded' }, voice: { status: 'online' } } });
  if (path === '/api/chat') {
    const message = JSON.parse(String(init.body)).message || '';
    const reply = message.toLowerCase().includes('long reply')
      ? 'First page of a long fixture reply. Family locations stay private and separate from this conversation.\n'.repeat(12) + 'リリーはここにいます。\n'.repeat(12) + 'Final page of the fixture reply.'
      : 'Fixture reply. Toggle Live2D while this test audio plays.';
    return response({ text: reply, response: reply, audio: `${window.location.origin}/qa-tone.wav`, expression: 'Blush' });
  }
  if (path === '/api/owner/family/devices') return familyUnavailable ? response({ detail: 'Fixture Family unavailable' }, 503) : response({ devices: fixturePhones });
  if (path.endsWith('/location-mode')) { const id = path.split('/')[5]; commands[id] = [{ id: 'fixture-command', status: 'pending', payload: { mode: JSON.parse(String(init.body)).mode } }]; return response(commands[id][0]); }
  if (path.endsWith('/commands')) return response(commands[path.split('/')[5]] || []);
  if (path.endsWith('/location') || path.endsWith('/place')) {
    const id = path.split('/')[5]?.[0] as keyof typeof fixturePoints;
    const point = fixturePoints[id] || fixturePoints.a;
    if (fixtureUrl.searchParams.get('scenario') === 'missing-location' && id === 'e') return response(path.endsWith('/place') ? { label: null, status: 'no_location', captured_at: null } : { location: null });
    if (path.endsWith('/place')) return response({ label: point.label, status: 'ready', captured_at: stamp - point.ago });
    return response({ location: { latitude: point.latitude, longitude: point.longitude, accuracy_m: 35, captured_at: stamp - point.ago, stale: point.ago > 1200, mode: 'eco' } });
  }
  if (path === '/api/home/devices') return response({ devices: [{ id: 'fixture-light', name: 'Desk lamp', room: 'Bedroom', kind: 'light', provider: 'wiz', aliases: [] }] });
  if (path === '/api/home/scenes') return response({ scenes: fixtureScenes });
  if (path.startsWith('/api/home/scenes/')) {
    const id = path.split('/')[4];
    if (init.method === 'PUT') fixtureScenes = [...fixtureScenes.filter(scene => scene.id !== id), { id, name: JSON.parse(String(init.body)).name, action_count: 1, read_only: false }];
    if (init.method === 'DELETE') fixtureScenes = fixtureScenes.filter(scene => scene.id !== id);
    return response({ ok: true });
  }
  if (path.endsWith('/state')) {
    if (init.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      if (payload.state) lightOn = payload.state !== 'off';
      lightBrightness = payload.brightness ?? lightBrightness;
      lightTemperature = payload.temperature_kelvin ?? lightTemperature;
      lightRgb = payload.rgb ?? lightRgb;
    }
    const state = { device_id: 'fixture-light', online: true, connection: 'online', state: lightOn, brightness: lightBrightness, temperature_kelvin: lightTemperature, rgb: lightRgb };
    return response(init.method === 'POST' ? { state } : state);
  }
  if (path === '/api/owner/network/devices') {
    deviceReads++;
    const scenario = fixtureUrl.searchParams.get('scenario');
    if (scenario === 'devices-unavailable' || scenario === 'devices-refresh-fails' && deviceReads > 1) return response({ detail: 'Fixture Tailscale outage' }, 503);
    const devices = [
      { id: 'core', name: 'Demo lily-core-host', os: 'linux', address: '198.51.100.2', online: true, is_core_host: true },
      { id: 'pc', name: 'Demo Lily-Storage-Host', os: 'windows', address: '198.51.100.3', online: false, is_core_host: false },
      { id: 'laptop', name: 'Demo Lily-User-Laptop', os: 'windows', address: '198.51.100.4', online: false, is_core_host: false },
      { id: 'phone', name: 'Demo owner mobile 5G', os: 'android', address: '198.51.100.5', online: false, is_core_host: false },
      { id: 'desktop', name: 'Demo Lily-Voice-Host', os: 'windows', address: '198.51.100.6', online: true, is_core_host: false },
    ];
    if (scenario === 'extra-devices') devices.push(
      { id: 'six', name: 'Demo device 6', os: 'linux', address: '198.51.100.7', online: true, is_core_host: false },
      { id: 'seven', name: 'Demo device 7 with a long name', os: 'linux', address: '198.51.100.8', online: false, is_core_host: false },
    );
    return response({ devices: scenario === 'devices-empty' ? [] : devices, source: 'tailscale', checked_at: new Date().toISOString() });
  }
  if (path === '/api/power/wake') { if (JSON.parse(String(init.body)).target !== 'iris_forest') throw new Error('Wrong wake target.'); return response({ ok: true }); }
  if (path === '/api/settings') return response({ providers: [], speech: [], modules: [], security: { secrets_returned: false } });
  if (path.includes('/pairing/requests')) return response({ requests: [] });
  if (path.includes('/sms')) throw new Error('Overview must not fetch SMS automatically.');
  if (init.method && init.method !== 'GET') return response({ detail: 'Unknown fixture mutation' }, 400);
  return response({ items: [], notices: [], models: [], assignments: {} });
};
createRoot(document.getElementById('root')!).render(<App />);
setInterval(() => {
  const active = audioInstances.filter((audio) => !audio.paused);
  document.getElementById('fixture-diagnostics')!.textContent = ` · SSE opened ${sseOpened}, active ${sseActive} · mutations ${mutations} · audio created ${audioInstances.length}, playing ${active.length}, time ${(active[0]?.currentTime || 0).toFixed(1)}s · iframes ${document.querySelectorAll('iframe').length} · overflow ${document.documentElement.scrollWidth > window.innerWidth}`;
}, 250);
