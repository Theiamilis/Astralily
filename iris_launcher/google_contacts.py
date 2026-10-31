"""Local, read-only Google Contacts connection for the desktop launcher.

OAuth credentials never go to Core, WhatsApp, or the frontend. Only explicitly
selected names and numbers become secretary rules through the existing editor.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCOPE = "https://www.googleapis.com/auth/contacts.readonly"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CONTACTS_URL = "https://people.googleapis.com/v1/people/me/connections"


def protect(data: bytes, decrypt: bool = False) -> bytes:
    """Use the Windows account's DPAPI; Unix relies on mode 0600."""
    if os.name != "nt":
        return data
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), "IRIS Google Contacts", None, None, None, 1, ctypes.byref(result))
    if not ok:
        raise ValueError("Google connection storage is unavailable for this Windows account.")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def google_request(url, *, form=None, token=None):
    headers = {}
    body = None
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.build_opener(NoRedirect).open(
            urllib.request.Request(url, data=body, headers=headers), timeout=20
        ) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Google returned an oversized response.")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        if error.code in (400, 401):
            raise ValueError("Google authorization expired or was rejected. Disconnect and connect again.") from None
        if error.code == 403:
            raise ValueError("Google denied access. Enable People API and allow read-only Contacts access.") from None
        if error.code == 429:
            raise ValueError("Google rate limit reached. Try Sync again later.") from None
        raise ValueError("Google request failed. Try again later.") from None
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        raise ValueError("Could not reach Google. Check the connection and try again.") from None


def normalize_number(value):
    value = str(value).strip()
    if not re.fullmatch(r"[+\d\s().-]+", value, flags=re.ASCII):
        return None
    number = re.sub(r"\D", "", value)
    if number.startswith("00"):
        number = number[2:]
    elif number.startswith("0"):
        number = "62" + number[1:]
    return number if 8 <= len(number) <= 16 else None


def contact_rows(people):
    rows = {}
    for person in people:
        names = person.get("names") or []
        name = str(names[0].get("displayName", ""))[:80] if names else ""
        for phone in person.get("phoneNumbers") or []:
            number = normalize_number(phone.get("canonicalForm") or phone.get("value", ""))
            if number and number not in rows:
                rows[number] = {"number": number, "label": name or number}
    return sorted(rows.values(), key=lambda row: (row["label"].casefold(), row["number"]))


class GoogleContacts:
    def __init__(self, directory: Path):
        self.path = directory / "google-contacts.bin"
        self.lock = threading.RLock()
        self.pending = None
        self.notice = ""

    def _read(self):
        try:
            return json.loads(protect(self.path.read_bytes(), decrypt=True))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            raise ValueError("Cannot read Google connection. Use Disconnect to clear local data.") from None

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(protect(json.dumps(data).encode()))
            temporary.replace(self.path)
        except OSError:
            raise ValueError("Could not save Google connection on this device.") from None

    def status(self):
        with self.lock:
            data = self._read()
            return {"configured": bool(data.get("client")), "connected": bool(data.get("tokens")),
                    "pending": bool(self.pending), "notice": self.notice,
                    "synced_at": data.get("synced_at"), "contacts": data.get("contacts", [])}

    def configure(self, payload):
        client = payload.get("installed")
        if not isinstance(client, dict):
            raise ValueError("Choose the OAuth JSON downloaded for a Desktop app, not a web app or service account.")
        client_id = client.get("client_id", "")
        secret = client.get("client_secret", "")
        if not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", client_id):
            raise ValueError("Invalid Google Desktop client ID.")
        if not isinstance(secret, str) or not 1 <= len(secret) <= 512:
            raise ValueError("Invalid Google Desktop client secret.")
        with self.lock:
            data = self._read()
            if data.get("tokens") or self.pending:
                raise ValueError("Disconnect Google before replacing the OAuth configuration.")
            self._write({"client": {"client_id": client_id, "client_secret": secret}})
            self.notice = "OAuth configured. Connect Google to authorize read-only access."
        return self.status()

    def connect(self):
        with self.lock:
            data = self._read()
            if not data.get("client"):
                raise ValueError("Import your Google Desktop OAuth JSON first.")
            if data.get("tokens"):
                raise ValueError("Already connected. Use Sync contacts, or Disconnect to switch accounts.")
            if self.pending:
                raise ValueError("Google sign-in is already open. Complete it or use Disconnect to cancel.")
            owner = self

            class Callback(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass  # Authorization codes and state must never enter logs.

                def do_GET(self):
                    parsed = urllib.parse.urlparse(self.path)
                    query = urllib.parse.parse_qs(parsed.query)
                    ok, message = owner.finish(query) if parsed.path == "/" else (False, "Not found")
                    body = (message + "\nReturn to IRIS Launcher. You can close this tab.").encode()
                    self.send_response(200 if ok else 400)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            server = ThreadingHTTPServer(("127.0.0.1", 0), Callback)
            server.daemon_threads = True
            verifier = secrets.token_urlsafe(48)
            state = secrets.token_urlsafe(32)
            redirect = f"http://127.0.0.1:{server.server_port}/"
            self.pending = {"server": server, "state": state, "verifier": verifier,
                            "redirect": redirect, "deadline": time.monotonic() + 300}
            threading.Thread(target=server.serve_forever, daemon=True).start()
            timer = threading.Timer(300, self.expire, args=(state,))
            timer.daemon = True
            timer.start()
            params = {"client_id": data["client"]["client_id"], "redirect_uri": redirect,
                      "response_type": "code", "scope": SCOPE, "state": state,
                      "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="),
                      "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent select_account"}
            if not webbrowser.open("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)):
                self._cancel()
                raise ValueError("Could not open the default browser. Check the Windows default browser and retry.")
            self.notice = "Waiting for Google sign-in. This request expires in five minutes."
        return self.status()

    def _cancel(self):
        pending, self.pending = self.pending, None
        if pending:
            def close():
                pending["server"].shutdown()
                pending["server"].server_close()
            threading.Thread(target=close, daemon=True).start()

    def expire(self, state):
        with self.lock:
            if self.pending and self.pending["state"] == state:
                self._cancel()
                self.notice = "Google sign-in timed out. Connect again when ready."

    def finish(self, query):
        with self.lock:
            pending = self.pending
            state = query.get("state", [""])[0]
            if not pending or time.monotonic() > pending["deadline"] or not secrets.compare_digest(state, pending["state"]):
                return False, "Invalid or expired Google sign-in."
            self._cancel()  # Consume valid state exactly once, even if Google denies consent.
            try:
                if query.get("error") or not query.get("code"):
                    raise ValueError("Google access was not granted. No account connected.")
                data = self._read()
                tokens = google_request(TOKEN_URL, form={**data["client"], "code": query["code"][0],
                    "code_verifier": pending["verifier"], "redirect_uri": pending["redirect"], "grant_type": "authorization_code"})
                if SCOPE not in tokens.get("scope", "").split() or not tokens.get("refresh_token") or not tokens.get("access_token"):
                    raise ValueError("Google did not grant persistent read-only Contacts access. Connect again and allow Contacts.")
                tokens["expires_at"] = time.time() + int(tokens.get("expires_in", 3600))
                data["tokens"] = tokens
                self._write(data)
                self.notice = "Google connected. Click Sync contacts to load names and phone numbers."
                return True, self.notice
            except ValueError as error:
                self.notice = str(error)
                return False, self.notice

    def sync(self):
        with self.lock:
            data = self._read()
            tokens = data.get("tokens")
            if not tokens:
                raise ValueError("Connect Google before syncing contacts.")
            if tokens.get("expires_at", 0) < time.time() + 60:
                refreshed = google_request(TOKEN_URL, form={**data["client"], "refresh_token": tokens["refresh_token"], "grant_type": "refresh_token"})
                if not refreshed.get("access_token"):
                    raise ValueError("Google did not return an access token. Reconnect Google.")
                tokens.update(refreshed)
                tokens["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
                self._write(data)
            people, page, seen = [], None, set()
            deadline = time.monotonic() + 120
            for _ in range(100):
                if time.monotonic() > deadline:
                    raise ValueError("Contact sync timed out. Previous contacts were kept; try again.")
                params = {"personFields": "names,phoneNumbers", "pageSize": 1000, "sources": "READ_SOURCE_TYPE_CONTACT"}
                if page:
                    params["pageToken"] = page
                result = google_request(CONTACTS_URL + "?" + urllib.parse.urlencode(params), token=tokens["access_token"])
                people.extend(result.get("connections", []))
                page = result.get("nextPageToken")
                if not page:
                    break
                if page in seen:
                    raise ValueError("Google returned repeated pages. Previous contacts were kept.")
                seen.add(page)
            else:
                raise ValueError("Contact list exceeded the sync limit. Previous contacts were kept.")
            data["contacts"] = contact_rows(people)
            data["synced_at"] = time.time()
            self._write(data)
            self.notice = "Contacts synced. Select contacts to add rules; existing rules are unchanged."
        return self.status()

    def disconnect(self):
        with self.lock:
            self._cancel()
            try:
                data = self._read()
            except ValueError:
                data = {}
            token = data.get("tokens", {}).get("refresh_token")
            # Clear local access even if revocation cannot reach Google.
            self.path.unlink(missing_ok=True)
            self.notice = "Disconnected. Local credentials and contacts cleared; saved secretary rules remain."
            if token:
                try:
                    google_request("https://oauth2.googleapis.com/revoke", form={"token": token})
                except ValueError:
                    self.notice += " Google revocation could not be confirmed; remove IRIS access in your Google Account connections."
        return self.status()
