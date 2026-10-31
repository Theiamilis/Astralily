import org.gradle.api.tasks.Sync
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun String.asBuildConfigString(): String = "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

fun firstExistingCubismSdkPath(candidates: List<String>): String? =
    candidates
        .map(::File)
        .firstOrNull { candidate ->
            candidate.resolve("Framework/framework").exists() &&
                candidate.resolve("Core/android/Live2DCubismCore.aar").exists()
        }
        ?.absolutePath

val cubismSdkDirPath = providers.gradleProperty("lily.cubism.sdk.dir").orNull
    ?: System.getenv("LILY_CUBISM_SDK_DIR")
    ?: firstExistingCubismSdkPath(
        listOf(
            "C:/AI/CubismSdkForJava-5-r.5",
            "C:/AI/Live2D/CubismJavaSamples",
        ),
    )
    ?: "C:/AI/CubismSdkForJava-5-r.5"
val cubismSdkDir = File(cubismSdkDirPath)
val cubismFrameworkDir = cubismSdkDir.resolve("Framework/framework")
val cubismCoreAar = cubismSdkDir.resolve("Core/android/Live2DCubismCore.aar")
val cubismSampleMainJavaDir = cubismSdkDir.resolve("Sample/src/main/java")
val cubismSampleMinimumJavaDir = cubismSdkDir.resolve("Sample/src/minimum/java")
val cubismSampleAssetsDir = cubismSdkDir.resolve("Sample/src/main/assets")

val currentLive2dAssetsDir = project.layout.projectDirectory.dir("src/main/assets/live2d/current").asFile
val detectedModelJson = if (currentLive2dAssetsDir.exists()) {
    currentLive2dAssetsDir
        .walkTopDown()
        .firstOrNull { it.isFile && it.name.endsWith(".model3.json") }
} else {
    null
}
val detectedModelName = detectedModelJson?.name?.removeSuffix(".model3.json").orEmpty()
val detectedModelSourceDir = detectedModelJson?.parentFile
val localModelLibrary = rootProject.projectDir.parentFile.resolve("local_assets/live2d_models")
val jiraiModelJson = localModelLibrary.resolve("jiraikei-dlc/jiraikei.model3.json")
    .takeIf { it.exists() }
    ?: detectedModelJson
val maidModelJson = localModelLibrary.resolve("lily-maid-pink/女仆ver粉.model3.json")
    .takeIf { it.exists() }
val bundledModels = listOfNotNull(
    jiraiModelJson?.let { Triple("lily_jirai_kei", "Jirai Kei", it) },
    maidModelJson?.let { Triple("lily_maid_pink", "Purple Maid", it) },
)
val hasLocalModel = bundledModels.isNotEmpty()
val cubismReady = cubismFrameworkDir.exists() && cubismCoreAar.exists()
val nativeStageReady = cubismReady && hasLocalModel
val defaultModelName = bundledModels.firstOrNull()?.first.orEmpty()
val bundledModelIds = bundledModels.joinToString(",") { it.first }

val cubismStatusHint = when {
    !hasLocalModel -> "No local Lily model was found in local_assets/live2d_models or the current fallback folder."
    !cubismFrameworkDir.exists() -> "Cubism Java Framework is missing under ${cubismFrameworkDir.absolutePath}."
    !cubismCoreAar.exists() -> "Live2DCubismCore.aar is missing under ${cubismCoreAar.absolutePath}."
    else -> "Cubism native stage is ready with ${bundledModels.size} bundled Lily model(s)."
}

val generatedCubismAssetsDir = layout.buildDirectory.dir("generated/lily/cubismAssets")
val generatedCubismSourcesDir = layout.buildDirectory.dir("generated/lily/cubismSources")

val prepareLilyCubismAssets = tasks.register<Sync>("prepareLilyCubismAssets") {
    into(generatedCubismAssetsDir)

    if (cubismSampleAssetsDir.exists()) {
        from(cubismSampleAssetsDir)
    }

    bundledModels.forEach { (modelId, _, modelJson) ->
        from(modelJson.parentFile) {
            into(modelId)
            exclude("**/*.baiduyun.uploading.cfg", "**/*.cfg", "**/*.zip")
            rename { fileName ->
                if (fileName == modelJson.name) "$modelId.model3.json" else fileName
            }
        }
    }

    doLast {
        val maidJson = generatedCubismAssetsDir.get().asFile.resolve("lily_maid_pink/lily_maid_pink.model3.json")
        if (maidJson.exists()) {
            val original = maidJson.readText()
            val normalized = original
                .replace("\"Name\": \"Mhonglian\"", "\"Name\": \"Blush\"")
                .replace("\"Name\": \"Mshengqi\"", "\"Name\": \"Angry\"")
                .replace("\"Name\": \"Mlove\"", "\"Name\": \"Love\"")
                .replace("\"Name\": \"M QAQ\"", "\"Name\": \"Sad\"")
            if (original != normalized) maidJson.writeText(normalized)
        }
    }
}

val prepareCubismSampleSources = tasks.register("prepareCubismSampleSources") {
    onlyIf { cubismReady && cubismSampleMainJavaDir.exists() && cubismSampleMinimumJavaDir.exists() }
    outputs.dir(generatedCubismSourcesDir)

    doLast {
        val outputDir = generatedCubismSourcesDir.get().asFile
        delete(outputDir)
        outputDir.mkdirs()

        // Copy main sources (proper structure)
        copy {
            from(cubismSampleMainJavaDir)
            into(outputDir)
        }

        // Copy minimum sources (flat dot-folder structure -> proper structure)
        val minSourceDir = cubismSampleMinimumJavaDir.resolve("com.live2d.demo.minimum")
        if (minSourceDir.exists()) {
            copy {
                from(minSourceDir)
                into(outputDir.resolve("com/live2d/demo/minimum"))
            }
        } else {
            copy {
                from(cubismSampleMinimumJavaDir)
                into(outputDir)
            }
        }

        fun patchFile(relativePath: String, transform: (String) -> String) {
            val file = outputDir.resolve(relativePath)
            if (!file.exists()) return
            val original = file.readText()
            val updated = transform(original)
            if (original != updated) {
                file.writeText(updated)
            }
        }

        // 1. Patch Manager for safe singleton and lazy model loading
        patchFile("com/live2d/demo/minimum/LAppMinimumLive2DManager.java") { text ->
            text.replace(
                "loadModel(\"Hiyori\");",
                ""
            ).replace(
                "import com.live2d.sdk.cubism.framework.math.CubismMatrix44;",
                """import android.util.Log;

import com.live2d.sdk.cubism.framework.math.CubismMatrix44;"""
            ).replace(
                """    public void loadModel(String modelDirectoryName) {
        String dir = modelDirectoryName + "/";
        model = new LAppMinimumModel(dir);
        model.loadAssets(dir, modelDirectoryName + ".model3.json");
    }""",
                """    public void loadModel(String modelDirectoryName) {
        String dir = modelDirectoryName + "/";
        try {
            Log.i(TAG, "Loading Cubism model: " + dir + modelDirectoryName + ".model3.json");
            if (model != null) {
                model.deleteModel();
            }
            model = new LAppMinimumModel(dir);
            model.loadAssets(dir, modelDirectoryName + ".model3.json");
            hasLoggedMissingModel = false;
            if (model.getModel() == null) {
                Log.e(TAG, "Cubism model loaded without runtime model: " + modelDirectoryName);
            } else {
                Log.i(
                    TAG,
                    "Cubism model loaded: " + modelDirectoryName
                        + " canvas=" + model.getModel().getCanvasWidth() + "x" + model.getModel().getCanvasHeight()
                        + " drawables=" + model.getModel().getDrawableCount()
                        + " opacity=" + model.getModel().getModelOpacity()
                );
            }
        } catch (Throwable throwable) {
            Log.e(TAG, "Failed to load Cubism model: " + modelDirectoryName, throwable);
            model = null;
        }
    }"""
            ).replace(
                "    public void onUpdate() {",
                """    public void onUpdate() {
        if (model == null || model.getModel() == null) {
            if (!hasLoggedMissingModel) {
                Log.w(TAG, "Skipping Cubism draw because no model is loaded yet.");
                hasLoggedMissingModel = true;
            }
            return;
        }"""
            ).replace(
                "public void setRenderTargetSize(int width, int height) {",
                """public void setExpression(String expressionName) {
        if (model != null && expressionName != null && !expressionName.isEmpty()) {
            if ("Neutral".equalsIgnoreCase(expressionName) || "Clear".equalsIgnoreCase(expressionName)) {
                model.clearExpression();
            } else {
                model.setExpression(expressionName);
            }
        }
    }

    public void setLipSyncValue(float value) {
        if (model != null) {
            model.setManualLipSyncValue(value);
        }
    }

    public void setWind(float x, float y) {
        if (model != null) {
            model.setWind(x, y);
        }
    }

    public void setTouchWind(float x, float y) {
        if (model != null) {
            model.setTouchWind(x, y);
        }
    }

    public void setPocketRealmModelTransform(float scale, float offsetX, float offsetY) {
        pocketRealmModelScale = Math.max(0.50f, Math.min(2.30f, scale));
        pocketRealmModelOffsetX = Math.max(-0.50f, Math.min(0.50f, offsetX));
        pocketRealmModelOffsetY = Math.max(
            com.lilyconstellation.mobile.live2d.ModelPositionLimits.MIN_RENDER_OFFSET_Y,
            Math.min(com.lilyconstellation.mobile.live2d.ModelPositionLimits.MAX_RENDER_OFFSET_Y, offsetY));
    }

    public void setRenderTargetSize(int width, int height) {"""
            ).replace(
                """        float aspectRatio = (float) width / (float) height;
        float displayRatio = (float) height / (float) width;""",
                """        if (!hasLoggedFirstDraw) {
            Log.i(TAG, "Drawing Cubism model frame at " + width + "x" + height);
            hasLoggedFirstDraw = true;
        }
        float aspectRatio = (float) width / (float) height;
        float displayRatio = (float) height / (float) width;"""
            ).replace(
                "        LAppMinimumDelegate.getInstance().getView().preModelDraw(model);",
                """        projection.scaleRelative(pocketRealmModelScale, pocketRealmModelScale);
        projection.translateRelative(pocketRealmModelOffsetX, pocketRealmModelOffsetY);

        LAppMinimumDelegate.getInstance().getView().preModelDraw(model);"""
            ).replace(
                "        model.update();",
                """        model.update();
        if (!hasLoggedDrawableState) {
            int visibleDrawables = 0;
            int nonTransparentDrawables = 0;
            int drawableVertices = 0;
            for (int drawableIndex = 0; drawableIndex < model.getModel().getDrawableCount(); drawableIndex++) {
                if (model.getModel().getDrawableDynamicFlagIsVisible(drawableIndex)) {
                    visibleDrawables++;
                }
                if (model.getModel().getDrawableOpacity(drawableIndex) > 0.001f) {
                    nonTransparentDrawables++;
                }
                drawableVertices += model.getModel().getDrawableVertexCount(drawableIndex);
            }
            Log.i(
                TAG,
                "Cubism drawable state visible=" + visibleDrawables
                    + " opaque=" + nonTransparentDrawables
                    + " vertices=" + drawableVertices
            );
            hasLoggedDrawableState = true;
        }"""
            ).replace(
                "        model.draw(projection);",
                """        model.draw(projection);
        if (!hasLoggedFirstGlResult) {
            int glError = android.opengl.GLES20.glGetError();
            Log.i(TAG, "First Cubism draw GL result=" + glError);
            hasLoggedFirstGlResult = true;
        }"""
            ).replace(
                "    private LAppMinimumModel model;",
                """    private static final String TAG = "LilyCubismStage";
    private boolean hasLoggedMissingModel = false;
    private boolean hasLoggedFirstDraw = false;
    private boolean hasLoggedFirstGlResult = false;
    private boolean hasLoggedDrawableState = false;

    private LAppMinimumModel model;

    private float pocketRealmModelScale = 0.86f;
    private float pocketRealmModelOffsetX = 0.0f;
    private float pocketRealmModelOffsetY = 0.0f;"""
            )
        }

        // 1b. Keep animation timing stable when Android misses a frame.
        // The sample's raw delta time turns a brief render stall into a visible
        // jump in CubismTargetPoint and breathing motion.
        patchFile("com/live2d/demo/minimum/LAppMinimumPal.java") { text ->
            text.replace(
                """    public static void updateTime() {
        s_currentFrame = getSystemNanoTime();
        deltaNanoTime = s_currentFrame - lastNanoTime;
        lastNanoTime = s_currentFrame;
    }""",
                """    public static void updateTime() {
        s_currentFrame = getSystemNanoTime();
        if (lastNanoTime == 0.0) {
            lastNanoTime = s_currentFrame;
            deltaNanoTime = 1000000000.0 / 60.0;
            return;
        }
        deltaNanoTime = Math.max(
            0.0,
            Math.min(s_currentFrame - lastNanoTime, MAX_DELTA_NANO_TIME)
        );
        lastNanoTime = s_currentFrame;
    }"""
            ).replace(
                "    private static final String TAG = \"[APP]\";",
                """    private static final double MAX_DELTA_NANO_TIME = 1000000000.0 / 30.0;
    private static final String TAG = "[APP]";"""
            )
        }

        // 2. Patch Delegate for Lily's stage background and initialization
        patchFile("com/live2d/demo/minimum/LAppMinimumDelegate.java") { text ->
            text.replace(
                "import android.opengl.GLES20;",
                """import android.opengl.GLES20;
import android.util.Log;"""
            ).replace(
                "    public void onSurfaceCreated() {",
                """    public void setInitialModelName(String modelName) {
        if (modelName != null && !modelName.isEmpty()) {
            initialModelName = modelName;
        }
    }

    public void setStageDarkMode(boolean darkMode) {
        stageClearRed = darkMode ? 0.16f : 0.9686f;
        stageClearGreen = darkMode ? 0.10f : 0.7882f;
        stageClearBlue = darkMode ? 0.14f : 0.8627f;
    }

    public void onSurfaceCreated() {"""
            ).replace(
                """        LAppMinimumLive2DManager live2DManager = LAppMinimumLive2DManager.getInstance();
        live2DManager.getModel(0).reloadRenderer();""",
                """        LAppMinimumLive2DManager live2DManager = LAppMinimumLive2DManager.getInstance();
        if (live2DManager.getModel(0) == null) {
            Log.i("LilyCubismStage", "Requesting initial Cubism model: " + initialModelName);
            live2DManager.loadModel(initialModelName);
        } else {
            Log.i("LilyCubismStage", "Reloading existing Cubism renderer.");
            live2DManager.getModel(0).reloadRenderer();
        }"""
            ).replace(
                "    private int windowHeight;",
                """    private int windowHeight;
    private volatile float stageClearRed = 0.9686f;
    private volatile float stageClearGreen = 0.7882f;
    private volatile float stageClearBlue = 0.8627f;
    private String initialModelName = com.lilyconstellation.mobile.BuildConfig.CUBISM_MODEL_NAME.isEmpty()
        ? "Hiyori"
        : com.lilyconstellation.mobile.BuildConfig.CUBISM_MODEL_NAME;"""
            ).replace(
                "glClearColor(1.0f, 1.0f, 1.0f, 1.0f);",
                "glClearColor(stageClearRed, stageClearGreen, stageClearBlue, 1.0f);"
            ).replace(
                """        if (!isActive) {
            activity.finishAndRemoveTask();
        }""",
                """        // Pocket Realm embeds the Cubism renderer inside Compose.
        // The sample app normally closes its Activity here, but this stage must never dismiss the host app."""
            )
        }

        // 3. Patch Model for LipSync, Expressions, and Idle guards
        patchFile("com/live2d/demo/minimum/LAppMinimumModel.java") { text ->
            text.replace(
                "import com.live2d.sdk.cubism.framework.CubismFramework;",
                """import android.util.Log;

import com.live2d.sdk.cubism.framework.CubismFramework;"""
            ).replace(
                "import com.live2d.sdk.cubism.framework.effect.CubismLook;",
                """import com.live2d.sdk.cubism.framework.effect.CubismBreath;
import com.live2d.sdk.cubism.framework.effect.CubismEyeBlink;
import com.live2d.sdk.cubism.framework.effect.CubismLook;"""
            ).replace(
                "import com.live2d.sdk.cubism.framework.motion.CubismExpressionMotion;",
                """import com.live2d.sdk.cubism.framework.motion.CubismBreathUpdater;
import com.live2d.sdk.cubism.framework.motion.CubismExpressionMotion;"""
            ).replace(
                "import com.live2d.sdk.cubism.framework.motion.CubismExpressionUpdater;",
                """import com.live2d.sdk.cubism.framework.motion.CubismExpressionUpdater;
import com.live2d.sdk.cubism.framework.motion.CubismEyeBlinkUpdater;"""
            ).replace(
                "import com.live2d.sdk.cubism.framework.motion.IFinishedMotionCallback;",
                """import com.live2d.sdk.cubism.framework.motion.IFinishedMotionCallback;
import com.live2d.sdk.cubism.framework.motion.IBooleanSupplier;"""
            ).replace(
                """    public void loadAssets(final String dir, final String fileName) {
        modelHomeDirectory = dir;
        String filePath = modelHomeDirectory + fileName;

        // Setup model
        setupModel(filePath);

        // Setup renderer.
        CubismRenderer renderer = CubismRendererAndroid.create(
            LAppMinimumDelegate.getInstance().getWindowWidth(),
            LAppMinimumDelegate.getInstance().getWindowHeight()
        );
        setupRenderer(renderer);

        setupTextures();
    }""",
                """    public void loadAssets(final String dir, final String fileName) {
        modelHomeDirectory = dir;
        String filePath = modelHomeDirectory + fileName;
        Log.i("LilyCubismStage", "Loading model assets from " + filePath);

        // Setup model
        setupModel(filePath);
        if (getModel() == null) {
            Log.e("LilyCubismStage", "Model setup returned null runtime model for " + filePath);
            return;
        }

        // Setup renderer.
        CubismRenderer renderer = CubismRendererAndroid.create(
            LAppMinimumDelegate.getInstance().getWindowWidth(),
            LAppMinimumDelegate.getInstance().getWindowHeight()
        );
        setupRenderer(renderer);

        setupTextures();
        Log.i("LilyCubismStage", "Model assets ready from " + filePath);
    }"""
            ).replace(
                """        // Pose
        {""",
                """        // Natural eye blink keeps models alive even when no idle motion file is bundled.
        if (modelSetting.getEyeBlinkParameterCount() > 0) {
            eyeBlink = CubismEyeBlink.create(modelSetting);
            eyeBlink.setBlinkingInterval(4.2f);
            eyeBlink.setBlinkingSettings(0.09f, 0.045f, 0.13f);
            updateScheduler.addUpdatableList(new CubismEyeBlinkUpdater(new IBooleanSupplier() {
                @Override
                public boolean getAsBoolean() {
                    return motionUpdated;
                }
            }, eyeBlink));
        }

        // Noticeable but gentle breathing keeps the model alive when no idle motion
        // is bundled. The final parameter amplitude is peak * weight, so both
        // values need to be large enough to survive the SDK's blending step.
        breath = CubismBreath.create();
        List<CubismBreath.BreathParameterData> breathParameters =
            new ArrayList<CubismBreath.BreathParameterData>();
        breathParameters.add(new CubismBreath.BreathParameterData(idParamAngleX, 0.0f, 2.8f, 8.6f, 0.75f));
        breathParameters.add(new CubismBreath.BreathParameterData(idParamAngleY, 0.0f, 2.0f, 7.3f, 0.70f));
        breathParameters.add(new CubismBreath.BreathParameterData(idParamAngleZ, 0.0f, 2.4f, 9.4f, 0.70f));
        breathParameters.add(new CubismBreath.BreathParameterData(idParamBodyAngleX, 0.0f, 2.0f, 11.0f, 0.80f));
        breathParameters.add(new CubismBreath.BreathParameterData(
            CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParameterId.BREATH.getId()),
            0.5f,
            0.8f,
            4.2f,
            0.85f
        ));
        breath.setParameters(breathParameters);
        updateScheduler.addUpdatableList(new CubismBreathUpdater(breath));

        // Pose
        {"""
            ).replace(
                "        updateScheduler.sortUpdatableList();",
                """        eyeBlinkIds.clear();
        for (int i = 0; i < modelSetting.getEyeBlinkParameterCount(); i++) {
            eyeBlinkIds.add(modelSetting.getEyeBlinkParameterId(i));
        }
        lipSyncIds.clear();
        for (int i = 0; i < modelSetting.getLipSyncParameterCount(); i++) {
            lipSyncIds.add(modelSetting.getLipSyncParameterId(i));
        }

        updateScheduler.sortUpdatableList();"""
            ).replace(
                "if (fileName.equals(\"\")) {",
                "if (!fileName.equals(\"\")) {"
            ).replace(
                "if (motionManager.isFinished()) {",
                "if (motionManager.isFinished()) { if (modelSetting.getMotionCount(LAppDefine.MotionGroup.IDLE.getId()) > 0)"
            ).replace(
                """        if (model == null) {
            LAppMinimumDelegate.getInstance().getActivity().finish();
        }""",
                """        if (model == null) {
            Log.w("LilyCubismStage", "Skipping draw because Cubism model is null.");
            return;
        }"""
            ).replace(
                """            LAppMinimumDelegate.getInstance().getActivity().finish();""",
                """            Log.e("LilyCubismStage", "model3.json is not readable; keeping Pocket Realm open.");
            return false;"""
            ).replace(
                "updateScheduler.onLateUpdate(model, deltaTimeSeconds);",
                "updateScheduler.onLateUpdate(model, deltaTimeSeconds); applyManualLipSync();"
            ).replace(
                """            LAppMinimumTextureManager.TextureInfo texture =
                LAppMinimumDelegate.getInstance()
                    .getTextureManager()
                    .createTextureFromPngFile(texturePath);
            final int glTextureNumber = texture.id;""",
                """            LAppMinimumTextureManager.TextureInfo texture =
                LAppMinimumDelegate.getInstance()
                    .getTextureManager()
                    .createTextureFromPngFile(texturePath);
            if (texture == null) {
                Log.e("LilyCubismStage", "Skipping missing texture: " + texturePath);
                continue;
            }
            final int glTextureNumber = texture.id;
            Log.i(
                "LilyCubismStage",
                "Bound texture " + modelTextureNumber + " from " + texturePath
                    + " size=" + texture.width + "x" + texture.height
                    + " id=" + glTextureNumber
            );"""
            ).replace(
                "public void deleteModel() {",
                """public void setExpression(final String expressionID) {
        ACubismMotion motion = expressions.get(expressionID);
        if (motion != null) {
            expressionManager.startMotionPriority(motion, LAppDefine.Priority.FORCE.getPriority());
        }
    }

    public void clearExpression() {
        expressionManager.stopAllMotions();
    }

    public void setManualLipSyncValue(float value) {
        manualLipSyncValue = Math.max(0.0f, Math.min(1.0f, value));
    }

    public void setWind(float x, float y) {
        setWindForSettings(x, y, JIRAI_HAIR_WIND_SETTINGS);
    }

    public void setTouchWind(float x, float y) {
        setWindForSettings(x, y, JIRAI_TOUCH_WIND_SETTINGS);
    }

    private void setWindForSettings(float x, float y, int[] settings) {
        if (physics == null) {
            return;
        }
        if (!modelHomeDirectory.contains("lily_jirai_kei")) {
            // Only Jirai's physics map has been classified below. Keep
            // other bundled models on the framework's normal behavior.
            physics.setWindEnabledSettings(null);
            physics.getOptions().wind.set(x, y);
            return;
        }
        physics.setWindEnabledSettings(settings);
        physics.getOptions().wind.set(x, y);
    }

    public void deleteModel() {"""
            ).replace(
                "private boolean motionUpdated;",
                """private static final int[] JIRAI_HAIR_WIND_SETTINGS = new int[] {
        // Hair ties/twin tails and the pink back-hair rigs in jiraikei.physics3.
        29, 30, 31, 32, 33, 34, 47, 48, 49, 50
    };
    private static final int[] JIRAI_TOUCH_WIND_SETTINGS = new int[] {
        // The first five rigs are the two arm poses, the knife/cola poses,
        // and the heart pose. Keep those out so wind never opens her hands.
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
        36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50
    };
    private boolean motionUpdated;
    private float manualLipSyncValue;
    private CubismId fallbackLipSyncId;
    private boolean hasLoggedLipSyncFallback;

    private void applyManualLipSync() {
        if (lipSyncIds.isEmpty()) {
            if (fallbackLipSyncId == null) {
                fallbackLipSyncId = CubismFramework.getIdManager().getId("ParamMouthOpenY");
            }
            int parameterIndex = model.getParameterIndex(fallbackLipSyncId);
            if (parameterIndex < model.getParameterCount()) {
                model.addParameterValue(fallbackLipSyncId, manualLipSyncValue, 0.88f);
                if (!hasLoggedLipSyncFallback) {
                    Log.i("LilyCubismStage", "Using ParamMouthOpenY as the model lip-sync fallback.");
                    hasLoggedLipSyncFallback = true;
                }
            }
            return;
        }
        for (int i = 0; i < lipSyncIds.size(); i++) {
            model.addParameterValue(lipSyncIds.get(i), manualLipSyncValue, 0.88f);
        }
    }"""
            )
        }

        // 3b. Use the current touch position for drag-following. The sample
        // transforms the previous point before updating TouchManager, adding a
        // frame of latency to touch-driven model response.
        patchFile("com/live2d/demo/minimum/LAppMinimumView.java") { text ->
            text.replace(
                """    public void onTouchesMoved(float pointX, float pointY) {
        float viewX = transformViewX(touchManager.getLastX());
        float viewY = transformViewY(touchManager.getLastY());

        touchManager.touchesMoved(pointX, pointY);

        LAppMinimumLive2DManager.getInstance().onDrag(viewX, viewY);
    }""",
                """    public void onTouchesMoved(float pointX, float pointY) {
        touchManager.touchesMoved(pointX, pointY);

        float viewX = transformViewX(touchManager.getLastX());
        float viewY = transformViewY(touchManager.getLastY());
        LAppMinimumLive2DManager.getInstance().onDrag(viewX, viewY);
    }""",
            )
        }

        // 4. Patch Pal for safe stream closing
        patchFile("com/live2d/demo/minimum/LAppMinimumPal.java") { text ->
            text.replace(
                "import java.io.IOException;",
                """import java.io.IOException;
import android.util.Log;"""
            ).replace(
                """        } catch (IOException e) {
            e.printStackTrace();

            if (LAppDefine.DEBUG_LOG_ENABLE) {
                printLog("File open error.");
            }

            return new byte[0];
        }""",
                """        } catch (IOException e) {
            e.printStackTrace();
            Log.e("LilyCubismStage", "Asset file open error: " + path, e);

            if (LAppDefine.DEBUG_LOG_ENABLE) {
                printLog("File open error.");
            }

            return null;
        }"""
            ).replace(
                """        } finally {
            try {
                fileData.close();
            } catch (IOException e) {
                e.printStackTrace();

                if (LAppDefine.DEBUG_LOG_ENABLE) {
                    printLog("File open error.");
                }
            }
        }""",
                """        } finally {
            if (fileData != null) {
                try {
                    fileData.close();
                } catch (IOException e) {
                    e.printStackTrace();

                    if (LAppDefine.DEBUG_LOG_ENABLE) {
                        printLog("File open error.");
                    }
                }
            }
        }""",
            )
        }

        patchFile("com/live2d/demo/minimum/LAppMinimumTextureManager.java") { text ->
            text.replace(
                "import android.opengl.GLES20;",
                """import android.opengl.GLES20;
import android.util.Log;"""
            ).replace(
                """        } catch (IOException e) {
            e.printStackTrace();
        }
        
        // LAppDefineã§è¨­å®šã•ã‚ŒãŸä¹—ç®—æ¸ˆã¿ã‚¢ãƒ«ãƒ•ã‚¡ã®è¨­å®šã«å¾“ã£ã¦ç”»åƒã‚’èª­ã¿è¾¼ã‚€
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPremultiplied = LAppDefine.PREMULTIPLIED_ALPHA_ENABLE;
        Bitmap bitmap = BitmapFactory.decodeStream(stream, null, options);""",
                """        } catch (IOException e) {
            e.printStackTrace();
            Log.e("LilyCubismStage", "Texture asset open error: " + filePath, e);
        }

        // LAppDefineã§è¨­å®šã•ã‚ŒãŸä¹—ç®—æ¸ˆã¿ã‚¢ãƒ«ãƒ•ã‚¡ã®è¨­å®šã«å¾“ã£ã¦ç”»åƒã‚’èª­ã¿è¾¼ã‚€
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPremultiplied = LAppDefine.PREMULTIPLIED_ALPHA_ENABLE;
        Bitmap bitmap = BitmapFactory.decodeStream(stream, null, options);
        if (bitmap == null) {
            Log.e("LilyCubismStage", "Texture decode failed: " + filePath);
            return null;
        }"""
            )
        }

        // 5. Patch Renderer to keep the native surface on Lily's pink stage color.
        patchFile("com/live2d/demo/minimum/GLRendererMinimum.java") { text ->
            text.replace(
                "LAppMinimumDelegate.getInstance().run();",
                """android.opengl.GLES20.glClearColor(0.9686f, 0.7882f, 0.8627f, 1.0f);
        android.opengl.GLES20.glClear(android.opengl.GLES20.GL_COLOR_BUFFER_BIT | android.opengl.GLES20.GL_DEPTH_BUFFER_BIT);
        LAppMinimumDelegate.getInstance().run();"""
            )
        }
    }
}

android {
    namespace = "com.lilyconstellation.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lilyconstellation.mobile"
        minSdk = 29
        targetSdk = 34
        versionCode = 30
        versionName = "0.3.16"
        buildConfigField("boolean", "HAS_CUBISM_NATIVE", nativeStageReady.toString())
        buildConfigField("boolean", "HAS_LOCAL_LIVE2D_MODEL", hasLocalModel.toString())
        buildConfigField("String", "CUBISM_MODEL_NAME", defaultModelName.asBuildConfigString())
        buildConfigField("String", "BUNDLED_MODEL_IDS", bundledModelIds.asBuildConfigString())
        buildConfigField("String", "CUBISM_SDK_PATH", cubismSdkDir.absolutePath.asBuildConfigString())
        buildConfigField("String", "CUBISM_CORE_AAR_PATH", cubismCoreAar.absolutePath.asBuildConfigString())
        buildConfigField("String", "CUBISM_STATUS_HINT", cubismStatusHint.asBuildConfigString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(generatedCubismAssetsDir)

            if (cubismReady) {
                java.srcDir(generatedCubismSourcesDir)
                java.srcDir("src/cubism/java")
            }
        }
    }
}

tasks.named("preBuild") {
    dependsOn(prepareLilyCubismAssets)
    if (cubismReady) {
        dependsOn(prepareCubismSampleSources)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.material3:material3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.3")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    if (cubismReady) {
        implementation(project(":cubismFramework"))
        implementation(files(cubismCoreAar))
    }

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
