package com.lilyconstellation.mobile.ui

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.audiofx.Visualizer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

@Composable
internal fun PocketRealmAudioEffect(
    audioUrl: String?,
    resolveAudioUrl: suspend (String) -> String,
    onPlaybackState: (Boolean) -> Unit,
    onPlaybackProgress: (positionMs: Int, durationMs: Int) -> Unit,
    onLipSyncTick: (Float) -> Unit,
) {
    DisposableEffect(audioUrl) {
        if (audioUrl.isNullOrBlank()) {
            onPlaybackState(false)
            onPlaybackProgress(0, 0)
            onLipSyncTick(0f)
            onDispose { }
        } else {
            val mainScope = MainScope()
            val player = MediaPlayer()
            var ticker: Job? = null
            var progressTicker: Job? = null
            var visualizer: Visualizer? = null
            var playerReleased = false

            fun releasePlayer() {
                if (playerReleased) return
                playerReleased = true
                runCatching { player.release() }
            }

            fun releaseVisualizer() {
                visualizer?.let { activeVisualizer ->
                    runCatching { activeVisualizer.enabled = false }
                    runCatching { activeVisualizer.release() }
                }
                visualizer = null
            }

            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build(),
            )
            player.setOnPreparedListener {
                visualizer = createPlaybackVisualizer(it, mainScope, onLipSyncTick)
                it.start()
                onPlaybackState(true)
                progressTicker = mainScope.launch(Dispatchers.Main.immediate) {
                    while (isActive && runCatching { it.isPlaying }.getOrDefault(false)) {
                        val durationMs = runCatching { it.duration }.getOrDefault(0).coerceAtLeast(0)
                        val positionMs = runCatching { it.currentPosition }.getOrDefault(0).coerceAtLeast(0)
                        onPlaybackProgress(positionMs, durationMs)
                        delay(90)
                    }
                }
                if (visualizer == null) {
                    ticker = mainScope.launch(Dispatchers.Main.immediate) {
                        var step = 0
                        while (it.isPlaying) {
                            onLipSyncTick((0.10f + abs(sin(step / 2.4f)).toFloat() * 0.48f).coerceIn(0f, 1f))
                            step += 1
                            delay(80)
                        }
                    }
                }
            }
            player.setOnCompletionListener {
                ticker?.cancel()
                progressTicker?.cancel()
                releaseVisualizer()
                mainScope.cancel()
                val durationMs = runCatching { it.duration }.getOrDefault(0).coerceAtLeast(0)
                onPlaybackProgress(durationMs, durationMs)
                onLipSyncTick(0f)
                onPlaybackState(false)
                releasePlayer()
            }
            player.setOnErrorListener { _, _, _ ->
                ticker?.cancel()
                progressTicker?.cancel()
                releaseVisualizer()
                mainScope.cancel()
                onPlaybackProgress(0, 0)
                onLipSyncTick(0f)
                onPlaybackState(false)
                releasePlayer()
                true
            }
            mainScope.launch {
                runCatching { resolveAudioUrl(audioUrl) }.onSuccess { resolved ->
                    if (isActive && !playerReleased) {
                        player.setDataSource(resolved)
                        player.prepareAsync()
                    }
                }.onFailure {
                    if (isActive && !playerReleased) {
                        onPlaybackState(false)
                        releasePlayer()
                    }
                }
            }

            onDispose {
                ticker?.cancel()
                progressTicker?.cancel()
                releaseVisualizer()
                mainScope.cancel()
                onPlaybackProgress(0, 0)
                onLipSyncTick(0f)
                runCatching {
                    if (player.isPlaying) player.stop()
                }
                releasePlayer()
            }
        }
    }
}

private fun createPlaybackVisualizer(
    player: MediaPlayer,
    mainScope: kotlinx.coroutines.CoroutineScope,
    onLipSyncTick: (Float) -> Unit,
): Visualizer? = runCatching {
    var smoothedLevel = 0f
    Visualizer(player.audioSessionId).apply {
        captureSize = Visualizer.getCaptureSizeRange().first()
        setDataCaptureListener(
            object : Visualizer.OnDataCaptureListener {
                override fun onWaveFormDataCapture(
                    visualizer: Visualizer?,
                    waveform: ByteArray?,
                    samplingRate: Int,
                ) {
                    val samples = waveform ?: return
                    if (samples.isEmpty()) return
                    var squareSum = 0.0
                    samples.forEach { sample ->
                        val centered = (sample.toInt() and 0xFF) - 128
                        squareSum += centered.toDouble() * centered.toDouble()
                    }
                    val rms = sqrt(squareSum / samples.size).toFloat()
                    val normalized = ((rms - 1.5f) / 24f).coerceIn(0f, 1f).pow(0.72f)
                    val smoothing = if (normalized > smoothedLevel) 0.72f else 0.28f
                    smoothedLevel += (normalized - smoothedLevel) * smoothing
                    mainScope.launch(Dispatchers.Main.immediate) {
                        onLipSyncTick(smoothedLevel.coerceIn(0f, 1f))
                    }
                }

                override fun onFftDataCapture(
                    visualizer: Visualizer?,
                    fft: ByteArray?,
                    samplingRate: Int,
                ) = Unit
            },
            minOf(Visualizer.getMaxCaptureRate(), 20_000),
            true,
            false,
        )
        enabled = true
    }
}.getOrNull()
