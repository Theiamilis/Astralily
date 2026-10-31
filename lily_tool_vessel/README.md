# Lily Tool Vessel

Lily Tool Vessel is a small FastAPI executor for external tool agents such as Hermes or OpenClaw. Run it on the device that should own tool execution, browser automation, file tasks, and heavier agent work.

It keeps Lily Core light:

```text
WA / Control Center
  -> lily_essence_core
  -> lily_tool_vessel
  -> hermes or openclaw CLI
  -> result back to core
```

## Setup

Windows:

```bat
setup.bat
start.bat
```

Linux:

```bash
chmod +x setup_linux.sh start_linux.sh
./setup_linux.sh
./start_linux.sh
```

Default URL:

```text
http://127.0.0.1:8092
```

Health:

```text
http://127.0.0.1:8092/health
```

Run endpoint:

```text
POST /api/tool/run
```

Deterministic device-power endpoints:

```text
GET  /api/device-power/targets
GET  /api/device-power/status
GET  /api/device-power/history
GET  /api/device-power/watchers
POST /api/device-power/run
```

Device power does not call Hermes or OpenClaw. It resolves an enabled target from `config/topology.json`, requires an already-confirmed typed request, and executes only a fixed platform command over key-only SSH. Shutdown and restart use a 60-second delay so the owner can send a cancel action. Tool Vessel stores a bounded JSONL audit trail and watches shutdown, hibernate, and restart transitions. Terminal watcher events are sent back to Core for SSE and optional WhatsApp owner notification delivery.

## Core Config

In `lily_essence_core/.env`, enable remote tool execution:

```env
LILY_TOOL_AGENT_MODE=remote
LILY_TOOL_AGENT_PROVIDER=hermes
LILY_TOOL_AGENT_URL=http://<tool-device-tailscale-ip>:8092/api/tool/run
LILY_TOOL_AGENT_HEALTH_URL=http://<tool-device-tailscale-ip>:8092/health
LILY_TOOL_AGENT_TOKEN=
LILY_TOOL_AGENT_TIMEOUT_SECONDS=180
```

Leave `LILY_TOOL_AGENT_MODE=local` to keep the old behavior where Lily Core runs `openclaw` directly on the same device.

## Fallback

Tool Vessel tries the requested/default provider first. If it fails and `LILY_TOOL_FALLBACK_ENABLED=true`, it tries the next unique provider from `LILY_TOOL_AGENT_FALLBACK_CHAIN`.

Configure fallback in `lily_tool_vessel/.env`:

```env
LILY_TOOL_FALLBACK_ENABLED=true
LILY_TOOL_AGENT_FALLBACK_CHAIN=hermes,openclaw
```

Response metadata includes:

```json
{
  "provider": "openclaw",
  "requested_provider": "hermes",
  "fallback_used": true,
  "provider_attempts": [
    {"provider": "hermes", "status": "failed", "error": "..."},
    {"provider": "openclaw", "status": "completed", "error": ""}
  ]
}
```

## External Agents

Hermes and OpenClaw are not vendored into this repo. Install them on the same device that runs this vessel and keep their runtime homes outside the cloned Lily folder.

Recommended local layout:

```text
C:\AI\
  LilyAi\
    lily_tool_vessel\
  LilyAgents\
    hermes-home\
    openclaw-home\
```

The vessel only needs the CLI command to work:

```bat
hermes -z "reply only: HERMES_OK"
openclaw agent --message "reply only: OPENCLAW_OK"
```

## Security

Set `LILY_TOOL_VESSEL_TOKEN` and use the same value as `LILY_TOOL_AGENT_TOKEN` in core when exposing this over LAN or Tailscale.

Keep Stream Stage and TikTok blocked at the core layer. This vessel should be reachable only by Lily Core or trusted owner-only tooling.

Remote power additionally requires:

- an explicit enabled target in `config/topology.json`;
- owner confirmation in Core before the Tool Vessel request;
- `confirmed: true` in the typed request schema;
- SSH batch mode and a known host key;
- a fixed action from `shutdown`, `restart`, `hibernate`, or `cancel`;
- a local JSONL audit record without free-form command text.
