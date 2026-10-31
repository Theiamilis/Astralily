package com.lilyconstellation.mobile.live2d

/** Shared by preferences, controls, and both stage hosts. Y uses OpenGL's up-positive axis. */
object ModelPositionLimits {
    const val MIN_MODEL_OFFSET_Y = -3.0f
    const val MAX_MODEL_OFFSET_Y = 3.0f
    const val MIN_RENDER_OFFSET_Y = -1.85f
    const val MAX_RENDER_OFFSET_Y = 1.85f

    fun rendererOffsetY(offsetY: Float, topInsetFraction: Float, bottomInsetFraction: Float): Float =
        (offsetY.coerceIn(MIN_MODEL_OFFSET_Y, MAX_MODEL_OFFSET_Y) * 0.55f -
            bottomInsetFraction.coerceIn(0f, 0.45f) * 0.34f +
            topInsetFraction.coerceIn(0f, 0.22f) * 0.04f)
            .coerceIn(MIN_RENDER_OFFSET_Y, MAX_RENDER_OFFSET_Y)
}
