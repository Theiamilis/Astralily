# Lily Model Vessel

Lightweight Live2D model registry for LilyConstellation. It owns local model assets, validates uploaded ZIP archives, discovers expressions, stores semantic mappings and per-vessel assignments, and serves model files to browser frontends.

## Run

```bat
setup.bat
start.bat
```

Linux uses `setup_linux.sh` and `start_linux.sh`. The default API is `http://127.0.0.1:10898`; model files live under the ignored `local_assets/live2d_models/` directory.

Mutating endpoints accept `Authorization: Bearer <token>` or `X-Lily-Model-Token`. Leaving `LILY_MODEL_VESSEL_TOKEN` blank is intended only for a trusted local network.
