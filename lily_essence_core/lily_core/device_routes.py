"""Validated Core routing, not remote process control or file migration."""
import hashlib
import json
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from .settings import settings
from .runtime_settings import SETTINGS_LOCK, load_runtime_overrides, update_runtime_settings
from .prompt_store import atomic_write

ROOT = Path(__file__).resolve().parents[2]
router = APIRouter()
ROUTES = {
    'stream_voice_vessel': ('stream_voice_service_url', 'stream_voice_service_health_url'),
    'stt_vessel': ('stt_service_url', None),
    'tool_vessel': ('tool_agent_url', 'tool_agent_health_url'),
    'home_vessel': ('home_vessel_url', None),
    'finance_vessel': ('finance_vessel_url', None),
}


class RouteChange(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=8, max_length=512)


class RoutePlan(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: str = Field(min_length=64, max_length=64)
    changes: list[RouteChange] = Field(min_length=1, max_length=40)
    confirm: bool = False


def checked_url(value: str) -> str:
    try:
        p = urlsplit(value.strip())
        if (p.scheme not in {'http', 'https'} or not p.hostname or p.username or p.password
                or p.query or p.fragment or '\\' in value
                or any(c.isspace() or ord(c) < 32 for c in value)
                or p.hostname in {'0.0.0.0', '::'}):
            raise ValueError()
        port = p.port if p.port is not None else (443 if p.scheme == 'https' else 80)
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise ValueError('Use an HTTP(S) host and valid port, without credentials, query or fragment.') from None
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip('/'), '', ''))


def safe_url(value: str) -> str:
    try:
        return checked_url(value)
    except ValueError:
        return ''


def origin(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, '', '', ''))


def current_routes() -> list[dict]:
    rows = []
    for key, (attribute, health_attribute) in ROUTES.items():
        url = safe_url(getattr(settings, attribute, ''))
        health = safe_url(getattr(settings, health_attribute, '')) if health_attribute else ''
        rows.append({'id': key, 'service_id': key, 'url': url,
                     'health_url': health or (origin(url)+'/health' if url else ''),
                     'profiles': [], 'priority': None})
    for node in settings.voice_nodes:
        rows.append({'id': 'voice:'+node.id, 'service_id': 'voice_vessel', 'url': safe_url(node.url),
                     'health_url': safe_url(node.resolved_health_url()),
                     'profiles': node.profiles, 'priority': node.priority})
    return rows


def snapshot() -> dict:
    with SETTINGS_LOCK:
        topology = json.loads((ROOT/'config/topology.json').read_text(encoding='utf-8'))
        ports = json.loads((ROOT/'config/ports.json').read_text(encoding='utf-8'))
        owners = {s: d['id'] for d in topology['devices'] for s in d['services']}
        data = {
            'devices': [{k: d.get(k, '') for k in ('id','label','host')} for d in topology['devices']],
            'services': [{k: s.get(k) for k in ('id','label','port','health_path')} | {'device': owners.get(s['id'], '')} for s in ports['services']],
            'routes': current_routes(),
        }
        raw = [data, load_runtime_overrides(settings.runtime_settings_path)]
        data['revision'] = hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()
        return data


def collision_host(host: str, device_hosts: dict) -> str:
    host = host.lower().rstrip('.')
    if host in {'localhost', '127.0.0.1', '::1', socket.gethostname().lower()}:
        return 'core-host'
    for key, name in device_hosts.items():
        if host == name.lower().rstrip('.'):
            return key
    return host


def resolved_hosts(hosts: set[str], device_hosts: dict) -> dict[str, set[str]]:
    """Best-effort parallel DNS with a bounded wait; no tokens or HTTP requests."""
    results = {host: {collision_host(host, device_hosts)} for host in hosts}
    result_lock = threading.Lock()
    def lookup(host):
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
            with result_lock:
                results[host].update(addresses)
        except OSError:
            pass
    threads = [threading.Thread(target=lookup, args=(host,), daemon=True) for host in hosts]
    deadline = time.monotonic()+1.0
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(max(0, deadline-time.monotonic()))
    with result_lock:
        return {host: set(keys) for host, keys in results.items()}


def make_plan(request: RoutePlan) -> dict:
    data = snapshot()
    if request.revision != data['revision']:
        raise HTTPException(409, 'Routing changed elsewhere. Reload before saving.')
    rows = {r['id']: dict(r) for r in data['routes']}
    changes, seen = [], set()
    for change in request.changes:
        if change.id in seen or change.id not in rows:
            raise ValueError('Unknown or repeated route ID.')
        seen.add(change.id)
        previous = rows[change.id]
        if not previous['url'] or not previous['health_url']:
            raise ValueError('Configure this endpoint safely on Core before editing its address.')
        url = checked_url(change.url)
        if urlsplit(url).path != urlsplit(previous['url']).path:
            raise ValueError('Keep the API path; only change scheme, host or port.')
        if url == previous['url']:
            continue
        changes.append({'id':change.id, 'before':previous['url'], 'after':url,
                        'health_url':origin(url)+urlsplit(previous['health_url']).path})
        rows[change.id]['url'] = url
    if not changes:
        raise ValueError('No routing changes to apply.')
    device_hosts = {d['id']:d['host'] for d in data['devices']}
    endpoints = [(r['id'], r['url']) for r in rows.values() if r['url']]
    represented = {r['service_id'] for r in rows.values()}
    for s in data['services']:
        host = device_hosts.get(s['device'])
        if s['id'] not in represented and host and s['port']:
            endpoints.append(('inventory:'+s['id'], f"http://{host}:{s['port']}"))
    changed_ids = {c['id'] for c in changes}
    addresses = resolved_hosts({urlsplit(url).hostname for _, url in endpoints}, device_hosts)
    for index, (left_id, left_url) in enumerate(endpoints):
        left = urlsplit(left_url)
        for right_id, right_url in endpoints[index+1:]:
            if not ({left_id, right_id} & changed_ids):
                continue
            right = urlsplit(right_url)
            if ((left.port or (443 if left.scheme == 'https' else 80)) == (right.port or (443 if right.scheme == 'https' else 80))
                    and addresses[left.hostname] & addresses[right.hostname]):
                raise ValueError(f'Address/port collision: {left_id} and {right_id}.')
    return {'revision':data['revision'], 'changes':changes, 'warnings':[
        'Existing service tokens will be used at the new addresses. Use only trusted devices.',
        'No remote installation, restart, bind-port change, file move, or automatic client migration.',
        'Collision checks include matching hosts, loopback aliases and DNS resolved within one second. Unresolved aliases need manual verification.',
        'Inventory ownership is documentation. Update topology and other direct clients after moving a service.']}


def apply_plan(request: RoutePlan) -> dict:
    if not request.confirm:
        raise ValueError('Review the preview and confirm before applying.')
    with SETTINGS_LOCK:
        plan = make_plan(request)
        values, nodes = {}, []
        for node in settings.voice_nodes:
            item = node.model_dump(exclude={'token'})
            item['token'] = node.token.get_secret_value()
            nodes.append(item)
        for change in plan['changes']:
            if change['id'].startswith('voice:'):
                item = next(n for n in nodes if 'voice:'+n['id'] == change['id'])
                item['url'], item['health_url'] = change['after'], change['health_url']
                values['voice_service_registry'] = json.dumps(nodes)
            else:
                attribute, health_attribute = ROUTES[change['id']]
                values[attribute] = change['after']
                if health_attribute:
                    values[health_attribute] = change['health_url']
        path = Path(settings.runtime_settings_path)
        atomic_write(path.with_name('routing-before-change.json'), json.dumps(load_runtime_overrides(path)))
        update_runtime_settings(settings, values)
        return {'ok':True, 'applied':plan['changes'], 'snapshot':snapshot()}


@router.get('/api/devices')
def get_devices():
    return snapshot()


@router.post('/api/devices/preview')
def preview_devices(request: RoutePlan):
    try:
        return make_plan(request)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.post('/api/devices/apply')
def apply_devices(request: RoutePlan):
    try:
        return apply_plan(request)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except OSError:
        raise HTTPException(503, 'Could not persist routing. Check Core storage.') from None
