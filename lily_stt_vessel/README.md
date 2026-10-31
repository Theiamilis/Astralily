# Lily STT Vessel

Lily STT Vessel is a small FastAPI speech-to-text router for WhatsApp voice notes and owner clients. The default provider chain uses Groq Whisper first and keeps local `fLily-Voice-Host-whisper` as an automatic fallback.

Run it on the always-on device near WhatsApp Bridge, then point `lily_wa_vessel` to it. A successful cloud transcription does not load the local Whisper model, keeping idle RAM and CPU use low.

## Setup

```bat
cd lily_stt_vessel
setup.bat
start.bat
```

```bash
cd lily_stt_vessel
chmod +x setup_linux.sh start_linux.sh
PYTHON_BIN=python3.13 ./setup_linux.sh
./start_linux.sh
```

Default runtime:

- Port: `10894`
- Provider chain: `groq,local`
- Cloud model: `whisper-large-v3-turbo`
- Local fallback model: `base` on CPU with `int8`
- Compute: `int8`
- Max audio: `45` seconds

## Provider Configuration

```env
LILY_STT_PROVIDER_CHAIN=groq,local
LILY_STT_GROQ_API_KEY=
LILY_STT_GROQ_MODEL=whisper-large-v3-turbo
LILY_STT_GROQ_TIMEOUT_SECONDS=30
```

`LILY_STT_GROQ_API_KEY` takes precedence over the shared `GROQ_API_KEY` environment variable. When no Groq key is configured, the service remains healthy through the local provider. Set `LILY_STT_PROVIDER_CHAIN=local` to keep all audio on-device, or `groq` to disable local fallback.

Audio sent through Groq leaves the local network. Keep the local-only mode for sensitive recordings.

## API

```text
GET  /health
POST /api/stt/transcribe
POST /api/stt/transcribe/local
```

`/api/stt/transcribe` expects multipart form data:

- `file`: audio upload such as WhatsApp OGG/Opus voice note
- `language`: optional Whisper language hint, for example `id`, `en`, or `ja`

`/api/stt/transcribe/local` accepts the same fields but uses only the local
Whisper provider, even when the configured provider chain starts with Groq.
Listener uses this route for ambient wake-phrase checks. If the local model is
unavailable, the request fails instead of sending room speech to a cloud STT
provider.

If `LILY_STT_VESSEL_TOKEN` is set, pass it as `X-Lily-STT-Token` or `Authorization: Bearer <token>`.

## WA Bridge

Set this in `lily_wa_vessel/.env`:

```env
LILY_STT_TRANSCRIBE_URL=http://127.0.0.1:10894/api/stt/transcribe
LILY_STT_HEALTH_URL=http://127.0.0.1:10894/health
LILY_STT_TOKEN=
LILY_STT_TIMEOUT_MS=60000
LILY_STT_MAX_AUDIO_BYTES=10485760
```

When STT is reachable, owner WhatsApp voice notes are transcribed and routed like normal text.
When STT is offline or the voice note is too long, WA falls back to the existing text-only voice unavailable reply.
