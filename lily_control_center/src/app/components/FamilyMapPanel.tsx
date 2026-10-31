import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ChevronLeft, ChevronRight, LocateFixed, Plus, X } from 'lucide-react';
import { coreFetch } from '../coreApi';
import { useVisiblePoll } from '../useVisiblePoll';
import type { OverviewTheme } from '../overviewTheme';

type Point = { latitude: number; longitude: number; accuracy_m: number; captured_at: number; stale: boolean; mode: string };
type Device = { id: string; name: string; revoked?: boolean; online: boolean; sharing_enabled: boolean; location_permission: boolean; location_mode: string; last_seen_at?: number };
type Command = { id: string; status: string; payload?: { mode?: string }; error?: string };
type Place = { label: string | null; status: string; captured_at: number | null };
type Phone = Device & { point: Point | null; commands: Command[]; place: Place | null; locationError: boolean; commandsError: boolean };

function age(stamp?: number) {
  if (!stamp) return 'Not synced';
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - stamp) / 60));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Family request failed (${response.status}).`);
  return response.json();
}

function PhoneCard({ phone, unavailable, busy, notice, onMode, theme }: {
  phone: Phone; unavailable: boolean; busy: boolean; notice?: string; onMode: (mode: 'live' | 'eco') => void; theme: OverviewTheme;
}) {
  const node = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const centered = useRef('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState(false);
  const paused = !phone.sharing_enabled || !phone.location_permission;
  const stale = unavailable || paused || Boolean(phone.point?.stale) || Boolean(phone.point && Date.now() / 1000 - phone.point.captured_at > 1200);
  const label = phone.locationError ? 'Location unavailable' : phone.place?.label || (phone.point ? 'Area name unavailable' : 'No location yet');
  const command = phone.commands[0];
  const commandText = notice || (phone.commandsError ? 'Command status unavailable' : command ? `${command.payload?.mode || 'Location'}: ${command.status === 'pending' ? 'waiting for phone' : command.status}` : phone.location_mode === 'live' ? 'Live sharing' : paused ? 'Sharing paused' : 'Eco sharing');

  useEffect(() => {
    if (!node.current) return;
    const map = L.map(node.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: false }).setView([-2, 118], 4);
    L.tileLayer(import.meta.env.VITE_FAMILY_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    layers.current = L.layerGroup().addTo(map);
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(node.current);
    return () => { observer.disconnect(); map.remove(); mapRef.current = null; layers.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = layers.current;
    if (!map || !group) return;
    group.clearLayers();
    if (!phone.point) return;
    const point = phone.point;
    const position: L.LatLngTuple = [point.latitude, point.longitude];
    const color = getComputedStyle(node.current!).getPropertyValue(stale ? '--overview-muted' : '--overview-accent').trim();
    const icon = L.divIcon({
      className: 'phone-location-pin', iconSize: [28, 34], iconAnchor: [14, 34],
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34" aria-hidden="true"><path d="M14 33C11 29 1 20 1 14a13 13 0 0 1 26 0c0 6-10 15-13 19Z" fill="var(--overview-card)" stroke="${color}" stroke-width="2"/><circle cx="14" cy="14" r="4.5" fill="${color}"/></svg>`,
    });
    L.marker(position, { icon, interactive: false, keyboard: false }).addTo(group);
    L.circle(position, { radius: point.accuracy_m, color, weight: 1, fillOpacity: 0.08 }).addTo(group);
    const cell = `${point.latitude},${point.longitude}`;
    if (centered.current !== cell) { map.setView(position, 14); centered.current = cell; }
  }, [phone.point, stale, theme]);

  useEffect(() => {
    if (details) dialogRef.current?.showModal();
  }, [details]);

  const center = () => {
    if (phone.point) mapRef.current?.setView([phone.point.latitude, phone.point.longitude], 14);
  };
  return <article className="family-phone-card" aria-label={`${phone.name} location`}>
    <header><h3 title={phone.name}>{phone.name}</h3><span className={`phone-state ${paused || unavailable ? 'is-muted' : phone.online ? 'is-online' : 'is-delayed'}`}>{unavailable ? 'Unknown' : paused ? 'Paused' : phone.online ? 'Online' : 'Delayed'}</span></header>
    <div className="phone-map-wrap">
      <div ref={node} className="phone-map" aria-label={`${phone.name} map`} />
      <button type="button" className="map-center" aria-label={`Center ${phone.name} map`} disabled={!phone.point} onClick={center}><LocateFixed size={15} /></button>
      {!phone.point ? <p className="phone-map-empty">{phone.locationError ? 'Position unavailable' : 'Waiting for location'}</p> : null}
    </div>
    <div className="phone-location-copy">
      <button type="button" className="phone-area" title={label} onClick={() => setDetails(true)}>{label}</button>
      <p>{phone.point ? <><time dateTime={new Date(phone.point.captured_at * 1000).toISOString()}>{age(phone.point.captured_at)}</time><span>±{Math.round(phone.point.accuracy_m)} m{stale ? ' · old' : ''}</span></> : <span>{phone.locationError ? 'Retrying next check' : paused ? 'Sharing paused' : 'Waiting for phone'}</span>}</p>
    </div>
    <footer><p role="status" title={command?.error || commandText}>{commandText}</p><div><button type="button" disabled={busy || paused} onClick={() => onMode('live')}>Live 15m</button><button type="button" disabled={busy || paused} onClick={() => onMode('eco')}>Eco</button></div></footer>
    {details ? <dialog ref={dialogRef} className="overview-details-dialog" aria-label={`${phone.name} location details`} onCancel={() => setDetails(false)} onClose={() => setDetails(false)}>
      <header><h2>{phone.name}</h2><button type="button" aria-label="Close location details" onClick={() => { dialogRef.current?.close(); setDetails(false); }}><X size={18} /></button></header>
      <h3>{label}</h3><p>{phone.point ? `Captured ${new Date(phone.point.captured_at * 1000).toLocaleString()} · accuracy ±${Math.round(phone.point.accuracy_m)} m${stale ? ' · old position' : ''}` : 'No position is available.'}</p>
      <p>{paused ? 'Sharing is paused or location permission is missing.' : `Last sync ${age(phone.last_seen_at)}.`}</p><p>{commandText}{command?.error ? ` · ${command.error}` : ''}</p>
      <div className="overview-details-actions"><button type="button" disabled={busy || paused} onClick={() => onMode('live')}>Live 15m</button><button type="button" disabled={busy || paused} onClick={() => onMode('eco')}>Eco</button></div>
      {phone.place?.status === 'not_configured' ? <p>Area names need a Geoapify key on Core.</p> : phone.place?.status === 'quota_reached' ? <p>Area-name quota reached. Positions still update.</p> : null}
    </dialog> : null}
  </article>;
}

export function FamilyMapPanel({ apiBaseUrl, onManage, theme }: { apiBaseUrl: string; onManage: () => void; theme: OverviewTheme }) {
  const [mapFiltered, setMapFiltered] = useState(() => {
    try { return window.localStorage.getItem('lily_overview_map_filter') !== 'false'; }
    catch { return true; }
  });
  const [phones, setPhones] = useState<Phone[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(new Set<string>());
  const [notices, setNotices] = useState<Record<string, string>>({});
  const toggleMapFilter = () => {
    const next = !mapFiltered;
    setMapFiltered(next);
    try { window.localStorage.setItem('lily_overview_map_filter', String(next)); }
    catch { /* Keep the current view usable when browser storage is unavailable. */ }
  };
  const placeCache = useRef(new Map<string, { place: Place; checked: number }>());
  useVisiblePoll(async (signal) => {
    try {
      const { devices } = await json<{ devices: Device[] }>(await coreFetch(`${apiBaseUrl}/api/owner/family/devices`, { signal }));
      const active = devices.filter(device => !device.revoked);
      const ids = new Set(active.map(device => device.id));
      for (const id of placeCache.current.keys()) if (!ids.has(id)) placeCache.current.delete(id);
      const rows = await Promise.all(active.map(async (device): Promise<Phone> => {
        const base = `${apiBaseUrl}/api/owner/family/devices/${encodeURIComponent(device.id)}`;
        const results = await Promise.allSettled([
          coreFetch(`${base}/location`, { signal }).then(json<{ location: Point | null }>),
          coreFetch(`${base}/commands`, { signal }).then(json<Command[]>),
        ]);
        const point = results[0].status === 'fulfilled' ? results[0].value.location : null;
        const commands = results[1].status === 'fulfilled' ? results[1].value : [];
        const cached = placeCache.current.get(device.id);
        let place = cached?.place ?? null;
        const ttl = cached?.place.status === 'waiting' ? 10000 : cached?.place.status === 'ready' ? 21600000 : 300000;
        if (point && (!cached || cached.place.captured_at !== point.captured_at || Date.now() - cached.checked > ttl)) {
          try { place = await json<Place>(await coreFetch(`${base}/place`, { signal })); placeCache.current.set(device.id, { place, checked: Date.now() }); }
          catch { place = null; }
        }
        if (!point || place?.captured_at !== point.captured_at) place = null;
        return { ...device, point, commands, place, locationError: results[0].status === 'rejected', commandsError: results[1].status === 'rejected' };
      }));
      if (!signal.aborted) { setPhones(rows); setError(''); }
    } catch { if (!signal.aborted) setError('Family unavailable. Shown positions are from the last successful check.'); }
    finally { if (!signal.aborted) setLoaded(true); }
  });

  const requestMode = async (phone: Phone, mode: 'live' | 'eco') => {
    if (busy.has(phone.id)) return;
    setBusy(current => new Set(current).add(phone.id));
    setNotices(current => ({ ...current, [phone.id]: 'Sending request…' }));
    try {
      const command = await json<Command>(await coreFetch(`${apiBaseUrl}/api/owner/family/devices/${encodeURIComponent(phone.id)}/location-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }));
      setPhones(current => current.map(item => item.id === phone.id ? { ...item, commands: [command, ...item.commands] } : item));
      setNotices(current => ({ ...current, [phone.id]: '' }));
    } catch (reason) { setNotices(current => ({ ...current, [phone.id]: reason instanceof Error ? reason.message : 'Delivery uncertain. Check before retrying.' })); }
    finally { setBusy(current => { const next = new Set(current); next.delete(phone.id); return next; }); }
  };
  const pages = Math.max(1, Math.ceil(phones.length / 4));
  const currentPage = Math.min(page, pages - 1);
  const visible = phones.slice(currentPage * 4, currentPage * 4 + 4);
  return <section className="overview-family" aria-labelledby="overview-family-heading" data-map-filter={mapFiltered ? 'on' : 'off'}>
    <header className="overview-section-heading"><div><h2 id="overview-family-heading">Family</h2><span>{error ? 'Status unavailable' : loaded ? `${phones.length} phones` : 'Checking phones…'}</span></div><div>
      <button type="button" className="overview-map-filter" aria-pressed={mapFiltered} onClick={toggleMapFilter}>Map filter: {mapFiltered ? 'on' : 'off'}</button>
      {pages > 1 ? <><button type="button" aria-label="Previous phones" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span>{currentPage + 1}/{pages}</span><button type="button" aria-label="Next phones" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></> : null}
      <button type="button" onClick={onManage}>Manage phones</button></div></header>
    {error ? <p role="alert" className="overview-inline-warning">{error}</p> : null}
    <div className="overview-phone-grid">
      {visible.map(phone => <PhoneCard key={phone.id} phone={phone} unavailable={Boolean(error)} busy={busy.has(phone.id)} notice={notices[phone.id]} onMode={mode => void requestMode(phone, mode)} theme={theme} />)}
      {Array.from({ length: 4 - visible.length }, (_, index) => <div key={`empty-${index}`} className="family-phone-card phone-slot"><Plus size={20} /><strong>{!loaded ? 'Checking phone slots' : error ? 'Phone list unavailable' : 'No phone paired'}</strong><button type="button" onClick={onManage}>{error ? 'Manage phones' : 'Add phone'}</button></div>)}
    </div>
    <p className="overview-map-credit"><span dangerouslySetInnerHTML={{ __html: import.meta.env.VITE_FAMILY_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }} /> · <a href="https://leafletjs.com/" target="_blank" rel="noreferrer">Leaflet</a> · <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> · Latest positions only</p>
  </section>;
}
