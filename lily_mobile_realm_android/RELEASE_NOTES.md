# Lily Realm Release Notes

## 0.2.9

- Added a visible tap-position cursor to the custom Chat composer.
- Custom keyboard input now inserts and deletes at the cursor or active selection.
- Increased language selector line boxes so `ID`, `EN`, and `JP` no longer clip.

## 0.2.8

- Split chat text language from voice language.
- Added Indonesian as a chat bubble language alongside English and Japanese.
- Added independent Japanese and English voice routing with automatic speech-only translation.
- Kept the displayed Lily reply unchanged when a different language is generated for TTS.

## 0.2.7

- Raised Lily's stage zoom ceiling from 180% to 250%.
- Doubled the saved horizontal and vertical repositioning range.

## 0.2.6

- Replaced the Android system IME in Chat with Lily Realm's own compact pink keyboard.
- Added letter, shift, number, symbol, punctuation, backspace, hide, and send controls.
- Reflowed the Live2D stage, conversation bubbles, composer, and navigation while the keyboard is visible.

## 0.2.5

- Raised Lily's stage zoom ceiling from 128% to 180%.
- Added a Set as default action for the current model scale and position.
- Changed Reset to restore the owner's saved framing instead of the factory framing.

## 0.2.4

- Added a confirmation-gated Clear chat history action in Settings.
- Clears both the on-device chat cache and this device's Core conversation events.
- Preserves Lily's long-term owner memory and every other channel session.

## 0.2.3

- Added amplitude-driven Live2D lip-sync for voice replies using the active MediaPlayer audio session.
- Added a safe speech-envelope fallback for devices that cannot expose playback waveform data.
- Mapped models with an empty LipSync group to their verified `ParamMouthOpenY` parameter.
- Reused the microphone permission for both voice input and Android playback visualization.

## 0.2.2

- Prioritized the bundled Live2D stage before extended Core synchronization during cold start.
- Removed duplicate startup refreshes and deferred Home, Finance, task, and history hydration.
- Debounced replayed Core events to prevent refresh bursts when reconnecting.
- Loaded the saved outfit directly instead of briefly loading the default model first.
- Coalesced repeated Live2D expression, lip-sync, and transform updates.

## 0.2.1

- Added Neptune and Kokomi choices for Japanese voice replies.
- Persisted the selected Japanese voice profile on-device.
- Routed `kokomi_ja` through Lily Core without changing the selected language.
- Applied a profile-specific `-0.5` semitone pitch correction to Kokomi while preserving its original speaking tempo.
- Kept Neptune as the default Japanese voice.

## 0.2.0

- Added native Live2D model switching for Jirai Kei and Maid Pink.
- Reworked Wardrobe into a fitting-room model preview.
- Improved Core reconnect status, owner controls, and local app security.
