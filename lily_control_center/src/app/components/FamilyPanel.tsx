import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, Copy, MapPin, MessageSquareText, RefreshCw, ShieldCheck, UsersRound, X } from 'lucide-react';
import { coreFetch } from '../coreApi';

type FamilyDevice = {
  id: string;
  name: string;
  platform?: string;
  created_at?: number;
  last_seen_at?: number;
  last_location_at?: number | null;
  location_accuracy_m?: number | null;
  online?: boolean;
  sharing_enabled?: boolean;
  sms_permission?: boolean;
  location_permission?: boolean;
  location_mode?: string;
  revoked?: boolean;
};

type PairingRequest = {
  id: string;
  name: string;
  platform?: string;
  status: string;
  created_at?: number;
  expires_at?: number;
};

type FamilySms = { id: number; sender: string; body: string; received_at: number; sim_slot?: number | null };
type FamilyLocation = {
  latitude: number; longitude: number; accuracy_m: number; captured_at: number; stale: boolean; mode: string;
};
type FamilyCommand = { id: string; type: string; payload: { mode?: string }; status: string; error?: string; updated_at?: number };

type FamilyPanelProps = { apiBaseUrl: string; onClose: () => void };

function dateTime(value?: number | null) {
  return value ? new Date(value * 1000).toLocaleString() : 'Not reported';
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { detail?: string };
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body as T;
}

export function FamilyPanel({ apiBaseUrl, onClose }: FamilyPanelProps) {
  const [devices, setDevices] = useState<FamilyDevice[]>([]);
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [smsDevice, setSmsDevice] = useState<string>('');
  const [smsItems, setSmsItems] = useState<FamilySms[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<Record<string, FamilyLocation | null>>({});
  const [commands, setCommands] = useState<Record<string, FamilyCommand[]>>({});
  const [invitation, setInvitation] = useState<{ token: string; expires_at: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    try {
      const base = apiBaseUrl.replace(/\/+$/, '');
      const [deviceResponse, requestResponse] = await Promise.all([
        coreFetch(`${base}/api/owner/family/devices`),
        coreFetch(`${base}/api/owner/family/pairing/requests`)
      ]);
      const [deviceData, requestData] = await Promise.all([
        readJson<{ devices: FamilyDevice[] }>(deviceResponse),
        readJson<{ requests: PairingRequest[] }>(requestResponse)
      ]);
      setDevices(deviceData.devices);
      setRequests(requestData.requests.filter((item) => item.status === 'pending'));
      const currentCommands = await Promise.all(deviceData.devices.map(async (device) => {
        try {
          const response = await coreFetch(`${base}/api/owner/family/devices/${device.id}/commands`);
          const items = await readJson<FamilyCommand[]>(response);
          return [device.id, items] as const;
        } catch {
          return [device.id, []] as const;
        }
      }));
      setCommands(Object.fromEntries(currentCommands));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Family data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    window.addEventListener('keydown', trapFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('keydown', trapFocus); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [load]);

  const run = async (key: string, operation: () => Promise<void>) => {
    setBusy(key); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Family action failed.'); }
    finally { setBusy(''); }
  };

  const createInvitation = () => run('invite', async () => {
    const result = await readJson<{ invitation_token: string; expires_at: number }>(await coreFetch(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/invitations`, { method: 'POST' }
    ));
    setInvitation({ token: result.invitation_token, expires_at: result.expires_at });
    setNotice('Invitation created. Share it with the phone owner; it expires in 10 minutes.');
  });

  const decide = (id: string, approve: boolean) => run(`pair:${id}`, async () => {
    await readJson(await coreFetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/pairing/requests/${id}/${approve ? 'approve' : 'deny'}`, {
      method: 'POST'
    }));
    setNotice(approve ? 'Phone paired.' : 'Pairing request declined.');
    await load();
  });

  const revoke = (device: FamilyDevice) => run(`revoke:${device.id}`, async () => {
    await readJson(await coreFetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/devices/${device.id}`, { method: 'DELETE' }));
    setNotice(`${device.name} access revoked.`);
    if (smsDevice === device.id) { setSmsDevice(''); setSmsItems([]); }
    await load();
  });

  const loadSms = (device: FamilyDevice) => run(`sms:${device.id}`, async () => {
    const result = await readJson<{ items: FamilySms[] }>(await coreFetch(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/devices/${device.id}/sms?limit=50`
    ));
    setSmsDevice(device.id); setSmsItems(result.items);
  });

  const loadLocation = (device: FamilyDevice) => run(`location:${device.id}`, async () => {
    const result = await readJson<{ location: FamilyLocation | null }>(await coreFetch(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/devices/${device.id}/location`
    ));
    setSelectedLocation((current) => ({ ...current, [device.id]: result.location }));
    const commandResponse = await coreFetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/devices/${device.id}/commands`);
    const commandData = await readJson<FamilyCommand[]>(commandResponse);
    setCommands((current) => ({ ...current, [device.id]: commandData }));
  });

  const setLocationMode = (device: FamilyDevice, mode: 'live' | 'eco') => run(`mode:${device.id}`, async () => {
    const result = await readJson<FamilyCommand>(await coreFetch(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/owner/family/devices/${device.id}/location-mode`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }
    ));
    setCommands((current) => ({ ...current, [device.id]: [result, ...(current[device.id] ?? [])] }));
    setNotice(`Location mode request is ${result.status}. The phone must confirm before it takes effect.`);
    window.setTimeout(() => void loadLocation(device), 1200);
  });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#201320]/55 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="family-title" className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/80 bg-[#fbf8fa] shadow-[0_30px_100px_rgba(35,14,31,0.35)]">
        <header className="flex items-center justify-between border-b border-[#eadde6] px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#4f2c45] text-white"><UsersRound className="h-5 w-5" /></span>
            <div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#946c86]">Owner-only panel</p><h2 id="family-title" className="text-2xl font-semibold text-[#392130]">Family devices</h2></div>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-full text-[#79566d] hover:bg-[#f1e8ee]" aria-label="Close family panel"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-[#e9dbe5] bg-white p-4">
            <div className="max-w-2xl"><p className="font-semibold text-[#392130]">Pair a family phone</p><p className="mt-1 text-sm leading-6 text-[#76586a]">Create a one-use invitation. The phone requests pairing and waits here for your approval.</p>
              {invitation ? <div className="mt-3 rounded-xl bg-[#f7edf3] p-3"><p className="break-all font-mono text-sm text-[#4f2c45]">{invitation.token}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-[#8f6e80]">Expires {dateTime(invitation.expires_at)}</p><button type="button" onClick={() => void navigator.clipboard.writeText(invitation.token).then(() => setNotice('Invitation copied. Share it only with the intended phone.')).catch(() => setError('Clipboard access is unavailable; copy the invitation text manually.'))} className="flex min-h-9 items-center gap-2 rounded-lg border border-[#e2cdda] bg-white px-3 text-xs font-semibold text-[#6c365a]"><Copy className="h-3.5 w-3.5" />Copy</button></div></div> : null}
            </div>
            <button type="button" disabled={busy === 'invite'} onClick={() => void createInvitation()} className="min-h-11 rounded-xl bg-[#4f2c45] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'invite' ? 'Creating…' : 'Create invitation'}</button>
          </div>
          {error ? <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div> : null}
          {notice ? <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}

          {requests.length ? <section className="mb-5"><h3 className="mb-2 text-lg font-semibold text-[#392130]">Waiting for approval</h3><div className="space-y-2">{requests.map((request) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#eadde6] bg-white p-4"><div><p className="font-semibold text-[#392130]">{request.name}</p><p className="mt-1 text-xs text-[#8f6e80]">{request.platform} · invitation expires {dateTime(request.expires_at)}</p></div><div className="flex gap-2"><button type="button" disabled={busy === `pair:${request.id}`} onClick={() => void decide(request.id, true)} className="flex min-h-10 items-center gap-2 rounded-xl bg-emerald-700 px-3 text-sm font-semibold text-white"><Check className="h-4 w-4" />Approve</button><button type="button" disabled={busy === `pair:${request.id}`} onClick={() => void decide(request.id, false)} className="min-h-10 rounded-xl border border-[#e6d8e2] px-3 text-sm text-[#6c4d62]">Decline</button></div></div>)}</div></section> : null}

          <div className="mb-3 flex items-center justify-between"><h3 className="text-lg font-semibold text-[#392130]">Paired phones</h3><button type="button" onClick={() => void load()} className="flex min-h-10 items-center gap-2 rounded-xl border border-[#e6d8e2] bg-white px-3 text-sm text-[#6c4d62]"><RefreshCw className="h-4 w-4" />Refresh</button></div>
          {loading ? <p className="rounded-2xl bg-white p-5 text-sm text-[#76586a]">Loading family devices…</p> : devices.length === 0 ? <p className="rounded-2xl border border-dashed border-[#ddcbd7] bg-white/60 p-5 text-sm text-[#76586a]">No paired phones yet.</p> : <div className="space-y-3">{devices.map((device) => {
            if (device.revoked) return <article key={device.id} className="rounded-2xl border border-[#eadde6] bg-white p-4"><h4 className="font-semibold text-[#392130]">{device.name}</h4><p className="mt-1 text-sm text-[#76586a]">Access revoked</p></article>;
            const location = selectedLocation[device.id];
            const latestCommands = commands[device.id] ?? [];
            return <article key={device.id} className="rounded-2xl border border-[#eadde6] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h4 className="text-base font-semibold text-[#392130]">{device.name}</h4><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${device.online ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{device.online ? 'Online' : 'Offline / stale'}</span></div><p className="mt-1 text-xs text-[#8f6e80]">{device.platform || 'Android'} · last sync {dateTime(device.last_seen_at)}</p><div className="mt-2 flex flex-wrap gap-2 text-xs text-[#76586a]"><span className="rounded-full bg-[#f5eef3] px-2.5 py-1">SMS {device.sms_permission ? 'sharing' : 'off'}</span><span className="rounded-full bg-[#f5eef3] px-2.5 py-1">Location {device.location_permission ? device.location_mode || 'ready' : 'off'}</span></div></div><button type="button" disabled={busy === `revoke:${device.id}`} onClick={() => void revoke(device)} className="min-h-10 rounded-xl border border-rose-200 px-3 text-sm text-rose-700">Revoke access</button></div>
              <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy === `sms:${device.id}`} onClick={() => void loadSms(device)} className="flex min-h-10 items-center gap-2 rounded-xl bg-[#4f2c45] px-3 text-sm font-semibold text-white"><MessageSquareText className="h-4 w-4" />Open private SMS</button><button type="button" disabled={busy === `location:${device.id}`} onClick={() => void loadLocation(device)} className="flex min-h-10 items-center gap-2 rounded-xl border border-[#e6d8e2] px-3 text-sm text-[#6c4d62]"><MapPin className="h-4 w-4" />Check location</button><button type="button" disabled={busy === `mode:${device.id}` || !device.location_permission} onClick={() => void setLocationMode(device, 'live')} className="min-h-10 rounded-xl border border-[#d7b3cb] px-3 text-sm text-[#6c365a] disabled:opacity-40">Request live · 15 min</button><button type="button" disabled={busy === `mode:${device.id}`} onClick={() => void setLocationMode(device, 'eco')} className="min-h-10 rounded-xl border border-[#e6d8e2] px-3 text-sm text-[#6c4d62]">Request eco mode</button></div>
              {location ? <div className="mt-3 rounded-xl bg-[#f7f4f6] p-3 text-sm text-[#4e3a49]"><p className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4" />Latest point · {location.stale ? 'stale' : 'fresh'} · {location.mode}</p><p className="mt-1">{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)} · ±{Math.round(location.accuracy_m)} m</p><p className="mt-1 text-xs text-[#8f6e80]">Captured {dateTime(location.captured_at)}</p></div> : null}
              {latestCommands.length ? <div className="mt-3 rounded-xl border border-[#eee4eb] p-3"><p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[#8f6e80]"><Clock3 className="h-3.5 w-3.5" />Location command</p>{latestCommands.slice(0, 2).map((command) => <p key={command.id} className="text-sm text-[#4e3a49]">{command.payload?.mode || command.type}: <strong>{command.status}</strong>{command.error ? ` · ${command.error}` : ''}</p>)}</div> : null}
            </article>;
          })}</div>}

          {smsDevice ? <section className="mt-5 rounded-2xl border border-[#eadde6] bg-white p-4"><div className="flex items-center justify-between"><h3 className="flex items-center gap-2 text-lg font-semibold text-[#392130]"><ShieldCheck className="h-5 w-5" />Private SMS viewer</h3><button type="button" onClick={() => { setSmsDevice(''); setSmsItems([]); }} className="rounded-lg px-3 py-2 text-sm text-[#6c4d62]">Close</button></div><p className="mt-1 text-xs text-[#8f6e80]">Messages are kept on the server for 24 hours. They are shown only in this owner panel and are not sent to Lily’s chat or WhatsApp.</p>{smsItems.length ? <div className="mt-3 space-y-2">{smsItems.map((item) => <article key={item.id} className="rounded-xl bg-[#f7f4f6] p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8f6e80]"><strong className="text-[#4f2c45]">{item.sender}</strong><span>{dateTime(item.received_at)}{item.sim_slot != null ? ` · SIM ${item.sim_slot + 1}` : ''}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#392130]">{item.body}</p></article>)}</div> : <p className="mt-3 text-sm text-[#76586a]">No recent messages.</p>}</section> : null}
          <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-[#8f6e80]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />SMS text and location are owner-only data. This panel does not expose them to chat, memory, logs, HUD, or Stream Stage.</p>
        </div>
      </section>
    </div>
  );
}
