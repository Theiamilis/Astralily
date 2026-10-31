package com.lilyconstellation.mobile.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class LanguagePracticeTest {
    @Test fun practiceHistoriesNeverReuseNormalOrOtherLanguageSession() {
        assertEquals("phone", PracticeSession.id("phone", "off"))
        assertEquals("phone_practice_ja", PracticeSession.id("phone", "ja"))
        assertNotEquals(PracticeSession.id("phone", "ja"), PracticeSession.id("phone", "en"))
        assertEquals("chat", PracticeSession.channel("invalid"))
        assertEquals("practice_ja", PracticeSession.channel("ja"))
    }

    @Test fun notesDecodeAlongsideOtherMetadataWithoutChangingReply() {
        val metadata = Json.parseToJsonElement("""{"voice_route":"sovits","language_practice":{"language":"ja","feedback":"correct","reply":"こんにちは","translation":"Halo","romaji":"Konnichiwa","level":"beginner"}}""").jsonObject
        val feedback = PracticeFeedback.fromMetadata(metadata)
        assertNotNull(feedback)
        assertEquals("Halo", feedback!!.translation)
        assertEquals("Konnichiwa", feedback.romaji)
        assertEquals("", feedback.correction)
    }

    @Test fun malformedNotesDoNotBreakNormalChat() {
        assertNull(PracticeFeedback.fromMetadata(null))
        assertNull(PracticeFeedback.fromMetadata(Json.parseToJsonElement("""{"language_practice":[]} """).jsonObject))
        assertNull(PracticeFeedback.fromMetadata(Json.parseToJsonElement("""{"language_practice":{"language":"id","feedback":"correct"}}""").jsonObject))
    }
}
