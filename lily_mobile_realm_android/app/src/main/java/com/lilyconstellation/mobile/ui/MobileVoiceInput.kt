package com.lilyconstellation.mobile.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/** Owns one microphone backend at a time. All entry points run on the UI thread. */
internal class MobileVoiceInput(context: Context, private val viewModel: PocketRealmViewModel) {
    private val context = context.applicationContext
    private val recorder = MobileVoiceRecorder(this.context)
    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var session: Long? = null
    private var provider = "lily-core-host"
    private var language = "id"
    private var stopping = false

    private fun active(id: Long) = session == id && viewModel.isVoiceInputActive(id)

    fun start() {
        val id = viewModel.beginVoiceInput() ?: return
        session = id
        provider = viewModel.uiState.value.speechInputProvider
        language = viewModel.spokenLanguage()
        stopping = false
        // Let Compose release Lily's current audio playback before acquiring the mic.
        handler.postDelayed({ if (active(id)) startCapture(id) }, 200)
    }

    private fun startCapture(id: Long) {
        try {
            if (provider == "android") {
                if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                    fail(id, "Android speech recognition is unavailable. Choose STT lily-core-host in Settings.", "unavailable")
                    return
                }
                val service = SpeechRecognizer.createSpeechRecognizer(context)
                recognizer = service
                service.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) = Unit
                    override fun onBeginningOfSpeech() { if (active(id)) viewModel.setVoiceActivity(true) }
                    override fun onRmsChanged(rmsdB: Float) = Unit
                    override fun onBufferReceived(buffer: ByteArray?) = Unit
                    override fun onEndOfSpeech() { if (active(id)) awaitResult(id) }
                    override fun onPartialResults(partialResults: Bundle?) = Unit
                    override fun onEvent(eventType: Int, params: Bundle?) = Unit
                    override fun onResults(results: Bundle?) {
                        if (!active(id)) return
                        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull().orEmpty()
                        releaseCapture()
                        viewModel.completeVoiceInput(id, text)
                    }
                    override fun onError(error: Int) {
                        if (!active(id)) return
                        val (message, code) = when (error) {
                            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required." to "permission"
                            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                                "No speech was recognized. Tap the mic to try again." to "empty_audio"
                            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                                "This speech language is unavailable. Check Android speech settings or choose STT lily-core-host." to "language"
                            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                                "Android speech recognition could not connect. Retry or choose STT lily-core-host." to "network"
                            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The microphone is busy. Try again." to "busy"
                            else -> "Android speech recognition failed. Retry or choose STT lily-core-host." to "recognition"
                        }
                        fail(id, message, code)
                    }
                })
                val tag = when (language) { "ja" -> "ja-JP"; "en" -> "en-US"; else -> "id-ID" }
                service.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                })
            } else {
                recorder.start(
                    onSpeechDetected = { if (active(id)) viewModel.setVoiceActivity(true) },
                    onSilenceDetected = {
                        if (active(id)) { viewModel.setVoiceSilenceDetected(); stop() }
                    },
                )
            }
        } catch (error: Exception) {
            fail(id, "Could not start the microphone. Check permission and try again.", "microphone")
        }
    }

    fun stop() {
        val id = session ?: return
        if (!active(id) || stopping) return
        // A rapid stop before the delayed capture starts is a cancellation.
        handler.removeCallbacksAndMessages(null)
        if (provider == "android") {
            val service = recognizer
            if (service == null) { cancel(); return }
            awaitResult(id)
            try { service.stopListening() } catch (error: Exception) {
                fail(id, "Could not finish speech recognition. Try again.", "recognition")
            }
        } else {
            stopping = true
            val file = recorder.stop()
            session = null
            if (file == null) {
                viewModel.failVoiceInput(id, "That recording was too short. Try again.", "empty_audio")
            } else {
                viewModel.sendVoiceRecording(file, id, language)
            }
        }
    }

    private fun awaitResult(id: Long) {
        if (stopping) return
        stopping = true
        viewModel.awaitVoiceInput(id)
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({
            if (active(id)) fail(id, "Speech recognition timed out. Try again or choose STT lily-core-host.", "timeout")
        }, 15_000)
    }

    private fun fail(id: Long, message: String, code: String) {
        if (!active(id)) return
        releaseCapture()
        viewModel.failVoiceInput(id, message, code)
    }

    private fun releaseCapture() {
        session = null
        handler.removeCallbacksAndMessages(null)
        recorder.cancel()
        val previous = recognizer
        recognizer = null
        runCatching { previous?.cancel() }
        runCatching { previous?.destroy() }
    }

    fun cancel() {
        viewModel.cancelVoiceInput()
        releaseCapture()
    }
}
