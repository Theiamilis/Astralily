# Cubism Local Setup

This note is for local Android setup only. Do not commit the official Cubism SDK or private Lily model assets into git.

## What belongs where

### Inside this repo

Put Lily's model files here:

```text
C:\path\to\LilyConstellation\lily_mobile_realm_android\app\src\main\assets\live2d\current\
```

The app scans that folder for the first `*.model3.json` file.

Current expected shape is fine, for example:

```text
current/
  jiraikei_dlc/
    jiraikei.model3.json
    ...
```

During build, the app copies that model into a generated alias folder named after the model json file, so:

- source folder: `jiraikei_dlc/`
- detected model name: `jiraikei`
- generated runtime folder: `jiraikei/`

That lets the official sample loader open:

```text
jiraikei/jiraikei.model3.json
```

without forcing you to rename your original private model folder.

### Outside this repo

Keep the official Java SDK clone here or in another local-only path:

```text
C:\AI\CubismSdkForJava-5-r.5
```

The one file that still blocks full native rendering is:

```text
C:\AI\CubismSdkForJava-5-r.5\Core\android\Live2DCubismCore.aar
```

If that file is missing, the Android app stays in placeholder stage mode on purpose.

Legacy sample-repo layout is still supported too:

```text
C:\AI\Live2D\CubismJavaSamples
```

The app mirrors the framework into:

```text
lily_mobile_realm_android/.gradle/cubismSdkMirror/
```

This mirror is local build output. It exists so the Android project can normalize a couple of framework build quirks without modifying your downloaded SDK folder directly.

## Detection order

The Android Gradle project looks for the Cubism SDK path in this order:

1. Gradle property `lily.cubism.sdk.dir`
2. environment variable `LILY_CUBISM_SDK_DIR`
3. first existing default:
   - `C:\AI\CubismSdkForJava-5-r.5`
   - `C:\AI\Live2D\CubismJavaSamples`

You only need to set one of them if your SDK folder lives somewhere else.

## JDK requirement

This Android module needs JDK 17 or newer for Gradle.

If terminal builds fail because Java 8 is active, Android Studio can still build correctly as long as its Gradle JDK points to the bundled JBR or another JDK 17+ install.

## Optional local.properties example

If you want to override the default path in Android Studio, add this local-only entry:

```text
lily.cubism.sdk.dir=C:\\AI\\CubismSdkForJava-5-r.5
```

Keep that in `local.properties`, not in tracked files.

## Current auto behavior

- If the model exists but `Live2DCubismCore.aar` is missing:
  - app builds
  - stage stays placeholder
  - stage hint explains what is missing
- If the model exists and the AAR exists:
  - build includes the official framework module
  - build includes native Cubism bridge sources
  - build mirrors the framework locally under `.gradle/cubismSdkMirror/`
  - stage can switch to the native renderer automatically

## Current limitations

- This first native pass assumes one active Lily model folder.
- If the model has no motions, the build now guards idle motion calls so it does not crash just because idle files are absent.
- Expression and lip-sync hooks are prepared, but the final tuning still depends on the real model behavior once the core AAR is present.
