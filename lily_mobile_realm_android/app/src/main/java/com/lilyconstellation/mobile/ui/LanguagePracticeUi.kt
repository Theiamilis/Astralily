package com.lilyconstellation.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lilyconstellation.mobile.data.PracticeFeedback

internal fun conversationStyleLabel(level: String): String =
    if (level == "intermediate") "Expressive" else "Casual"

@Composable
internal fun LanguagePracticeControls(
    state: PocketRealmUiState,
    onSelect: (String, String) -> Unit,
) {
    val enabled = !state.isReplyPending && !state.isVoiceRecording &&
        !state.isTranscribingVoice && !state.isClearingHistory
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Conversation mode", fontWeight = FontWeight.SemiBold)
        Text("Keep the conversation flowing in Japanese or English, with helpful suggestions along the way.", fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("off" to "Off", "ja" to "Japanese", "en" to "English").forEach { (id, label) ->
                FilterChip(
                    selected = state.practiceLanguage == id,
                    onClick = { onSelect(id, state.practiceLevel) },
                    label = { Text(label) }, enabled = enabled,
                )
            }
        }
        if (state.isPracticing) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("beginner", "intermediate").forEach { id ->
                    FilterChip(
                        selected = state.practiceLevel == id,
                        onClick = { onSelect(state.practiceLanguage, id) },
                        label = { Text(conversationStyleLabel(id)) }, enabled = enabled,
                    )
                }
            }
            Text(
                "Open Chat to begin. Casual keeps things simple; Expressive uses richer phrasing. Mic and voice follow your selected language.",
                fontSize = 12.sp,
            )
            Text("Notes include Indonesian translations and Japanese romaji. This mode keeps a separate history; device commands are unavailable. Suggestions use your text or transcript, without pronunciation scoring.", fontSize = 12.sp)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LanguagePracticeNotes(messageId: String, feedback: PracticeFeedback) {
    var notesVisible by remember(messageId) { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            when (feedback.feedback) {
                "improve" -> "Try this"
                "clarify" -> "Let's clarify"
                else -> "Looks natural"
            },
            fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
        )
        if (feedback.correction.isNotBlank()) Text(feedback.correction, fontSize = 13.sp)
        TextButton(onClick = { notesVisible = !notesVisible }) {
            Text(if (notesVisible) "Hide notes" else "Notes", fontSize = 12.sp)
        }
    }
    if (notesVisible) {
        ModalBottomSheet(onDismissRequest = { notesVisible = false }) {
            Column(
                modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp)
                    .verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Notes", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = { notesVisible = false }) { Text("Close") }
                }
                if (feedback.correction.isNotBlank()) {
                    Text("Suggested sentence", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Text(feedback.correction, fontSize = 16.sp)
                }
                if (feedback.explanation.isNotBlank()) {
                    Text(feedback.explanation, fontSize = 12.sp)
                }
                if (feedback.translation.isNotBlank()) {
                    Text("Reply translation", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text(feedback.translation, fontSize = 13.sp)
                }
                if (feedback.romaji.isNotBlank()) {
                    Text("Reply romaji", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text(feedback.romaji, fontSize = 13.sp)
                }
            }
        }
    }
}
