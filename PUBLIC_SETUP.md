# Public local setup

The public snapshot includes a one-command setup for the browser companion. It does not install proprietary models, voice checkpoints, or SDKs; configure a text provider that you are licensed to use before starting Core.

## Windows

From the repository root, run:

```powershell
.\setup_public.bat
.\start_public.bat
```

Then open <http://localhost:5230>.

## Linux and macOS

```bash
chmod +x setup_public.sh start_public.sh
./setup_public.sh
./start_public.sh
```

The setup creates the Core virtual environment, installs the Core dependencies, installs the Private Realm dependencies with `npm ci`, creates local `.env` files, and generates a local owner token. Existing `.env` values are preserved except for the frontend token, which is synchronized with the Core token so the two local services can communicate.

Before starting Core, edit `lily_essence_core/.env` and choose `lmstudio`, `openai_compat`, `claude`, or `gemini`, including the matching model and credential where required. Restart Core after changing provider settings.

The Live2D stage intentionally shows an asset-free placeholder in this public edition. Restore your own licensed Cubism SDK and model assets separately before enabling a real stage; never commit those files.

## Troubleshooting

- Python 3.10+ and Node.js 20+ are required.
- If the page says Core is offline, keep `start_public` running and check `http://localhost:8000/health/live`.
- If you change the Core token manually, run setup again or copy the same value to `VITE_LILY_OWNER_API_TOKEN` in `lily_private_realm/.env`.
- The setup scripts are for the included Core + Private Realm path. Optional vessels keep their own setup scripts and are not required for the first run.
