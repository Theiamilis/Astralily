package com.lilyconstellation.mobile.live2d

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import android.view.MotionEvent
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MIN_MODEL_OFFSET_Y
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MAX_MODEL_OFFSET_Y
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

private const val STAGE_CLEAR_R = 0.96f
private const val STAGE_CLEAR_G = 0.84f
private const val STAGE_CLEAR_B = 0.90f
private const val DARK_STAGE_CLEAR_R = 0.16f
private const val DARK_STAGE_CLEAR_G = 0.10f
private const val DARK_STAGE_CLEAR_B = 0.14f
private const val MIN_MODEL_SCALE = 0.78f
private const val MAX_MODEL_SCALE = 3.25f
private const val MAX_MODEL_OFFSET_X = 0.85f

/**
 * OpenGL-backed stage host for the native Pocket Realm.
 * The actual Cubism SDK for Java renderer is intentionally left as a local/manual drop-in.
 * Until that SDK and the model assets are present, this view keeps a soft stage alive so
 * the rest of the Android app can be wired and tested safely.
 */
class PocketRealmStageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : GLSurfaceView(context, attrs), PocketRealmStageBridge {
    private val renderer = PocketRealmStageRenderer(::reportStageReady)
    private var onStageReadyListener: (() -> Unit)? = null
    private var stageReadyReported = false
    private var modelScaleMultiplier: Float = 1.0f
    private var modelOffsetX: Float = 0f
    private var modelOffsetY: Float = 0f
    private var viewportTopInsetPx: Int = 0
    private var viewportBottomInsetPx: Int = 0

    init {
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderMediaOverlay(false)
        setBackgroundColor(Color.TRANSPARENT)
        setEGLContextClientVersion(2)
        setRenderer(renderer)
        renderMode = RENDERMODE_CONTINUOUSLY
    }

    override fun setModelId(value: String) = Unit

    override fun setLipSyncLevel(value: Float) {
        renderer.lipSyncLevel = value
    }

    override fun setExpression(value: String) {
        renderer.expression = value
    }

    override fun setFollowEnabled(enabled: Boolean) {
        renderer.followEnabled = enabled
    }

    override fun setDarkModeEnabled(enabled: Boolean) {
        renderer.darkModeEnabled = enabled
    }

    override fun setOnStageReadyListener(listener: (() -> Unit)?) {
        onStageReadyListener = listener
        if (stageReadyReported && listener != null) post(listener)
    }

    override fun setModelScale(multiplier: Float) {
        modelScaleMultiplier = multiplier.coerceIn(MIN_MODEL_SCALE, MAX_MODEL_SCALE)
        post { applyStageTransform() }
    }

    override fun setModelOffset(offsetX: Float, offsetY: Float) {
        modelOffsetX = offsetX.coerceIn(-MAX_MODEL_OFFSET_X, MAX_MODEL_OFFSET_X)
        modelOffsetY = offsetY.coerceIn(MIN_MODEL_OFFSET_Y, MAX_MODEL_OFFSET_Y)
        post { applyStageTransform() }
    }

    override fun setViewportInsets(topPx: Int, bottomPx: Int) {
        viewportTopInsetPx = topPx.coerceAtLeast(0)
        viewportBottomInsetPx = bottomPx.coerceAtLeast(0)
        post { applyStageTransform() }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        applyStageTransform()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = false

    private fun applyStageTransform() {
        if (width <= 0 || height <= 0) return
        renderer.stageState = modelScaleMultiplier + modelOffsetX + modelOffsetY +
            viewportTopInsetPx.toFloat() + viewportBottomInsetPx.toFloat()
        scaleX = 1f
        scaleY = 1f
        translationX = 0f
        translationY = 0f
    }

    private fun reportStageReady() {
        if (stageReadyReported) return
        stageReadyReported = true
        post { onStageReadyListener?.invoke() }
    }
}

private class PocketRealmStageRenderer(
    private val onStageReady: () -> Unit,
) : GLSurfaceView.Renderer {
    private var renderedFrames = 0
    @Volatile
    var lipSyncLevel: Float = 0f

    @Volatile
    var expression: String = "Neutral"

    @Volatile
    var followEnabled: Boolean = true

    @Volatile
    var darkModeEnabled: Boolean = false

    @Volatile
    var stageState: Float = 0f

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        applyClearColor()
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        applyClearColor()
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        renderedFrames += 1
        if (renderedFrames == 2) onStageReady()
    }

    private fun applyClearColor() {
        if (darkModeEnabled) {
            GLES20.glClearColor(DARK_STAGE_CLEAR_R, DARK_STAGE_CLEAR_G, DARK_STAGE_CLEAR_B, 1.0f)
        } else {
            GLES20.glClearColor(STAGE_CLEAR_R, STAGE_CLEAR_G, STAGE_CLEAR_B, 1.0f)
        }
    }
}
