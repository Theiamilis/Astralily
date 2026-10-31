import { useState } from 'react';
import { Monitor, Power, Server, Smartphone } from 'lucide-react';
import { coreFetch } from '../coreApi';
import { useVisiblePoll } from '../useVisiblePoll';

type NetworkDevice = { id: string; name: string; os: string; address: string | null; online: boolean; is_core_host: boolean };
const pageSize = 6;

export function OverviewComputers({ apiBaseUrl, coreReachable }: { apiBaseUrl: string; coreReachable: boolean }) {
  const [devices, setDevices] = useState<NetworkDevice[] | null>(null);
  const [checkedAt, setCheckedAt] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useVisiblePoll(async (signal) => {
    try {
      const response = await coreFetch(`${apiBaseUrl}/api/owner/network/devices`, { signal });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (signal.aborted) return;
      if (!Array.isArray(payload.devices)) throw new Error();
      setDevices(payload.devices);
      setCheckedAt(payload.checked_at || '');
      setPage(current => Math.min(current, Math.max(0, Math.ceil(payload.devices.length / pageSize) - 1)));
      setError('');
    } catch { if (!signal.aborted) setError('Tailscale device list unavailable.'); }
  });
  const wake = async () => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const response = await coreFetch(`${apiBaseUrl}/api/power/wake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'iris_forest', source: 'dashboard_control_center', reason: 'Lily-Storage-Host wake from Overview' }),
      });
      if (!response.ok) throw new Error(`Wake request failed (${response.status}).`);
      setNotice('Wake sent. Awaiting reachability.');
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Wake delivery is uncertain. Check PC status before retrying.'); }
    finally { setBusy(false); }
  };
  const pages = Math.max(1, Math.ceil((devices?.length || 0) / pageSize));
  return <section className="overview-panel overview-computer-panel" aria-labelledby="overview-computers-heading">
    <header className="overview-section-heading"><h2 id="overview-computers-heading">Devices</h2><span title={checkedAt ? `Checked ${new Date(checkedAt).toLocaleTimeString()}` : undefined}>{devices ? `${devices.length} · ` : ''}Tailscale</span></header>
    {error ? <p className="overview-warning" role="alert">{error}{devices?.length ? ' Showing the last check.' : ''}</p> : null}
    {devices === null && !error ? <p className="overview-muted" role="status">Checking Tailscale devices…</p> : null}
    {devices?.length === 0 && !error ? <p className="overview-muted">No Tailscale devices found.</p> : null}
    <ul className="overview-computers" aria-label="Tailscale devices">
      {devices?.slice(page * pageSize, (page + 1) * pageSize).map(device => {
        const Icon = device.is_core_host ? Server : device.os === 'android' || device.os === 'iOS' ? Smartphone : Monitor;
        return <li key={device.id}>
          <Icon size={18} aria-hidden="true" />
          <div className="overview-device-copy"><div><strong title={device.name}>{device.name}</strong><span className={!error && device.online ? 'device-online' : ''}>{error ? 'Unknown' : device.online ? 'Online' : 'Offline'}</span></div><small>{device.os} · {device.address || 'No IPv4 address'}</small></div>
        </li>;
      })}
    </ul>
    <footer className="overview-device-actions">
      {pages > 1 ? <nav aria-label="Device pages"><button type="button" aria-label="Previous devices" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button><span>{page + 1}/{pages}</span><button type="button" aria-label="Next devices" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>›</button></nav> : null}
      <button type="button" onClick={() => void wake()} disabled={busy || !coreReachable}><Power size={16} />{busy ? 'Sending…' : 'Wake Lily-Storage-Host'}</button>
    </footer>
    {notice ? <p className="overview-muted" role="status">{notice}</p> : null}
  </section>;
}
