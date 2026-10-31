package com.lilyconstellation.mobile.data

import android.content.Context
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MIN_MODEL_OFFSET_Y
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MAX_MODEL_OFFSET_Y
import java.util.UUID

private const val DEFAULT_MODEL_SCALE = 1.0f
private const val MIN_MODEL_SCALE = 0.78f
private const val MAX_MODEL_SCALE = 3.25f
private const val MAX_MODEL_OFFSET_X = 0.85f
private const val DEFAULT_CHARACTER_NAME = "Lily"
private const val MAX_CHARACTER_NAME_LENGTH = 24
private val CharacterNameWhitespace = Regex("\\s+")
private val CharacterNameControls = Regex("[\\p{Cc}\\p{Cf}]")

data class PocketRealmSettings(
    val coreBaseUrl: String = DEFAULT_CORE_BASE_URL,
    val tunnelBaseUrl: String = DEFAULT_TUNNEL_BASE_URL,
    val connectionMode: String = "auto",
    val characterName: String = DEFAULT_CHARACTER_NAME,
    val activeModelId: String = "lily_jirai_kei",
    val activeLanguage: String = "ja",
    val speechInputProvider: String = "lily-core-host",
    val speechInputLanguage: String = "chat",
    val voiceRoute: String = "sovits",
    val voiceLanguage: String = "ja",
    val addressTerm: String = "darling",
    val japaneseVoiceProfile: String = "ja",
    val englishVoiceProfile: String = "zeta_en",
    val activeMood: String = "talk",
    val modelScaleMultiplier: Float = DEFAULT_MODEL_SCALE,
    val modelOffsetX: Float = 0f,
    val modelOffsetY: Float = 0f,
    val defaultModelScaleMultiplier: Float = DEFAULT_MODEL_SCALE,
    val defaultModelOffsetX: Float = 0f,
    val defaultModelOffsetY: Float = 0f,
    val presenceStatus: String = "available",
    val presenceNote: String = "",
    val voiceRepliesEnabled: Boolean = true,
    val automaticPresenceEnabled: Boolean = true,
    val followEnabled: Boolean = true,
    val notificationsEnabled: Boolean = true,
    val biometricLockEnabled: Boolean = false,
    val darkModeEnabled: Boolean = false,
    val deliveryTarget: String = "mobile_${UUID.randomUUID().toString().take(8)}",
    val ownerApiToken: String = "",
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("lily_mobile_realm", Context.MODE_PRIVATE)
    private val secureTokenStore = SecureTokenStore(context.applicationContext)

    fun load(): PocketRealmSettings {
        prefs.edit().remove("paired_core_url").remove("paired_device_id").apply()
        if (!prefs.contains(KEY_PRIVATE_URL)) {
            prefs.edit().putString(KEY_PRIVATE_URL, prefs.getString(KEY_BASE_URL, DEFAULT_CORE_BASE_URL)).apply()
        }
        val connection = CoreConnectionConfig.restored(prefs.getString(KEY_BASE_URL, null), prefs.getString(KEY_PRIVATE_URL, null),
            prefs.getString(KEY_TUNNEL_URL, null), prefs.getString(KEY_CONNECTION_MODE, null))
        val existingTarget = prefs.getString(KEY_DELIVERY_TARGET, null)?.trim().orEmpty()
        val activeLanguage = normalizeLanguage(prefs.getString(KEY_LANGUAGE, "ja").orEmpty())
        val deliveryTarget = existingTarget.ifBlank {
            val generated = "mobile_${UUID.randomUUID().toString().take(8)}"
            prefs.edit().putString(KEY_DELIVERY_TARGET, generated).apply()
            generated
        }
        return PocketRealmSettings(
            coreBaseUrl = connection.privateUrl,
            tunnelBaseUrl = connection.tunnelUrl,
            connectionMode = connection.mode,
            characterName = normalizeCharacterName(
                prefs.getString(KEY_CHARACTER_NAME, DEFAULT_CHARACTER_NAME).orEmpty()
            ),
            activeModelId = normalizeModelId(prefs.getString(KEY_ACTIVE_MODEL, "lily_jirai_kei").orEmpty()),
            activeLanguage = activeLanguage,
            speechInputProvider = normalizeSpeechProvider(prefs.getString(KEY_SPEECH_PROVIDER, "lily-core-host").orEmpty()),
            speechInputLanguage = normalizeSpeechLanguage(prefs.getString(KEY_SPEECH_LANGUAGE, "chat").orEmpty()),
            voiceRoute = normalizeVoiceRoute(prefs.getString(KEY_VOICE_ROUTE, "sovits").orEmpty()),
            voiceLanguage = normalizeVoiceLanguage(
                prefs.getString(KEY_VOICE_LANGUAGE, null) ?: if (activeLanguage == "en") "en" else "ja"
            ),
            addressTerm = normalizeAddressTerm(prefs.getString(KEY_ADDRESS_TERM, "darling").orEmpty()),
            japaneseVoiceProfile = normalizeJapaneseVoiceProfile(
                prefs.getString(KEY_JAPANESE_VOICE, "ja").orEmpty()
            ),
            englishVoiceProfile = prefs.getString(KEY_ENGLISH_VOICE, "zeta_en").orEmpty(),
            activeMood = prefs.getString(KEY_MOOD, "talk").orEmpty(),
            modelScaleMultiplier = clampScale(prefs.getFloat(KEY_MODEL_SCALE_MULTIPLIER, DEFAULT_MODEL_SCALE)),
            modelOffsetX = clampOffsetX(prefs.getFloat(KEY_MODEL_OFFSET_X, 0f)),
            modelOffsetY = clampOffsetY(prefs.getFloat(KEY_MODEL_OFFSET_Y, 0f)),
            defaultModelScaleMultiplier = clampScale(
                prefs.getFloat(KEY_DEFAULT_MODEL_SCALE_MULTIPLIER, DEFAULT_MODEL_SCALE)
            ),
            defaultModelOffsetX = clampOffsetX(prefs.getFloat(KEY_DEFAULT_MODEL_OFFSET_X, 0f)),
            defaultModelOffsetY = clampOffsetY(prefs.getFloat(KEY_DEFAULT_MODEL_OFFSET_Y, 0f)),
            presenceStatus = prefs.getString(KEY_PRESENCE_STATUS, "available").orEmpty(),
            presenceNote = prefs.getString(KEY_PRESENCE_NOTE, "").orEmpty(),
            voiceRepliesEnabled = prefs.getBoolean(KEY_VOICE_REPLIES_ENABLED, true),
            automaticPresenceEnabled = prefs.getBoolean(KEY_AUTOMATIC_PRESENCE_ENABLED, true),
            followEnabled = prefs.getBoolean(KEY_FOLLOW_ENABLED, true),
            notificationsEnabled = prefs.getBoolean(KEY_NOTIFICATIONS_ENABLED, true),
            biometricLockEnabled = prefs.getBoolean(KEY_BIOMETRIC_LOCK_ENABLED, false),
            darkModeEnabled = prefs.getBoolean(KEY_DARK_MODE_ENABLED, false),
            deliveryTarget = deliveryTarget,
            ownerApiToken = secureTokenStore.load(),
        )
    }

    fun saveBaseUrl(value: String) {
        val normalized = MobileRealmApi.normalizeBaseUrl(value)
        prefs.edit().putString(KEY_BASE_URL, normalized).putString(KEY_PRIVATE_URL, normalized).apply()
    }

    fun saveConnectionConfig(value: CoreConnectionConfig) {
        prefs.edit().putString(KEY_BASE_URL, value.privateUrl).putString(KEY_PRIVATE_URL, value.privateUrl)
            .putString(KEY_TUNNEL_URL, value.tunnelUrl).putString(KEY_CONNECTION_MODE, value.mode).apply()
    }

    fun saveCharacterName(value: String): String {
        val normalized = normalizeCharacterName(value)
        prefs.edit().putString(KEY_CHARACTER_NAME, normalized).apply()
        return normalized
    }

    fun saveLanguage(value: String) {
        prefs.edit().putString(KEY_LANGUAGE, normalizeLanguage(value)).apply()
    }

    fun saveVoiceLanguage(value: String) {
        prefs.edit().putString(KEY_VOICE_LANGUAGE, normalizeVoiceLanguage(value)).apply()
    }

    fun saveAddressTerm(value: String) {
        prefs.edit().putString(KEY_ADDRESS_TERM, normalizeAddressTerm(value)).apply()
    }

    fun saveVoiceRoute(value: String) {
        prefs.edit().putString(KEY_VOICE_ROUTE, normalizeVoiceRoute(value)).apply()
    }

    fun saveSpeechInput(provider: String, language: String) {
        prefs.edit()
            .putString(KEY_SPEECH_PROVIDER, normalizeSpeechProvider(provider))
            .putString(KEY_SPEECH_LANGUAGE, normalizeSpeechLanguage(language))
            .apply()
    }

    private fun normalizeSpeechProvider(value: String) = if (value == "android") "android" else "lily-core-host"

    private fun normalizeSpeechLanguage(value: String) =
        value.takeIf { it in setOf("id", "en", "ja") } ?: "chat"

    fun saveActiveModelId(value: String) {
        prefs.edit().putString(KEY_ACTIVE_MODEL, normalizeModelId(value)).apply()
    }

    fun saveEnglishVoiceProfile(value: String) {
        prefs.edit().putString(KEY_ENGLISH_VOICE, value.trim()).apply()
    }

    fun saveJapaneseVoiceProfile(value: String) {
        prefs.edit().putString(KEY_JAPANESE_VOICE, normalizeJapaneseVoiceProfile(value)).apply()
    }

    fun saveMood(value: String) {
        prefs.edit().putString(KEY_MOOD, value.trim()).apply()
    }

    fun saveModelScaleMultiplier(value: Float) {
        prefs.edit()
            .putFloat(KEY_MODEL_SCALE_MULTIPLIER, clampScale(value))
            .apply()
    }

    fun saveModelOffset(x: Float, y: Float) {
        prefs.edit()
            .putFloat(KEY_MODEL_OFFSET_X, clampOffsetX(x))
            .putFloat(KEY_MODEL_OFFSET_Y, clampOffsetY(y))
            .apply()
    }

    fun saveDefaultModelTransform(scale: Float, offsetX: Float, offsetY: Float) {
        prefs.edit()
            .putFloat(KEY_DEFAULT_MODEL_SCALE_MULTIPLIER, clampScale(scale))
            .putFloat(KEY_DEFAULT_MODEL_OFFSET_X, clampOffsetX(offsetX))
            .putFloat(KEY_DEFAULT_MODEL_OFFSET_Y, clampOffsetY(offsetY))
            .apply()
    }

    fun savePresence(status: String, note: String) {
        prefs.edit()
            .putString(KEY_PRESENCE_STATUS, status.trim())
            .putString(KEY_PRESENCE_NOTE, note)
            .apply()
    }

    fun saveVoiceRepliesEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_VOICE_REPLIES_ENABLED, enabled).apply()
    }

    fun saveAutomaticPresenceEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_AUTOMATIC_PRESENCE_ENABLED, enabled).apply()
    }

    fun saveFollowEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_FOLLOW_ENABLED, enabled).apply()
    }

    fun saveNotificationsEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFICATIONS_ENABLED, enabled).apply()
    }

    fun saveBiometricLockEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_BIOMETRIC_LOCK_ENABLED, enabled).apply()
    }

    fun saveDarkModeEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_DARK_MODE_ENABLED, enabled).apply()
    }

    fun saveOwnerApiToken(value: String) {
        secureTokenStore.save(value)
    }

    private fun clampScale(value: Float): Float = value.coerceIn(MIN_MODEL_SCALE, MAX_MODEL_SCALE)

    private fun clampOffsetX(value: Float): Float = value.coerceIn(-MAX_MODEL_OFFSET_X, MAX_MODEL_OFFSET_X)

    private fun clampOffsetY(value: Float): Float = value.coerceIn(MIN_MODEL_OFFSET_Y, MAX_MODEL_OFFSET_Y)

    private fun normalizeLanguage(value: String): String =
        when (value.trim().lowercase()) {
            "en", "english" -> "en"
            "id", "in", "indo", "indonesian", "bahasa indonesia" -> "id"
            else -> "ja"
        }

    private fun normalizeVoiceLanguage(value: String): String =
        when (value.trim().lowercase()) {
            "id", "in", "indo", "indonesian", "bahasa indonesia" -> "id"
            "en", "english" -> "en"
            else -> "ja"
        }

    private fun normalizeAddressTerm(value: String): String =
        when (value.trim().lowercase()) {
            "sayang", "cintaku", "beb", "love", "darling", "dear", "anata", "kimi" -> value.trim().lowercase()
            else -> "darling"
        }

    private fun normalizeVoiceRoute(value: String): String =
        when (value.trim().lowercase()) {
            "sovits2" -> "sovits2"
            "rvc" -> "rvc"
            "alibaba", "qwen", "qwen_tts" -> "alibaba"
            else -> "sovits"
        }

    private fun normalizeModelId(value: String): String =
        when (value.trim().lowercase()) {
            "lily_maid_pink" -> "lily_maid_pink"
            else -> "lily_jirai_kei"
        }

    private fun normalizeJapaneseVoiceProfile(value: String): String =
        when (value.trim().lowercase()) {
            "kokomi_ja" -> "kokomi_ja"
            else -> "ja"
        }

    private fun normalizeCharacterName(value: String): String =
        value
            .replace(CharacterNameControls, "")
            .replace(CharacterNameWhitespace, " ")
            .trim()
            .take(MAX_CHARACTER_NAME_LENGTH)
            .trim()
            .ifBlank { DEFAULT_CHARACTER_NAME }

    companion object {
        private const val KEY_SPEECH_PROVIDER = "speech_input_provider"
        private const val KEY_SPEECH_LANGUAGE = "speech_input_language"
        private const val KEY_BASE_URL = "core_base_url"
        private const val KEY_PRIVATE_URL = "private_core_url"
        private const val KEY_TUNNEL_URL = "tunnel_core_url"
        private const val KEY_CONNECTION_MODE = "connection_mode"
        private const val KEY_CHARACTER_NAME = "character_name"
        private const val KEY_ACTIVE_MODEL = "active_model_id"
        private const val KEY_LANGUAGE = "active_language"
        private const val KEY_VOICE_ROUTE = "voice_route"
        private const val KEY_VOICE_LANGUAGE = "voice_output_language"
        private const val KEY_ADDRESS_TERM = "address_term"
        private const val KEY_JAPANESE_VOICE = "japanese_voice_profile"
        private const val KEY_ENGLISH_VOICE = "english_voice_profile"
        private const val KEY_MOOD = "active_mood"
        private const val KEY_MODEL_SCALE_MULTIPLIER = "model_scale_multiplier"
        private const val KEY_MODEL_OFFSET_X = "model_offset_x"
        private const val KEY_MODEL_OFFSET_Y = "model_offset_y"
        private const val KEY_DEFAULT_MODEL_SCALE_MULTIPLIER = "default_model_scale_multiplier"
        private const val KEY_DEFAULT_MODEL_OFFSET_X = "default_model_offset_x"
        private const val KEY_DEFAULT_MODEL_OFFSET_Y = "default_model_offset_y"
        private const val KEY_PRESENCE_STATUS = "presence_status"
        private const val KEY_PRESENCE_NOTE = "presence_note"
        private const val KEY_VOICE_REPLIES_ENABLED = "voice_replies_enabled"
        private const val KEY_AUTOMATIC_PRESENCE_ENABLED = "automatic_presence_enabled"
        private const val KEY_FOLLOW_ENABLED = "follow_enabled"
        private const val KEY_NOTIFICATIONS_ENABLED = "notifications_enabled"
        private const val KEY_BIOMETRIC_LOCK_ENABLED = "biometric_lock_enabled"
        private const val KEY_DARK_MODE_ENABLED = "dark_mode_enabled"
        private const val KEY_DELIVERY_TARGET = "delivery_target"
    }
}
