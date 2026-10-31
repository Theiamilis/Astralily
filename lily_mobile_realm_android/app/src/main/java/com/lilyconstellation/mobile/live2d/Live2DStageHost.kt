package com.lilyconstellation.mobile.live2d

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.lilyconstellation.mobile.BuildConfig

private const val NATIVE_LIVE2D_STAGE_ENABLED = true

@Composable
fun Live2DStageHost(
    modifier: Modifier = Modifier,
    modelId: String,
    expression: String,
    lipSyncLevel: Float,
    followEnabled: Boolean,
    darkModeEnabled: Boolean = false,
    onStageReady: () -> Unit = {},
    modelScaleMultiplier: Float = 1.0f,
    modelOffsetX: Float = 0f,
    modelOffsetY: Float = 0f,
    topInsetPx: Int = 0,
    bottomInsetPx: Int = 0,
    health: com.lilyconstellation.mobile.data.HealthResponse? = null,
    presenceStatus: String = "available",
) {
    val context = LocalContext.current
    val currentOnStageReady = rememberUpdatedState(onStageReady)
    @Suppress("UNUSED_VARIABLE")
    val ignoredHealth = health
    @Suppress("UNUSED_VARIABLE")
    val ignoredPresence = presenceStatus
    val nativeStageConstructor = remember {
        if (!NATIVE_LIVE2D_STAGE_ENABLED || !BuildConfig.HAS_CUBISM_NATIVE) {
            null
        } else {
            runCatching {
                Class.forName("com.lilyconstellation.mobile.live2d.CubismPocketRealmStageView")
                    .getConstructor(android.content.Context::class.java)
            }.getOrNull()
        }
    }

    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        if (NATIVE_LIVE2D_STAGE_ENABLED) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    val view = if (nativeStageConstructor != null) {
                        nativeStageConstructor.newInstance(context) as View
                    } else {
                        PocketRealmStageView(context)
                    }
                    view.isClickable = true
                    view.isFocusable = false
                    view.isFocusableInTouchMode = false
                    (view as? PocketRealmStageBridge)?.apply {
                        setModelId(modelId)
                        setFollowEnabled(followEnabled)
                        setDarkModeEnabled(darkModeEnabled)
                        setOnStageReadyListener { currentOnStageReady.value() }
                        setModelScale(modelScaleMultiplier)
                        setModelOffset(modelOffsetX, modelOffsetY)
                        setViewportInsets(topInsetPx, bottomInsetPx)
                    }
                    view
                },
                update = { view ->
                    (view as? PocketRealmStageBridge)?.apply {
                        setModelId(modelId)
                        setExpression(expression)
                        setLipSyncLevel(lipSyncLevel)
                        setFollowEnabled(followEnabled)
                        setDarkModeEnabled(darkModeEnabled)
                        setModelScale(modelScaleMultiplier)
                        setModelOffset(modelOffsetX, modelOffsetY)
                        setViewportInsets(topInsetPx, bottomInsetPx)
                    }
                },
            )
        }
    }
}
