# Lily Home Vessel

Lily Home Vessel is a small FastAPI service for local smart-home control. V0 starts with WiZ lights through their local UDP protocol, but the API is intentionally generic so future smart plugs, IR bridges, sensors, or scenes can live behind the same vessel.

Run it on a device that is on the same LAN as the smart devices.

## Setup

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

## WiZ Notes

Pair the bulb in the WiZ app first and keep local communication enabled in WiZ security settings. WiZ local control uses UDP port `38899`.

Home Vessel can follow DHCP changes automatically. Add the bulb MAC address as the optional seventh device field. On startup, and after a stale-host timeout, the vessel discovers the current address and stores it atomically in `runtime/wiz-host-cache.json`. Router DHCP reservations are still recommended, but an address change no longer requires an immediate configuration edit.

Example `.env`:

```env
LILY_HOME_VESSEL_TOKEN=
LILY_HOME_DEVICES=bedroom_light=wiz,198.51.100.9,light,Bedroom Light,bedroom,kamar|lampu kamar,A8:BB:50:12:34:56
LILY_HOME_SCENES={"cozy":[{"device":"bedroom_light","state":"on","brightness":35,"temperature_kelvin":2700}]}
LILY_HOME_WIZ_AUTO_DISCOVERY_ENABLED=true
LILY_HOME_WIZ_HOST_CACHE_PATH=runtime/wiz-host-cache.json
LILY_HOME_OFFLINE_FAILURE_THRESHOLD=4
```

State reads retain the last successful values while a device reconnects. `connection` progresses from `reconnecting` to `offline` after the configured number of consecutive failures, and `last_seen` records the most recent successful local response.

## API

```text
GET  /health
GET  /api/home/devices
GET  /api/home/devices/{device_id}/state
POST /api/home/devices/{device_id}/state
GET  /api/home/scenes
POST /api/home/scenes/{scene_id}/activate
POST /api/home/discover/wiz
```

## Core Integration

WhatsApp and Android Pocket Realm should send owner messages to Lily Core. They should not call this vessel directly or store its token.

Configure `lily_essence_core/.env` on the Core device:

```env
LILY_HOME_VESSEL_URL=http://127.0.0.1:10896
LILY_HOME_VESSEL_TOKEN=<same value as this vessel>
LILY_HOME_VESSEL_TIMEOUT_SECONDS=4.0
```

Core reads device names, rooms, and aliases from `GET /api/home/devices`, interprets the owner command, and sends a narrow validated state request back to this vessel.

Explicit controls use deterministic Core rules. Semantic ambience requests may use Core's LLM provider chain, but the resulting JSON is validated against configured device IDs and safe light ranges before this vessel receives an action. The vessel never runs the LLM itself.

Example control payload:

```json
{
  "state": "on",
  "brightness": 40,
  "temperature_kelvin": 2700
}
```

RGB example:

```json
{
  "state": "on",
  "rgb": [120, 40, 255],
  "brightness": 70
}
```

Set `LILY_HOME_VESSEL_TOKEN` before exposing this service beyond trusted local development. The token is accepted as either `Authorization: Bearer <token>` or `X-Lily-Home-Token`.
