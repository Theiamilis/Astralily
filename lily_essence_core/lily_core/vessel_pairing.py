"""Owner-approved provisioning of inbound vessels; never grants Core API access."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import threading
import time
import uuid
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, ed25519

from .device_registry import DeviceRegistryError
from .runtime_settings import SETTINGS_LOCK, update_runtime_settings

# Core-owned edges only. WA, browser and storage consumers keep separate setup.
SERVICES = {
    'home': ('home_vessel_url', 'home_vessel_token', ''),
    'tool': ('tool_agent_url', 'tool_agent_token', '/api/tool/run'),
    'stt': ('stt_service_url', 'stt_service_token', '/api/stt/transcribe'),
    'finance': ('finance_vessel_url', 'finance_vessel_token', ''),
    'voice': ('voice_service_url', 'voice_service_token', '/api/voice/synthesize'),
    'stream_voice': ('stream_voice_service_url', 'stream_voice_service_token', '/api/voice/synthesize'),
}


def verification_code(payload):
    canonical = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(canonical).hexdigest()[:12].upper()


def probe(base, token, service):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    request = urllib.request.Request(base + '/api/auth/check', headers={'X-Lily-Token': token})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=4) as response:
            return json.loads(response.read(4096)) == {'authenticated': True, 'service': service}
    except (OSError, ValueError):
        return False


class VesselPairing:
    def __init__(self, path, settings, checker=probe):
        self.path, self.settings, self.checker = Path(path), settings, checker
        self.lock = threading.RLock()

    @contextmanager
    def connect(self):
        new_directory = not self.path.parent.exists()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if new_directory:
            self.path.parent.chmod(0o700)
            if os.name == 'nt':
                import csv
                sid = list(csv.reader(subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'],
                    text=True, creationflags=subprocess.CREATE_NO_WINDOW).splitlines()))[0][1]
                subprocess.run(['icacls', str(self.path.parent), '/inheritance:r', '/grant:r', f'*{sid}:(OI)(CI)F'],
                    check=True, stdout=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        if not self.path.exists():
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            if os.name == 'nt':
                import csv
                sid = list(csv.reader(subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'],
                    text=True, creationflags=subprocess.CREATE_NO_WINDOW).splitlines()))[0][1]
                subprocess.run(['icacls', str(self.path), '/inheritance:r', '/grant:r', f'*{sid}:F'],
                    check=True, stdout=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('CREATE TABLE IF NOT EXISTS vessels (id TEXT PRIMARY KEY, payload TEXT NOT NULL, host TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, status TEXT NOT NULL, token TEXT NOT NULL DEFAULT "", envelope TEXT NOT NULL DEFAULT "")')
        db.execute('CREATE TABLE IF NOT EXISTS pairing_keys (id INTEGER PRIMARY KEY, secret BLOB NOT NULL)')
        if db.execute('SELECT id FROM pairing_keys WHERE id=1').fetchone() is None:
            key = ed25519.Ed25519PrivateKey.generate()
            db.execute('INSERT INTO pairing_keys VALUES (1,?)', (key.private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()),))
        self.path.chmod(0o600)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def public(row, envelope=False):
        data = json.loads(row['payload'])
        result = {'id': row['id'], 'name': data['name'], 'service': data['service'],
                  'host': row['host'], 'port': data['port'], 'status': row['status'],
                  'code': verification_code(data), 'expires_at': row['expires'], 'server_key': data['server_key']}
        if envelope and row['status'] in {'approved', 'active'}:
            result['envelope'] = row['envelope']
        return result

    def expire(self, db):
        db.execute("UPDATE vessels SET status='expired', token='', envelope='' WHERE expires < ? AND status IN ('pending','approved')", (time.time(),))

    def submit(self, payload, host):
        if payload['service'] not in SERVICES:
            raise DeviceRegistryError('This vessel does not use a Core-managed connection yet.')
        try:
            address = ipaddress.ip_address(host)
            if ipaddress.ip_address(payload['host']) != address:
                raise ValueError()
            if address.is_unspecified or address.is_multicast or address.is_link_local:
                raise ValueError()
            key = serialization.load_der_public_key(base64.b64decode(payload['public_key'], validate=True))
            if not isinstance(key, rsa.RSAPublicKey) or key.key_size != 3072:
                raise ValueError()
        except (ValueError, TypeError):
            raise DeviceRegistryError('Invalid device key or source address.') from None
        with self.lock, self.connect() as db:
            self.expire(db)
            signing_key = ed25519.Ed25519PrivateKey.from_private_bytes(db.execute('SELECT secret FROM pairing_keys WHERE id=1').fetchone()[0])
            payload = {**payload, 'server_key': base64.b64encode(signing_key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()}
            # Bound both persistent storage and anonymous pending requests.
            db.execute("DELETE FROM vessels WHERE created < ? AND status IN ('expired','denied','revoked')", (time.time() - 86400 * 30,))
            db.execute("DELETE FROM vessels WHERE id IN (SELECT id FROM vessels WHERE status IN ('expired','denied','revoked') ORDER BY created DESC LIMIT -1 OFFSET 128)")
            if db.execute('SELECT COUNT(*) FROM vessels').fetchone()[0] >= 512:
                raise DeviceRegistryError('Pairing registry is full.', 429)
            if db.execute("SELECT COUNT(*) FROM vessels WHERE status IN ('pending','approved')").fetchone()[0] >= 20:
                raise DeviceRegistryError('Too many pending requests. Review them in Launcher.', 429)
            rid = uuid.uuid4().hex
            db.execute('INSERT INTO vessels(id,payload,host,created,expires,status) VALUES (?,?,?,?,?,?)',
                       (rid, json.dumps(payload), str(address), time.time(), time.time() + 900, 'pending'))
            return self.public(db.execute('SELECT * FROM vessels WHERE id=?', (rid,)).fetchone())

    def get_row(self, db, rid):
        row = db.execute('SELECT * FROM vessels WHERE id=?', (rid,)).fetchone()
        if row is None:
            raise DeviceRegistryError('Vessel request not found.', 404)
        return row

    def status(self, rid):
        with self.lock, self.connect() as db:
            self.expire(db)
            result = self.public(self.get_row(db, rid), envelope=True)
            if result.get('envelope'):
                key = ed25519.Ed25519PrivateKey.from_private_bytes(db.execute('SELECT secret FROM pairing_keys WHERE id=1').fetchone()[0])
                result['signature'] = base64.b64encode(key.sign((rid + ':' + result['envelope']).encode())).decode()
            return result

    def list(self):
        with self.lock, self.connect() as db:
            self.expire(db)
            return [self.public(row) for row in db.execute('SELECT * FROM vessels ORDER BY created DESC')]

    def decide(self, rid, action, code=''):
        with self.lock, SETTINGS_LOCK, self.connect() as db:
            self.expire(db)
            row = self.get_row(db, rid)
            payload = json.loads(row['payload'])
            if action == 'approve':
                if row['status'] != 'pending':
                    raise DeviceRegistryError('Request is no longer pending.', 409)
                if not hmac.compare_digest(code.upper(), verification_code(payload)):
                    raise DeviceRegistryError('Code does not match the new device.', 400)
                # Existing multi-profile voice nodes must not silently disappear.
                if payload['service'] == 'voice' and self.settings.voice_service_registry.strip():
                    raise DeviceRegistryError('Multiple voice profiles are configured. Use advanced setup for this voice node.', 409)
                token = secrets.token_urlsafe(48)
                key = serialization.load_der_public_key(base64.b64decode(payload['public_key']))
                envelope = base64.b64encode(key.encrypt(json.dumps({'id': rid, 'token': token}).encode(),
                    padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=rid.encode()))).decode()
                db.execute("UPDATE vessels SET status='approved', token=?, envelope=? WHERE id=?", (token, envelope, rid))
            elif action == 'deny':
                if row['status'] not in {'pending','approved'}:
                    raise DeviceRegistryError('Request cannot be denied.', 409)
                db.execute("UPDATE vessels SET status='denied', token='', envelope='' WHERE id=?", (rid,))
            elif action == 'revoke':
                if row['status'] == 'active':
                    _, token_field, _ = SERVICES[payload['service']]
                    if hmac.compare_digest(getattr(self.settings, token_field), row['token']):
                        update_runtime_settings(self.settings, {token_field: secrets.token_urlsafe(48)})
                db.execute("UPDATE vessels SET status='revoked', token='', envelope='' WHERE id=?", (rid,))
            else:
                raise DeviceRegistryError('Unsupported decision.')
            return self.public(self.get_row(db, rid))

    def activate(self, rid, proof):
        with self.lock, SETTINGS_LOCK, self.connect() as db:
            self.expire(db)
            row = self.get_row(db, rid)
            if row['status'] not in {'approved','active'} or not row['token']:
                raise DeviceRegistryError('Request is not approved.', 403)
            expected = hmac.new(row['token'].encode(), ('activate:' + rid).encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, proof):
                raise DeviceRegistryError('Device proof failed.', 401)
            if row['status'] == 'active':
                return self.public(row)
            data = json.loads(row['payload'])
            host = '[' + row['host'] + ']' if ':' in row['host'] else row['host']
            base = f"http://{host}:{data['port']}"
            if not self.checker(base, row['token'], data['service']):
                raise DeviceRegistryError('Vessel is not reachable yet. Start it and allow its port on the private network, then retry.', 409)
            url_field, token_field, suffix = SERVICES[data['service']]
            if data['service'] == 'voice' and self.settings.voice_service_registry.strip():
                raise DeviceRegistryError('Voice registry changed. Use advanced setup.', 409)
            values = {url_field: base + suffix, token_field: row['token']}
            if data['service'] == 'tool':
                values['tool_agent_mode'] = 'remote'
            health_field = {'voice':'voice_service_health_url', 'tool':'tool_agent_health_url',
                            'stream_voice':'stream_voice_service_health_url'}.get(data['service'])
            if health_field:
                values[health_field] = base + '/health'
            update_runtime_settings(self.settings, values)
            # One active Core route per service. Revoking a superseded node must
            # never alter the credentials belonging to its replacement.
            for old in db.execute("SELECT id,payload FROM vessels WHERE status='active'").fetchall():
                if json.loads(old['payload'])['service'] == data['service']:
                    db.execute("UPDATE vessels SET status='revoked', token='', envelope='' WHERE id=?", (old['id'],))
            db.execute("UPDATE vessels SET status='active' WHERE id=?", (rid,))
            return self.public(self.get_row(db, rid))
