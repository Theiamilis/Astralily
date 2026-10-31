package com.lilyconstellation.mobile.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class WaReminder(val dueAt: Long = 0, val note: String = "", val status: String = "scheduled")

@Serializable
data class WaInboxItem(
    val id: String,
    val name: String = "Contact",
    val phoneNumber: String = "",
    val summary: String = "",
    val message: String = "",
    val createdAt: String = "",
    val category: String = "uncertain",
    val policyReason: String = "",
    val triageMode: String = "shadow",
    val needsOwner: Boolean = false,
    val secretaryReply: String = "",
    val status: String = "pending",
    val reminder: WaReminder? = null,
    val notificationStatus: Map<String, String> = emptyMap(),
    val notificationPending: Boolean = false,
)

@Serializable
data class WaInboxResponse(val items: List<WaInboxItem> = emptyList())

@Serializable
data class WaInboxAction(
    val id: String,
    @SerialName("due_at") val dueAt: String = "",
    val note: String = "",
    val category: String? = null,
)

@Serializable
data class WaOwnerNotice(
    val id: String, val itemId: String = "", val title: String = "Lily Inbox",
    val text: String = "", val createdAt: String = "", val kind: String = "message",
)

@Serializable
data class WaNoticesResponse(val items: List<WaOwnerNotice> = emptyList())
