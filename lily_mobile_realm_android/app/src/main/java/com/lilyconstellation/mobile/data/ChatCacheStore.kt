package com.lilyconstellation.mobile.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class CachedChatMessage(
    val id: String,
    val sender: String,
    val text: String,
    val timeLabel: String,
    val isRead: Boolean = false,
    val practice: PracticeFeedback? = null,
)

class ChatCacheStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun load(channel: String = "chat"): List<CachedChatMessage> = runCatching {
        json.decodeFromString<List<CachedChatMessage>>(prefs.getString(messageKey(channel), "[]").orEmpty())
    }.getOrDefault(emptyList())

    fun save(messages: List<CachedChatMessage>, channel: String = "chat") {
        val compact = messages
            .filter { it.text.isNotBlank() }
            .takeLast(MAX_MESSAGES)
        prefs.edit().putString(messageKey(channel), json.encodeToString(compact)).apply()
    }

    fun clear(channel: String = "chat") {
        prefs.edit().remove(messageKey(channel)).apply()
    }

    private fun messageKey(channel: String) = when (channel) {
        "practice_en", "practice_ja" -> "${KEY_MESSAGES}_$channel"
        else -> KEY_MESSAGES
    }

    private companion object {
        const val PREFERENCES_NAME = "lily_mobile_realm_cache"
        const val KEY_MESSAGES = "recent_chat"
        const val MAX_MESSAGES = 40
    }
}
