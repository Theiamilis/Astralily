package com.lilyconstellation.mobile.live2d

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import android.util.Log
import android.view.MotionEvent
import com.lilyconstellation.mobile.BuildConfig
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MIN_MODEL_OFFSET_Y
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MAX_MODEL_OFFSET_Y
import com.live2d.demo.minimum.LAppMinimumDelegate
import com.live2d.demo.minimum.LAppMinimumLive2DManager
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

private const val MIN_MODEL_SCALE = 0.78f
private const val MAX_MODEL_SCALE = 3.25f
private const val MAX_MODEL_OFFSET_X = 0.85f
private const val NANOS_PER_SECOND = 1_000_000_000.0

class CubismPocketRealmStageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : GLSurfaceView(context, attrs), PocketRealmStageBridge {
    private val renderer = object : Renderer {
        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            val delegate = LAppMinimumDelegate.getInstance()
            renderedModelFrames = 0
            stageReadyReported = false
            ambientMotionStartedAtNanos = System.nanoTime()
            delegate.setInitialModelName(requestedModelId)
            delegate.setStageDarkMode(requestedDarkModeEnabled)
            delegate.onSurfaceCreated()
            activeModelId = requestedModelId
            appliedExpression = null
            applyRequestedExpression()
            if (requestedLipSyncLevel > 0f) {
                LAppMinimumLive2DManager.getInstance().setLipSyncValue(requestedLipSyncLevel)
            }
        }

        override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
            LAppMinimumDelegate.getInstance().onSurfaceChanged(width, height)
        }

        override fun onDrawFrame(gl: GL10?) {
            applyAmbientLook()
            applyAmbientWind()
            LAppMinimumDelegate.getInstance().run()
            val modelReady = runCatching {
                com.live2d.sdk.cubism.framework.CubismFramework.isInitialized() &&
                    LAppMinimumLive2DManager.getInstance().getModel(0) != null
            }.getOrDefault(false)
            if (modelReady) {
                renderedModelFrames += 1
                if (renderedModelFrames >= 2) reportStageReady()
            }
        }
    }
    @Volatile
    private var followEnabled = true
    private var modelScaleMultiplier: Float = 1.0f
    private var modelOffsetX: Float = 0f
    private var modelOffsetY: Float = 0f
    private var viewportTopInsetPx: Int = 0
    private var viewportBottomInsetPx: Int = 0
    private var requestedModelId: String = BuildConfig.CUBISM_MODEL_NAME
    private var activeModelId: String = BuildConfig.CUBISM_MODEL_NAME
    private var requestedExpression: String = "Neutral"
    private var appliedExpression: String? = null
    private var requestedLipSyncLevel: Float = 0f
    @Volatile
    private var requestedDarkModeEnabled: Boolean = false
    private var onStageReadyListener: (() -> Unit)? = null
    @Volatile
    private var stageReadyReported = false
    private var renderedModelFrames = 0
    private var appliedLipSyncLevel: Float = Float.NaN
    private var transformUpdateScheduled = false
    private var ambientMotionStartedAtNanos = System.nanoTime()
    private var touchCaptured = false
    @Volatile
    private var touchLookActive = false
    private var touchPhysicsActive = false
    private var touchLastX = 0f
    private var touchLastY = 0f
    @Volatile
    private var touchImpulseX = 0f
    @Volatile
    private var touchImpulseY = 0f

    init {
        // Cubism's GL thread can request shader assets as soon as setRenderer()
        // returns. Seed the delegate first so a cold start never races the
        // later onAttachedToWindow callback and observes a null Activity.
        (context as? Activity)?.let { activity ->
            LAppMinimumDelegate.getInstance().onStart(activity)
        }
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderMediaOverlay(false)
        setBackgroundColor(Color.TRANSPARENT)
        setEGLContextClientVersion(2)
        setRenderer(renderer)
        renderMode = RENDERMODE_CONTINUOUSLY
        preserveEGLContextOnPause = true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        (context as? Activity)?.let { activity ->
            Log.i(TAG, "Starting Cubism stage before GL surface initialization.")
            LAppMinimumDelegate.getInstance().onStart(activity)
        }
    }

    override fun onDetachedFromWindow() {
        queueEvent {
            runCatching { LAppMinimumDelegate.getInstance().onStop() }
        }
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!followEnabled) {
            return false
        }

        val action = event.actionMasked
        val excludedPointerIndex = if (action == MotionEvent.ACTION_POINTER_UP) event.actionIndex else -1
        val pointX = eventCenterX(event, excludedPointerIndex)
        val pointY = eventCenterY(event, excludedPointerIndex)
        val hasMultiplePointers = event.pointerCount >= 2
        if (action == MotionEvent.ACTION_DOWN) {
            touchCaptured = true
            touchLookActive = true
            touchPhysicsActive = false
            touchLastX = pointX
            touchLastY = pointY
            touchImpulseX = 0f
            touchImpulseY = 0f
            // Compose's parent can otherwise decide that this is a scroll
            // gesture before the second pointer arrives.
            parent?.requestDisallowInterceptTouchEvent(true)
        } else if (!touchCaptured) {
            return false
        }

        // Do not rely only on ACTION_POINTER_DOWN. Some Android/Compose input
        // paths deliver the first two-pointer MOVE without that transition.
        if (hasMultiplePointers && !touchPhysicsActive) {
            touchPhysicsActive = true
            touchLastX = pointX
            touchLastY = pointY
            // Two fingers intentionally produce a short physical response.
            touchImpulseX = 0f
            touchImpulseY = 0.95f
        }
        if (action == MotionEvent.ACTION_MOVE && touchPhysicsActive && hasMultiplePointers) {
            val widthScale = width.coerceAtLeast(1).toFloat()
            val heightScale = height.coerceAtLeast(1).toFloat()
            touchImpulseX = (touchImpulseX + (pointX - touchLastX) / widthScale * 2.40f)
                .coerceIn(-1.15f, 1.15f)
            touchImpulseY = (touchImpulseY + (touchLastY - pointY) / heightScale * 2.40f)
                .coerceIn(-1.15f, 1.15f)
            touchLastX = pointX
            touchLastY = pointY
        }
        if (action == MotionEvent.ACTION_POINTER_UP && event.pointerCount <= 2) {
            touchPhysicsActive = false
        }
        queueEvent {
            when (action) {
                MotionEvent.ACTION_DOWN -> {
                    val delegate = LAppMinimumDelegate.getInstance()
                    delegate.onTouchBegan(pointX, pointY)
                    // Apply the first look target immediately; waiting for the
                    // first MOVE makes a stationary finger appear unresponsive.
                    delegate.onTouchMoved(pointX, pointY)
                }
                MotionEvent.ACTION_MOVE, MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP ->
                    LAppMinimumDelegate.getInstance().onTouchMoved(pointX, pointY)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> LAppMinimumDelegate.getInstance().onTouchEnd(pointX, pointY)
            }
        }
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            touchCaptured = false
            touchLookActive = false
            touchPhysicsActive = false
            parent?.requestDisallowInterceptTouchEvent(false)
        }
        // Keep ownership after ACTION_DOWN so Android continues delivering MOVE
        // events. Without this, Cubism only receives the initial tap and no drag
        // input reaches the look/physics pipeline.
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun eventCenterX(event: MotionEvent, excludedPointerIndex: Int): Float {
        var sum = 0f
        var count = 0
        for (index in 0 until event.pointerCount) {
            if (index != excludedPointerIndex) {
                sum += event.getX(index)
                count++
            }
        }
        return if (count == 0) event.x else sum / count
    }

    private fun eventCenterY(event: MotionEvent, excludedPointerIndex: Int): Float {
        var sum = 0f
        var count = 0
        for (index in 0 until event.pointerCount) {
            if (index != excludedPointerIndex) {
                sum += event.getY(index)
                count++
            }
        }
        return if (count == 0) event.y else sum / count
    }

    override fun setLipSyncLevel(value: Float) {
        val normalized = value.coerceIn(0f, 1f)
        requestedLipSyncLevel = normalized
        if (!appliedLipSyncLevel.isNaN() && abs(appliedLipSyncLevel - normalized) < 0.01f) return
        queueEvent {
            if (com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()) {
                LAppMinimumLive2DManager.getInstance().setLipSyncValue(normalized)
                appliedLipSyncLevel = normalized
            }
        }
    }

    override fun setModelId(value: String) {
        val normalized = value.takeIf { candidate ->
            BuildConfig.BUNDLED_MODEL_IDS.split(',').contains(candidate)
        } ?: BuildConfig.CUBISM_MODEL_NAME
        requestedModelId = normalized
        queueEvent {
            if (
                normalized.isNotBlank() &&
                normalized != activeModelId &&
                com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()
            ) {
                Log.i(TAG, "Switching Cubism model to $normalized")
                LAppMinimumLive2DManager.getInstance().loadModel(normalized)
                activeModelId = normalized
                appliedExpression = null
                applyRequestedExpression()
            }
        }
    }

    override fun setExpression(value: String) {
        val normalized = value.ifBlank { "Neutral" }
        requestedExpression = normalized
        if (appliedExpression == normalized) return
        queueEvent {
            applyRequestedExpression()
        }
    }

    override fun setFollowEnabled(enabled: Boolean) {
        followEnabled = enabled
        if (!enabled) {
            touchLookActive = false
            touchCaptured = false
            touchPhysicsActive = false
            touchImpulseX = 0f
            touchImpulseY = 0f
            queueEvent {
                LAppMinimumLive2DManager.getInstance().onDrag(0f, 0f)
            }
        }
    }

    override fun setModelScale(multiplier: Float) {
        val normalized = multiplier.coerceIn(MIN_MODEL_SCALE, MAX_MODEL_SCALE)
        if (abs(modelScaleMultiplier - normalized) < 0.001f) return
        modelScaleMultiplier = normalized
        scheduleStageTransform()
    }

    override fun setModelOffset(offsetX: Float, offsetY: Float) {
        val normalizedX = offsetX.coerceIn(-MAX_MODEL_OFFSET_X, MAX_MODEL_OFFSET_X)
        val normalizedY = offsetY.coerceIn(MIN_MODEL_OFFSET_Y, MAX_MODEL_OFFSET_Y)
        if (abs(modelOffsetX - normalizedX) < 0.001f && abs(modelOffsetY - normalizedY) < 0.001f) return
        modelOffsetX = normalizedX
        modelOffsetY = normalizedY
        scheduleStageTransform()
    }

    override fun setViewportInsets(topPx: Int, bottomPx: Int) {
        val normalizedTop = topPx.coerceAtLeast(0)
        val normalizedBottom = bottomPx.coerceAtLeast(0)
        if (viewportTopInsetPx == normalizedTop && viewportBottomInsetPx == normalizedBottom) return
        viewportTopInsetPx = normalizedTop
        viewportBottomInsetPx = normalizedBottom
        scheduleStageTransform()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        scheduleStageTransform()
    }

    private fun applyRequestedExpression() {
        if (
            appliedExpression != requestedExpression &&
            com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()
        ) {
            LAppMinimumLive2DManager.getInstance().setExpression(requestedExpression)
            appliedExpression = requestedExpression
        }
    }

    override fun setDarkModeEnabled(enabled: Boolean) {
        requestedDarkModeEnabled = enabled
        queueEvent {
            LAppMinimumDelegate.getInstance().setStageDarkMode(enabled)
        }
    }

    override fun setOnStageReadyListener(listener: (() -> Unit)?) {
        onStageReadyListener = listener
        if (stageReadyReported && listener != null) post(listener)
    }

    private fun reportStageReady() {
        if (stageReadyReported) return
        stageReadyReported = true
        post { onStageReadyListener?.invoke() }
    }

    private fun applyAmbientLook() {
        if (
            !followEnabled ||
            touchLookActive ||
            !com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()
        ) {
            return
        }

        val elapsedSeconds = (System.nanoTime() - ambientMotionStartedAtNanos) / NANOS_PER_SECOND
        val targetX = (
            sin(elapsedSeconds * 0.24) * 0.18 +
                sin(elapsedSeconds * 0.11 + 1.30) * 0.055
            ).toFloat()
        val targetY = (
            sin(elapsedSeconds * 0.18 + 0.80) * 0.08 +
                cos(elapsedSeconds * 0.08) * 0.035
            ).toFloat()

        LAppMinimumLive2DManager.getInstance().onDrag(targetX, targetY)
    }

    private fun applyAmbientWind() {
        if (!com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()) {
            return
        }

        val elapsedSeconds = (System.nanoTime() - ambientMotionStartedAtNanos) / NANOS_PER_SECOND
        // Ambient wind is kept on the hair groups. A separate two-finger impulse
        // may temporarily include safe non-hand groups for touch physics.
        val windX = (
            0.22 +
                sin(elapsedSeconds * 0.27 + 0.40) * 0.07 +
                sin(elapsedSeconds * 0.61 + 2.10) * 0.035
            ).toFloat()
        val windY = (
            sin(elapsedSeconds * 0.19 + 1.10) * 0.035
            ).toFloat()
        val impulseX = touchImpulseX
        val impulseY = touchImpulseY
        val touchActive = abs(impulseX) + abs(impulseY) > 0.01f

        if (touchActive) {
            LAppMinimumLive2DManager.getInstance().setTouchWind(
                windX + impulseX,
                windY + impulseY,
            )
            touchImpulseX = impulseX * 0.86f
            touchImpulseY = impulseY * 0.86f
        } else {
            LAppMinimumLive2DManager.getInstance().setWind(windX, windY)
        }
    }

    private fun scheduleStageTransform() {
        if (transformUpdateScheduled) return
        transformUpdateScheduled = true
        post {
            transformUpdateScheduled = false
            applyStageTransform()
        }
    }

    private fun applyStageTransform() {
        if (width <= 0 || height <= 0) return
        val stageHeight = height.toFloat()
        val topInset = viewportTopInsetPx.toFloat()
        val bottomInset = viewportBottomInsetPx.toFloat()
        val baseScale = 0.72f
        val finalScale = (baseScale * modelScaleMultiplier).coerceIn(0.56f, 2.30f)
        scaleX = 1f
        scaleY = 1f
        translationX = 0f
        translationY = 0f

        val normalizedBottomInset = (bottomInset / stageHeight).coerceIn(0f, 0.45f)
        val normalizedTopInset = (topInset / stageHeight).coerceIn(0f, 0.22f)
        val modelX = (modelOffsetX * 0.58f).coerceIn(-0.50f, 0.50f)
        val modelY = ModelPositionLimits.rendererOffsetY(
            modelOffsetY, normalizedTopInset, normalizedBottomInset,
        )

        queueEvent {
            if (com.live2d.sdk.cubism.framework.CubismFramework.isInitialized()) {
                LAppMinimumLive2DManager.getInstance().setPocketRealmModelTransform(
                    finalScale,
                    modelX,
                    modelY,
                )
            }
        }
    }

    private companion object {
        const val TAG = "LilyCubismStage"
    }
}
