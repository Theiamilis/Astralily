package com.lilyconstellation.mobile.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

@Serializable
data class LanguagePracticeOptions(val language: String, val level: String = "beginner")

@Serializable
data class PracticeFeedback(
    val language: String = "",
    val feedback: String = "",
    val correction: String = "",
    val explanation: String = "",
    val translation: String = "",
    val romaji: String = "",
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun fromMetadata(metadata: JsonObject?): PracticeFeedback? = runCatching {
            val value = metadata?.get("language_practice") ?: return null
            json.decodeFromString<PracticeFeedback>(value.toString()).takeIf {
                it.language in setOf("en", "ja") && it.feedback in setOf("correct", "improve", "clarify")
            }
        }.getOrNull()
    }
}

object PracticeSession {
    fun isActive(language: String) = language == "en" || language == "ja"
    fun channel(language: String) = if (isActive(language)) "practice_$language" else "chat"
    fun id(deviceTarget: String, language: String) =
        if (isActive(language)) "${deviceTarget}_practice_$language" else deviceTarget
}
