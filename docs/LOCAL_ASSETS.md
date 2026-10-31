# Restoring Local Assets

The Public Edition deliberately excludes licensed SDKs, character models, voice weights, generated media, and authentication state.

## Live2D

Obtain the Live2D Cubism SDK under its own license and restore the framework files required by the frontend you want to run. Place your own model assets under `local_assets/live2d_models/` or the component-specific ignored `public/live2d/` directory.

For the model used in the original private setup, the external artist/model source is [this Bilibili page](https://space.bilibili.com/1388414536). The model files are not included here; confirm the artist's usage and redistribution terms before restoring or sharing them.

The Android client expects its model under:

```text
lily_mobile_realm_android/app/src/main/assets/live2d/current/
```

Do not commit restored SDK or model files.

## Voice synthesis

Install [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) separately and configure `lily_voice_vessel/.env` with local engine and model paths. The original voice model source is [Kit-Lemonfoot's GPT-SoVITS model repository](https://huggingface.co/Kit-Lemonfoot/kitlemonfoot_gptsovits_models); its model card requests credit to Kit Lemonfoot and lists `creativeml-openrail-m`. Voice weights and reference audio belong under an ignored local directory such as `local_assets/voice_models/`, and must not be redistributed without checking the applicable rights.

## WhatsApp

WhatsApp Web authentication is generated locally on first login. The `.wwebjs_auth/`, cache, contact profile, owner memory, and inbox files are ignored and must never be copied into a public repository.

## Runtime data

SQLite databases, generated audio, uploads, logs, screenshots, and tool artifacts belong in ignored runtime directories. Use `.env.example` files only as schemas; real `.env` values remain local.
