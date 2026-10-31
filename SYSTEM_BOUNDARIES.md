# Public Edition Boundaries

The public edition keeps components independently deployable. Each component owns its environment, dependencies, and startup process.

## Core ownership

`lily_essence_core` owns session state, provider routing, response generation, capability discovery, and client-facing APIs. Optional vessels perform capability-specific work and should not become secondary AI brains.

## Included vessels

- `lily_wa_vessel`: WhatsApp transport and delivery.
- `lily_voice_vessel`: GPT-SoVITS request adaptation.
- `lily_tool_vessel`: external agent execution behind explicit authorization.
- `lily_model_vessel`: Live2D registry, validation, and frontend assignment.
- `lily_home_vessel`: local smart-home actions.
- `lily_stt_vessel`: speech-to-text transcription.

## Included clients

- `lily_control_center`: system visibility and configuration.
- `lily_private_realm`: desktop companion chat and character presentation.
- `lily_mobile_realm_android`: native Android owner client.
- `iris_launcher`: optional local Windows setup and service dashboard.

## Omitted private and streaming modules

The File Vessel, Finance Vessel, desktop HUD, and streaming suite are not distributed in this edition. Core/client adapter hooks may remain for compatibility, but omitted modules must be treated as unavailable unless a developer supplies a separate compatible implementation.

## Asset boundary

Live2D Cubism SDK files, character models, voice models, generated media, credentials, and runtime data are always local-only. Public source must contain placeholders and restoration instructions instead of redistributing those assets.
