# Lily Voice Vessel

Lily Voice Vessel is a small FastAPI wrapper for GPT-SoVITS. Run it on the device that owns the SoVITS model files and reference audio, then point Lily Core to it.

## Setup

```bat
setup.bat
start.bat
```

Default URL:

```text
http://127.0.0.1:10881/api/voice/synthesize
```

Health URL:

```text
http://127.0.0.1:10881/health
```

Profiles with `LILY_VOICE_PROFILE_<ID>_PITCH_SEMITONES` use FFmpeg for
post-synthesis pitch correction while preserving tempo. Set
`LILY_VOICE_FFMPEG_PATH` when FFmpeg is not available through `PATH`.

## Local voice compare

For quick A/B tests on the same TTS device, define extra profile ids in `lily_voice_vessel/.env`, for example:

```env
LILY_VOICE_HEALTH_PROFILES=ja,kokomi_ja,en,zeta_en,watson_en

LILY_VOICE_PROFILE_ZETA_EN_API_URL=http://127.0.0.1:10880
LILY_VOICE_PROFILE_ZETA_EN_GPT_MODEL_PATH=
LILY_VOICE_PROFILE_ZETA_EN_SOVITS_MODEL_PATH=
LILY_VOICE_PROFILE_ZETA_EN_REF_AUDIO=C:/path/to/LilyConstellation/local_assets/voice_models/gpt-sovits/vestia-zeta/references/A1 (Neutral).wav
LILY_VOICE_PROFILE_ZETA_EN_REF_TEXT=I think it's a good idea to have the reload there, because sometimes in movies, sometimes they don't reload
LILY_VOICE_PROFILE_ZETA_EN_TEXT_LANGUAGE=en
LILY_VOICE_PROFILE_ZETA_EN_PROMPT_LANGUAGE=en

LILY_VOICE_PROFILE_WATSON_EN_API_URL=http://127.0.0.1:10880
LILY_VOICE_PROFILE_WATSON_EN_GPT_MODEL_PATH=
LILY_VOICE_PROFILE_WATSON_EN_SOVITS_MODEL_PATH=
LILY_VOICE_PROFILE_WATSON_EN_REF_AUDIO=C:/path/to/LilyConstellation/local_assets/voice_models/gpt-sovits/amelia-watson/references/A1 (Neutral).wav
LILY_VOICE_PROFILE_WATSON_EN_REF_TEXT=get along that one either. It's it's uh I didn't like it, but I guess when I saw it at the time, I was like, this is pretty believable.
LILY_VOICE_PROFILE_WATSON_EN_TEXT_LANGUAGE=en
LILY_VOICE_PROFILE_WATSON_EN_PROMPT_LANGUAGE=en

LILY_VOICE_PROFILE_KOKOMI_JA_API_URL=http://127.0.0.1:10880
LILY_VOICE_PROFILE_KOKOMI_JA_GPT_MODEL_PATH=C:/path/to/LilyConstellation/local_assets/voice_models/gpt-sovits/kokomi/gpt.ckpt
LILY_VOICE_PROFILE_KOKOMI_JA_SOVITS_MODEL_PATH=C:/path/to/LilyConstellation/local_assets/voice_models/gpt-sovits/kokomi/sovits.pth
LILY_VOICE_PROFILE_KOKOMI_JA_REF_AUDIO=C:/path/to/LilyConstellation/local_assets/voice_models/gpt-sovits/kokomi/references/neutral.wav
LILY_VOICE_PROFILE_KOKOMI_JA_REF_TEXT=The situation is ever-changing in a card game. To emerge victorious, you have to be willing to take some risks.
LILY_VOICE_PROFILE_KOKOMI_JA_TEXT_LANGUAGE=ja
LILY_VOICE_PROFILE_KOKOMI_JA_PROMPT_LANGUAGE=en
LILY_VOICE_PROFILE_KOKOMI_JA_PITCH_SEMITONES=-0.5
```

Then generate one sample per profile:

```bat
python scripts\voice_compare.py --profiles zeta_en,watson_en --text "Hello, this is Lily voice compare."
```

The helper downloads each WAV into `lily_voice_vessel/static/audio/compare/<timestamp>/`.

## Core config

In `lily_essence_core/.env`:

```env
LILY_VOICE_SERVICE_REGISTRY=[{"id":"Lily-Voice-Host","url":"http://Lily-Voice-Host:10881/api/voice/synthesize","health_url":"http://Lily-Voice-Host:10881/health","profiles":["ja","kokomi_ja","en","zeta_en","watson_en"],"priority":10,"cooldown_seconds":30}]
```

Core tries healthy registry nodes in priority order and falls back to local GPT-SoVITS. The legacy `LILY_VOICE_SERVICE_URL`, `LILY_VOICE_SERVICE_HEALTH_URL`, and `LILY_VOICE_SERVICE_TOKEN` settings remain compatible as one default node when the registry is empty.
