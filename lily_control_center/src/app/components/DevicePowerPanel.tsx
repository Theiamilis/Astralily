import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleStop,
  Cpu,
  History,
  LoaderCircle,
  MemoryStick,
  MoonStar,
  PowerOff,
  RefreshCcw,
  RotateCw,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { coreFetch, subscribeCoreEvents } from '../coreApi';

type DeviceStatus = {
  target_id: string;
  target_label: string;
  online: boolean;
  logged_in_user?: string;
  uptime_seconds?: number | null;
  cpu_percent?: number | null;
  memory_used_bytes?: number | null;
  memory_total_bytes?: number | null;
  checked_at: string;
  latency_ms?: number;
  detail?: string;
};

type PowerHistoryItem = {
  timestamp?: string;
  target?: string;
  target_label?: string;
  action?: string;
  state?: string;
  event?: string;
  ok?: boolean;
};

type PendingConfirmation = {
  target: string;
  action: string;
  code: string;
  message: string;
};

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.detail || `Power request failed: ${response.status}`));
  return payload;
}

function formatUptime(value?: number | null) {
  if (!value) return 'just started';
  const hours = Math.floor(value / 3600);
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d ${hours % 24}h` : `${hours}h ${Math.floor((value % 3600) / 60)}m`;
}

function formatMemory(used?: number | null, total?: number | null) {
  if (!used || !total) return 'RAM unavailable';
  return `${(used / 1024 ** 3).toFixed(1)} / ${(total / 1024 ** 3).toFixed(1)} GB`;
}

function formatHistoryTime(value?: string) {
  if (!value) return 'recently';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DevicePowerPanel({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [history, setHistory] = useState<PowerHistoryItem[]>([]);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [statusPayload, historyPayload] = await Promise.all([
        coreFetch(`${apiBaseUrl}/api/power/status`).then(readJson),
        coreFetch(`${apiBaseUrl}/api/power/history?limit=12`).then(readJson),
      ]);
      const nextDevices = Array.isArray(statusPayload?.devices) ? statusPayload.devices : [];
      setDevices(nextDevices);
      setSelectedTarget((current) => current || nextDevices[0]?.target_id || '');
      setHistory(Array.isArray(historyPayload?.items) ? historyPayload.items : []);
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Computer status is unavailable.');
    } finally {
      setRefreshing(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 20_000);
    const unsubscribe = subscribeCoreEvents(apiBaseUrl, (event) => {
      if (event.type.startsWith('device_power.')) void refresh(true);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [apiBaseUrl, refresh]);

  const selected = useMemo(
    () => devices.find((device) => device.target_id === selectedTarget) ?? devices[0],
    [devices, selectedTarget],
  );

  const sendPowerCommand = async (message: string) => {
    const response = await coreFetch(`${apiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        user_id: 'control_center_power',
        want_voice: false,
        context: { interface: 'lily_control_center', access_scope: 'owner', is_owner: true },
      }),
    });
    return readJson(response);
  };

  const requestAction = async (action: string) => {
    if (!selected || busyAction) return;
    setBusyAction(action);
    setError('');
    setNotice('');
    try {
      const payload = await sendPowerCommand(`/power ${action} ${selected.target_id}`);
      const message = String(payload?.text || 'Lily created a power request.');
      const code = message.match(/\/power confirm (\d{4})/i)?.[1] || '';
      if (!code) throw new Error(message);
      setPending({ target: selected.target_id, action, code, message });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Power request failed.');
    } finally {
      setBusyAction('');
    }
  };

  const confirmAction = async () => {
    if (!pending || busyAction) return;
    setBusyAction('confirm');
    try {
      const payload = await sendPowerCommand(`/power confirm ${pending.code}`);
      setNotice(String(payload?.text || 'Power action accepted.'));
      setPending(null);
      window.setTimeout(() => void refresh(true), 1_500);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Confirmation failed.');
    } finally {
      setBusyAction('');
    }
  };

  const cancelPending = async () => {
    if (!pending || busyAction) return;
    setBusyAction('cancel-pending');
    try {
      await sendPowerCommand('/power cancel');
      setPending(null);
      setNotice('Pending request cancelled.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Cancellation failed.');
    } finally {
      setBusyAction('');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[#5b3e50]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${selected?.online ? 'bg-emerald-500' : 'bg-rose-400'}`} />
          <select
            value={selected?.target_id ?? ''}
            onChange={(event) => setSelectedTarget(event.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-xs font-bold outline-none"
            aria-label="Computer target"
          >
            {devices.map((device) => <option key={device.target_id} value={device.target_id}>{device.target_label}</option>)}
          </select>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={refreshing} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e5bfd2] bg-white text-[#754b62]" title="Refresh computer status">
          {refreshing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {error ? <p className="mt-2 rounded-md bg-rose-50 px-2.5 py-2 text-[11px] text-rose-700">{error}</p> : null}
      {notice ? <p className="mt-2 rounded-md bg-emerald-50 px-2.5 py-2 text-[11px] font-semibold text-emerald-800">{notice}</p> : null}

      {selected ? (
        <>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <div className="rounded-md border border-[#ead0dc] bg-white px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[#9a7187]">{selected.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />} Network</span>
              <strong className={`mt-1 block text-xs ${selected.online ? 'text-emerald-700' : 'text-rose-600'}`}>{selected.online ? `Online - ${selected.latency_ms ?? 0} ms` : 'Offline'}</strong>
            </div>
            <div className="rounded-md border border-[#ead0dc] bg-white px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[#9a7187]"><Cpu className="h-3 w-3" /> Uptime</span>
              <strong className="mt-1 block text-xs">{selected.online ? formatUptime(selected.uptime_seconds) : '-'}</strong>
            </div>
            <div className="rounded-md border border-[#ead0dc] bg-white px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[#9a7187]"><MemoryStick className="h-3 w-3" /> Load</span>
              <strong className="mt-1 block truncate text-xs">{selected.online ? `${Math.round(selected.cpu_percent ?? 0)}% - ${formatMemory(selected.memory_used_bytes, selected.memory_total_bytes)}` : '-'}</strong>
            </div>
            <div className="rounded-md border border-[#ead0dc] bg-white px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[#9a7187]"><UserRound className="h-3 w-3" /> Session</span>
              <strong className="mt-1 block truncate text-xs">{selected.online ? (selected.logged_in_user || 'No user') : '-'}</strong>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-1.5">
            <button type="button" disabled={!selected.online || Boolean(busyAction)} onClick={() => void requestAction('restart')} className="flex h-8 items-center justify-center gap-1 rounded-md border border-[#dfbdcf] bg-white px-1 text-[10px] font-bold disabled:opacity-40" title="Restart"><RotateCw className="h-3.5 w-3.5" /> Restart</button>
            <button type="button" disabled={!selected.online || Boolean(busyAction)} onClick={() => void requestAction('hibernate')} className="flex h-8 items-center justify-center gap-1 rounded-md border border-[#dfbdcf] bg-white px-1 text-[10px] font-bold disabled:opacity-40" title="Hibernate"><MoonStar className="h-3.5 w-3.5" /> Sleep</button>
            <button type="button" disabled={!selected.online || Boolean(busyAction)} onClick={() => void requestAction('abort')} className="flex h-8 items-center justify-center gap-1 rounded-md border border-[#dfbdcf] bg-white px-1 text-[10px] font-bold disabled:opacity-40" title="Abort scheduled shutdown"><CircleStop className="h-3.5 w-3.5" /> Abort</button>
            <button type="button" disabled={!selected.online || Boolean(busyAction)} onClick={() => void requestAction('shutdown')} className="flex h-8 items-center justify-center gap-1 rounded-md bg-rose-600 px-1 text-[10px] font-bold text-white disabled:opacity-40" title="Shut down"><PowerOff className="h-3.5 w-3.5" /> Off</button>
          </div>

          {pending ? (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase text-amber-800">Confirm {pending.action}</p><p className="text-xs font-black tracking-[0.2em] text-amber-950">{pending.code}</p></div>
              <button type="button" onClick={() => void confirmAction()} disabled={Boolean(busyAction)} className="h-7 rounded-md bg-amber-700 px-2.5 text-[10px] font-bold text-white">Confirm</button>
              <button type="button" onClick={() => void cancelPending()} disabled={Boolean(busyAction)} className="flex h-7 w-7 items-center justify-center rounded-md border border-amber-300 bg-white text-amber-800" title="Cancel request"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : null}

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-[#edd7e1] pt-2">
            <div className="mb-1.5 flex items-center justify-between"><span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[#8e687d]"><History className="h-3 w-3" /> Power history</span><span className="text-[9px] text-[#a48496]">UTC audit</span></div>
            <div className="space-y-1">
              {history.slice(0, 4).map((item, index) => (
                <div key={`${item.timestamp}-${index}`} className="flex items-center justify-between gap-2 rounded-md bg-white/75 px-2 py-1.5 text-[10px]">
                  <span className="min-w-0 truncate"><strong>{item.target_label || item.target}</strong> - {item.state || item.action || item.event}</span>
                  <span className="shrink-0 text-[#9a7b8e]">{formatHistoryTime(item.timestamp)}</span>
                </div>
              ))}
              {!history.length ? <p className="py-3 text-center text-[11px] text-[#8e7182]">No power actions recorded yet.</p> : null}
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-center text-xs text-[#806477]">No computer targets are registered.</div>
      )}
    </div>
  );
}
