# Lily Realm for Android

`lily_mobile_realm_android/` is the native Android **Lily Realm** owner companion.

This module is intentionally separate from the web frontends:

- UI: Kotlin + Jetpack Compose
- Native stage host: Android `GLSurfaceView` through `AndroidView`
- Core route: `POST /api/core/ingest` with `source=mobile_realm`
- Tool flow: reads pending approvals from Core; completed Hermes/OpenClaw artifacts are delivered by the personal WA Vessel

## Current Scope (0.3.16)

System bars stay transparent and use the saved app theme on cold launch, including when AndroidX SplashScreen finishes restoring its XML theme. Theme changes during splash dismissal retain the latest icon appearance. See [system-bar regression validation](../docs/ANDROID_SYSTEM_BARS.md).

Settings now stores a private Tailscale/LAN URL, an HTTPS Tunnel URL (default `https://example.com`), and Auto / Tailscale-LAN / Tunnel mode. Existing Core URLs migrate to the private address. The same application connection manager serves UI, SSE and notifications; background worker runs pin one selected route. Auto probes owner presence, prefers private reachability, and refreshes its 30-second cache in the foreground loop. It does not launch a VPN.

Requests pin their route until completion. Only GET may restart once on the alternative after network failure. Chat, approvals, finance and other mutations never replay automatically; HTTP/auth/validation/rate/TLS errors never cause fallback. SSE reconnects with its event cursor. Internal audio resolves the selected Core route when playback starts and retains the signed URL query. Token storage, conversations and delivery identity remain unchanged when switching routes.

The public owner route is a dedicated loopback gateway and Cloudflare Tunnel, separate from Family device ingress. See [Owner Tunnel deployment](../deploy/cloudflare-owner/README.md) and [rollout status](../docs/OWNER_TUNNEL_STATUS.md).

Conversation mode is available under **Lily → Conversation mode → Japanese / English**.
Choose Casual or Expressive, then return to Chat and type or use the microphone.
Replies stay in the practice language; suggested corrections appear below the reply.
Tap **Notes** for Indonesian explanations and translations, plus romaji for Japanese.
Only the conversational reply is synthesized, using the selected voice engine and the
existing voice profile for the practice language. Voice Off still skips synthesis.
Feedback evaluates the transcript, not the original pronunciation.

Practice uses separate English/Japanese sessions and local history caches. It never
dispatches device commands, tools, or owner mood controls, including sentences that
look like commands. **End** restores normal chat and its language settings. The app
starts in normal chat after a cold restart; practice histories remain available.
Core must also be updated to support the new `language_practice` ingest mode.

Pending replies use request-scoped Core events: `Connecting…` until Core
acknowledges processing, `Thinking…` while preparing the response, and
`Synthesizing voice…` when TTS begins. Reply text is delivered as a whole.
Progress events are matched by trace and session IDs; stale or unrelated events
are ignored. If the event connection is unavailable, stage updates may not arrive.

V1 focuses on owner use over Tailscale or LAN:

- owner chat
- audio playback with amplitude-driven Live2D lip-sync
- voice reply on/off toggle
- mic input through Core's `lily_stt_vessel` proxy
- Home controls from Chat and `Tasks | Home` without exposing Home Vessel credentials
- Finance balances, transactions, drafts, receipts, and confirmation inside `Tasks | Finance`
- manual owner presence
- Japanese voice picker (`Neptune`, `Kokomi`) plus an English voice picker (`zeta_en`, `watson_en`)
- pending tool approve/deny
- owner-safe Hermes/OpenClaw result delivery to WhatsApp after mobile approval
- five owner tabs: `Chat`, `Tasks`, `Wardrobe`, `Lily`, and `Settings`
- confirmation-gated per-device chat history clearing in `Settings`
- native approval notifications with battery-aware background checks
- encrypted owner token, local recent-chat cache, and optional biometric app lock
- two local-only Live2D outfits: `Jirai Kei` and `Purple Maid`
- editable character display name, persisted on-device and forwarded to Core as `character_name`

The app stays local-first. Background notifications poll the owner's configured Main Core over LAN or Tailscale; no cloud push provider is required.
Fresh debug installs default to `http://lily-core-host:8000`, matching the canonical always-on host in `config/topology.json`; the URL remains editable in Settings. Debug builds permit HTTP for local development. Release builds require HTTPS; configure a TLS endpoint before distributing an owner APK. Tailscale encryption alone does not turn an `http://` URL into app-level HTTPS.

Android uses the Core owner API token directly. Device registration and pairing are not required.

## Current UI Shape

Lily Realm is tuned as a native full-stage companion, not a normal chat app:

- `Chat` is a layered stage scene. Lily is the base visual layer, then HUD, chat bubbles, language controls, composer, and navigation float above it.
- `Tasks` has a `Tasks | Home | Finance` segmented view for approvals, devices/scenes, and the private ledger.
- `Wardrobe` switches the two bundled local outfits and keeps their expression mapping stable.
- The character tab uses the saved character name and owns identity, language, mood, voice, owner presence, and stage follow.
- `Settings` is technical only: Core URL, Tailscale/LAN connection, refresh/debug/runtime app preferences.

Do not re-add `Discover`, `Music`, or `More` unless the product direction changes. The current bottom navigation is intentionally locked to five tabs so the app does not mix character preferences with technical settings.

The active visual tokens are:

```text
primary pink: #FF4FA3
voice purple: #6C5CE7
online green: #22C55E
dark text: #111827
blush background: #FCE7F3
```

Keep status pills high contrast: online core is green, online voice is purple, available presence is pink, and offline states are muted but readable.

## Live2D / Cubism

This module is prepared for the official Cubism SDK for Java, but the SDK and model assets remain local/manual.

Important: the **model assets** and the **Cubism SDK for Java** are two different things.

- Model assets are Lily's `.model3.json`, `.moc3`, textures, motions, expressions, and physics files.
- The Cubism SDK for Java is the Android-side rendering/runtime layer that can actually load and draw those model files.

Only the model files belong inside this app's assets folder.

Expected local model library:

```text
C:\path\to\LilyConstellation\local_assets\live2d_models\jiraikei-dlc\
C:\path\to\LilyConstellation\local_assets\live2d_models\lily-maid-pink\
```

These licensed assets are copied into the APK at build time and remain ignored by Git. `app/src/main/assets/live2d/current/` is retained only as a one-model fallback for another machine.

Recommended local SDK location outside git:

```text
C:\AI\CubismSdkForJava-5-r.5
```

Right now the app can run in two visual modes:

- UI tuning mode: a local Lily mock PNG is drawn in Compose so layout can be adjusted without Android `SurfaceView` z-order problems.
- Native Cubism mode: the real SDK path is prepared, but it should only be enabled after the local SDK, AAR, and model assets are verified on device.

The black/white rectangle problem is usually a native surface clear/z-order issue. Fix that in the stage host or clear color path; do not hide it by adding a new card behind Lily.

### Prepare Cubism SDK for Java

1. Put the official Cubism SDK for Java somewhere outside git. Your current local path is fine:

```text
C:\AI\CubismSdkForJava-5-r.5
```

If you prefer the sample-repo route instead, this older layout is also supported:

```text
git clone --recursive https://github.com/Live2D/CubismJavaSamples.git C:\AI\Live2D\CubismJavaSamples
```

2. Make sure the Core AAR exists:

```text
C:\AI\CubismSdkForJava-5-r.5\Core\android\Live2DCubismCore.aar
```

After that, the important local pieces should exist:

- `C:\AI\CubismSdkForJava-5-r.5\Framework\...`
- `C:\AI\CubismSdkForJava-5-r.5\Core\android\Live2DCubismCore.aar`

3. Keep that SDK folder local/manual. Do not commit it into this repo.

This Android module now auto-detects the local SDK in either of these ways:

- Gradle property `lily.cubism.sdk.dir`
- environment variable `LILY_CUBISM_SDK_DIR`
- fallback default paths:
  - `C:\AI\CubismSdkForJava-5-r.5`
  - `C:\AI\Live2D\CubismJavaSamples`

Once `Framework/` and `Core/android/Live2DCubismCore.aar` both exist there, the app build can switch from the placeholder stage to the native Cubism stage automatically.

During build, the Android module creates a local mirror of the framework under `.gradle/cubismSdkMirror/` so the project can compile against the official SDK without asking you to edit the external SDK folder by hand.

Extra setup notes:

- [CUBISM_LOCAL_SETUP.md](CUBISM_LOCAL_SETUP.md)
- [ANDROID_AGENT_HANDOFF.md](ANDROID_AGENT_HANDOFF.md)

## Open In Android Studio

Open this folder directly in Android Studio:

```text
C:\path\to\LilyConstellation\lily_mobile_realm_android
```

Recommended first run:

1. Let Android Studio sync the Gradle project.
2. Make sure Gradle uses JDK 17 or later. Android Studio's bundled JBR is fine.
3. Set the Core URL in the app to your Tailscale or LAN address.
4. Restore the two local Lily model folders listed above.
5. Prepare the local Cubism SDK for Java separately using the steps above.
6. If the app still shows the placeholder stage, check the build hint text and the docs above. In most cases the missing piece is `Live2DCubismCore.aar`.

### Compose Preview

Android Studio may show "No preview found" for the main file. That is expected for now because the real screen includes runtime state, AndroidView/OpenGL stage hosting, audio playback, and device-specific assets.

Use these checks instead:

```bat
cd C:\path\to\LilyConstellation
python -m tests.clients.test_mobile_realm_contract
```

```bat
cd C:\path\to\LilyConstellation\lily_mobile_realm_android
.\gradlew.bat :app:assembleDebug
```

With the Core reachable over Tailscale or LAN, the live emulator smoke test can install the debug APK, write the Core URL into app settings, verify the status HUD, send one chat message, and optionally trigger a mobile OpenClaw request:

```bat
cd C:\path\to\LilyConstellation
python scripts\test_mobile_emulator.py --core-url http://127.0.0.1:8000 --tool-task
```

By default this uses a debug-only app intent for stable message injection, then verifies the visible app UI. Add `--input-mode ui` when you specifically want to exercise the emulator soft keyboard.

Add `--require-tool-success` only when the remote Tool vessel has a working Hermes/OpenClaw executable and the test should fail on provider execution errors.

If the terminal build picks Java 8, use Android Studio's bundled JBR or set it in the shell first:

```powershell
$env:JAVA_HOME="D:\AndroidStudio\jbr"
$env:Path="$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat :app:assembleDebug
```

## Runtime Notes

- **Tasks → Inbox** shows personal WhatsApp summaries, original messages and Lily replies, category corrections, handled state, and chat reminders. Notification destinations and schedules are configured in Launcher → Secretary. See [Inbox and device updates](../docs/INBOX_AND_DEVICE_UPDATES.md) for delivery timing, authentication, and rollout limits.

- Current debug build identity is `versionName 0.3.14` / `versionCode 28`. Install the updated APK over the existing debug app to preserve its settings.
- Settings offers lily-core-host STT (default) or Android speech recognition, using the phone's configured recognition service, which may be Google. Android recognition may require network access and installed language support; Core is still needed to answer.
- Spoken language can follow chat or use Indonesian, English, or Japanese independently. Final recognition results are sent once directly to Core without changing the typed draft. Partial results are never sent. Leaving Chat or backgrounding the app cancels unfinished recognition; errors require an explicit retry.
- The debug app allows cleartext HTTP for private LAN/Tailscale development. The release app rejects cleartext and needs an HTTPS Core endpoint before installation.
- Settings such as Core URL, active language, Japanese/English voice choice, mood, follow toggle, and local device/session target are stored on-device. Tool recipients are never stored in the APK: Core normalizes Mobile Realm tool delivery to the symbolic personal WhatsApp owner target. The owner API token is stored separately with an Android Keystore-backed AES/GCM key.
- Clear chat history resets only the current Lily Realm device session and local chat cache. Durable owner memory and other interfaces are not removed.
- The Lily tab includes a voice reply toggle. When it is off, Mobile Realm sends `want_voice=false` so Core can skip audio generation for that chat reply.
- Voice playback drives the active model's mouth from the MediaPlayer waveform. Android requires microphone permission for playback visualization; unsupported or denied devices use a lightweight speech envelope instead.
- Mic input records a short local `.m4a`, uploads it to Core's `/api/stt/transcribe` endpoint, then submits the transcript through the normal Mobile Realm chat path. The app only needs the Core URL and owner token.
- Home, Voice, Finance, Tool, and health updates use Core's typed SSE stream with 15-second polling as a reconnect fallback.
- The Chat tab is now a full-stage layered scene: Lily fills the viewport first, then the top HUD, floating chat bubbles, and bottom controls render above the stage.
- Chat includes a local-only stage control tray with show/hide behavior for zoom and wide Lily repositioning; it only affects Android rendering and persists on-device. Vertical travel extends beyond the previous framing limits for close-up models. Up/down buttons follow screen direction, while stored offsets retain OpenGL's up-positive convention. Preferences and the Cubism renderer share `ModelPositionLimits` so saved framing is not clipped by a second, narrower limit.
- `Set as default` stores the current framing on-device. `Reset` restores that owner-selected framing instead of forcing the factory position.
- Chat uses the selected Android keyboard, including its supported voice typing, suggestions, clipboard, and text selection. The composer stays above the IME and Send works from either the keyboard or the app. Voice typing availability is controlled by the installed keyboard. The separate Lily microphone button continues to use Lily STT.
- The mood rail should stay compact and hideable. It is a character action rail, not a permanent left navigation menu.
- Stop voice should only be prominent while Lily is speaking or while playback cleanup matters.
- Japanese defaults to Neptune, with pitch-corrected Kokomi (`kokomi_ja`) as an alternate profile.
- English defaults to `zeta_en`, with `watson_en` as the alternate selectable profile.
