import java.io.File

fun firstExistingCubismSdkPath(candidates: List<String>): String? =
    candidates
        .map(::File)
        .firstOrNull { candidate ->
            candidate.resolve("Framework/framework").exists() &&
                candidate.resolve("Core/android/Live2DCubismCore.aar").exists()
        }
        ?.absolutePath

fun syncDirectory(source: File, target: File) {
    if (!source.exists()) return

    source.walkTopDown().forEach { item ->
        val relativePath = item.relativeTo(source).path
        val destination = if (relativePath.isEmpty()) target else target.resolve(relativePath)
        if (item.isDirectory) {
            destination.mkdirs()
        } else {
            destination.parentFile.mkdirs()
            if (!destination.exists() ||
                destination.length() != item.length() ||
                destination.lastModified() != item.lastModified()
            ) {
                item.copyTo(destination, overwrite = true)
            }
        }
    }
}

fun patchFrameworkBuildFile(buildFile: File) {
    if (!buildFile.exists()) return
    val original = buildFile.readText()
    val withoutToolchain = original.replace(
        Regex(
            """\njava\s*\{\s*toolchain\s*\{\s*languageVersion\s*=\s*JavaLanguageVersion\.of\(17\)\s*\}\s*\}\s*\n""",
            setOf(RegexOption.MULTILINE),
        ),
        "\n",
    )
    val updated = withoutToolchain
        .replace("JavaVersion.VERSION_1_7", "JavaVersion.VERSION_1_8")
    if (original != updated) {
        buildFile.writeText(updated)
    }
}

fun patchCubismPhysicsSource(sourceFile: File) {
    if (!sourceFile.exists()) return
    val original = sourceFile.readText()
    val updated = original
        .replace(
            """                options.wind,
                    MOVEMENT_THRESHOLD * currentSetting.normalizationPosition.maximumValue,""",
            """                windForSetting(settingIndex),
                    MOVEMENT_THRESHOLD * currentSetting.normalizationPosition.maximumValue,""",
        )
        .replace(
            """                options.wind,
                MOVEMENT_THRESHOLD * currentSetting.normalizationPosition.maximumValue
            );""",
            """                windForSetting(settingIndex),
                MOVEMENT_THRESHOLD * currentSetting.normalizationPosition.maximumValue
            );""",
        )
        .replace(
            """    public Options getOptions() {
        return options;
    }

    /**""",
            """    public Options getOptions() {
        return options;
    }

    /**
     * Restrict wind to selected physics sub-rigs. A null mask keeps the
     * framework's original behavior and applies wind to every sub-rig.
     *
     * @param settingIndices zero-based physics sub-rig indices that receive wind
     */
    public void setWindEnabledSettings(int[] settingIndices) {
        windEnabledSettings = settingIndices;
    }

    private CubismVector2 windForSetting(int settingIndex) {
        if (windEnabledSettings == null) {
            return options.wind;
        }
        for (int enabledSetting : windEnabledSettings) {
            if (enabledSetting == settingIndex) {
                return options.wind;
            }
        }
        return noWind;
    }

    /**""",
        )
        .replace(
            """    private CubismPhysicsRig physicsRig;
""",
            """    private CubismPhysicsRig physicsRig;
    private int[] windEnabledSettings;
    private final CubismVector2 noWind = new CubismVector2();
""",
        )
    if (original != updated) {
        sourceFile.writeText(updated)
    }
}

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "LilyMobileRealmAndroid"
include(":app")

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

if (cubismFrameworkDir.exists() && cubismCoreAar.exists()) {
    val cubismMirrorRoot = rootDir.resolve(".gradle/cubismSdkMirror")
    val mirroredFrameworkDir = cubismMirrorRoot.resolve("Framework/framework")
    val mirroredCoreDir = cubismMirrorRoot.resolve("Core/android")

    syncDirectory(cubismFrameworkDir, mirroredFrameworkDir)
    syncDirectory(cubismCoreAar.parentFile, mirroredCoreDir)
    patchFrameworkBuildFile(mirroredFrameworkDir.resolve("build.gradle"))
    patchCubismPhysicsSource(
        mirroredFrameworkDir.resolve(
            "src/main/java/com/live2d/sdk/cubism/framework/physics/CubismPhysics.java",
        ),
    )

    include(":cubismFramework")
    project(":cubismFramework").projectDir = mirroredFrameworkDir
}
