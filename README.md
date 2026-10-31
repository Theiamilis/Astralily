# AstraLily

AstraLily is a personal AI assistant system built around a FastAPI core, independent capability services, Android and browser clients, voice synthesis, and optional Live2D presentation. The character name is configurable; existing `lily_*` source paths are retained for compatibility.

Start with the [engineering overview](docs/ENGINEERING.md) for the request flow, recent changes, and testing limits.

## Current capabilities

- Session-aware conversation with SQLite-backed runtime state and configurable providers.
- Native Android chat with system speech recognition or server transcription, Indonesian/English/Japanese input selection, and optional voice replies.
- Conversational device commands with separate interpretation, target resolution, clarification, and dispatch responsibilities.
- Voice profiles served by separately configured synthesis services; clients own playback.
- WhatsApp delivery with owner-aware routing and optional secretary settings, including contact policies.
- A shared model registry for independently supplied Live2D assets and frontend assignments.

Availability depends on the configured services, provider, OS speech recognizer, and hardware. This snapshot does not assert that every integration has been tested on every device.

This repository is a generated public snapshot. It is intentionally separate from the owner's private development repository and contains no runtime databases, credentials, device topology, character models, voice models, WhatsApp sessions, or personal finance ledger.

## Included components

| Component | Purpose | Default port |
|---|---|---:|
| `lily_essence_core` | Session-aware AI brain, routing, APIs, and state | `8000` |
| `lily_control_center` | Browser dashboard and operator controls | `5231` |
| `lily_private_realm` | Desktop companion interface | `5230` |
| `lily_mobile_realm_android` | Native Android companion | Android app |
| `lily_wa_vessel` | WhatsApp bridge | `8091` |
| `lily_voice_vessel` | GPT-SoVITS voice adapter | `10881` |
| `lily_tool_vessel` | External agent and tool execution | `8092` |
| `lily_model_vessel` | Live2D model registry and assignment | `10898` |
| `lily_home_vessel` | Local smart-home execution | `10896` |
| `lily_stt_vessel` | FLily-Voice-Host-Whisper transcription | `10894` |
| `iris_launcher` | Local setup and service dashboard for Windows | `5240` |

## Intentionally excluded

- `lily_finance_vessel` and its private ledger implementation.
- The separate Family app, Family and owner gateways, and listener service.
- `lily_file_vessel`, `lily_hud_vessel`, `lily_stream_stage`, `lily_stream_voice_vessel`, the TikTok bridge, and the gameplay hotkey sidecar.
- Local `.env` files, SQLite databases, logs, caches, WhatsApp auth sessions, generated audio, and tool artifacts.
- Live2D/Cubism SDK files, character models, voice weights, and the GPT-SoVITS checkout.
- Owner-specific hostnames, network topology, paths, operational notes, and agent memory.

Core and client code may retain disabled adapter hooks for omitted components. Their backing services are not shipped in this edition and are absent from the public port and topology registries.

## Quick start

The easiest path is the local Core + Private Realm setup. It needs Python 3.10+, Node.js 20+, and one configured text provider such as LM Studio or a compatible cloud API:

```bash
./setup_public.sh
./start_public.sh
```

On Windows, run `setup_public.bat`, then `start_public.bat`. Open <http://localhost:5230>.

The setup creates the Core virtual environment, installs dependencies, runs `npm ci` for the desktop companion, creates local `.env` files, and generates a local owner token. Configure the provider and model in `lily_essence_core/.env` before starting Core. See [PUBLIC_SETUP.md](PUBLIC_SETUP.md) for provider and troubleshooting notes.

Each component remains independent and owns its dependencies; there is no root workspace package manager. After the first run, optional vessels can be installed with their own `setup` scripts.

The Android client lives under `lily_mobile_realm_android/` and should be opened with Android Studio. Live2D SDK and model assets must be restored separately; see [docs/LOCAL_ASSETS.md](docs/LOCAL_ASSETS.md). The browser companion uses an asset-free placeholder stage until you add assets you are licensed to use.

On Windows, `start_iris.bat` opens the optional IRIS Launcher. It binds to loopback and controls only services in the local checkout. See [IRIS Launcher](iris_launcher/README.md) before using its setup or service controls. The native desktop wrapper can be built separately; Python mode works without building it.

## External asset sources and credits

This repository links to external assets but does not redistribute their model files, voice weights, reference audio, or SDK binaries. Check each source's current terms and obtain any permission required before using or redistributing an asset.

- **Live2D model / artist source:** [Bilibili artist page](https://space.bilibili.com/1388414536). Credit and usage rights for the model remain with the artist and other rightsholders.
- **GPT-SoVITS engine:** [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS). Follow the upstream `LICENSE` and setup instructions.
- **GPT-SoVITS voice model:** [Kit-Lemonfoot GPT-SoVITS models](https://huggingface.co/Kit-Lemonfoot/kitlemonfoot_gptsovits_models). The model card requests credit to Kit Lemonfoot and lists `creativeml-openrail-m`; review the model card and underlying voice/data rights before use.
- **Live2D Cubism SDK:** [official SDK license and release terms](https://www.live2d.com/en/sdk/license/). The SDK must be obtained and restored separately under its own terms.

## Validation

```bash
python scripts/github_publish_check.py
python scripts/ports.py check
python scripts/topology.py check
python -m compileall -q lily_essence_core lily_voice_vessel lily_tool_vessel lily_model_vessel lily_home_vessel lily_stt_vessel
node --check lily_wa_vessel/bridge.js
```

## Security

- Copy `.env.example` to `.env`; never commit the resulting `.env` file.
- Keep service tokens enabled outside local development.
- Treat Tool, File, Home, and WhatsApp access as owner-only capabilities.
- Review every public contribution with `scripts/github_publish_check.py` before pushing.

## Licensing

The root `LICENSE` applies only to original source code that the repository owner is able to license. No third-party SDK, model, character, voice, or other asset license is granted by this repository. Keep upstream headers and attribution files with their respective code, and obtain separate permission or licenses for assets before redistributing them.
