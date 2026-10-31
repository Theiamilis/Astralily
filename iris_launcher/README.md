# IRIS Launcher

IRIS Launcher is an optional local dashboard for configuring and starting parts of an AstraLily checkout. Its Python backend binds to `127.0.0.1:5240`; do not expose this port to a LAN, reverse proxy, or tunnel.

## Start on Windows

From the repository root, run:

```bat
start_iris.bat
```

The browser launcher requires Python 3.10+. The optional Tauri desktop wrapper requires Node.js/npm, Rust with the MSVC toolchain, and WebView2. Build it by running `iris_launcher\desktop\build_native.bat`; the executable stays in the local checkout under `iris_launcher\dist\`.

You can also start the Python launcher directly:

```powershell
py -3 -m iris_launcher.app
```

Open <http://127.0.0.1:5240> if the browser does not open automatically. Windows service controls use the repository's `scripts/lily.ps1` and operate on this checkout only. Remote services are not started or restarted by those controls.

## Local data and access

Launcher settings, session state, and device-management state are created under `iris_launcher/runtime/` and are excluded from this snapshot. The setup wizard writes only its documented `.env` allowlist, keeps secret values out of browser responses, and uses a loopback session cookie plus CSRF token for changes. Keep the app on the local machine and review each configuration before saving it.

The launcher does not bundle Core credentials, service tokens, model files, or device-specific connection settings. Create local `.env` files from the supplied examples and configure the services you intend to use. The vessel-management view is optional and depends on the corresponding Core APIs and trusted device setup; it does not make a remote service available by itself.

## Linux

`iris_launcher/start_linux.sh` can start the local browser interface, but process start/stop controls are currently Windows-only. Use the component-specific Linux scripts for service management.
