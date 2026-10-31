package com.lilyconstellation.mobile.live2d

interface PocketRealmStageBridge {
    fun setModelId(value: String)
    fun setLipSyncLevel(value: Float)
    fun setExpression(value: String)
    fun setFollowEnabled(enabled: Boolean)
    fun setDarkModeEnabled(enabled: Boolean)
    fun setOnStageReadyListener(listener: (() -> Unit)?)
    fun setModelScale(multiplier: Float)
    fun setModelOffset(offsetX: Float, offsetY: Float)
    fun setViewportInsets(topPx: Int, bottomPx: Int)
}
