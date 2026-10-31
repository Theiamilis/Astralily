package com.lilyconstellation.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

const val DEFAULT_CORE_BASE_URL = "http://lily-core-host:8000"
private const val DEFAULT_CORE_PORT = 8000

@Serializable
data class OwnerPresencePayload(
    val status: String = "available",
    val label: String? = null,
    val note: String? = null,
    val source: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    val active: Boolean? = null,
    val automatic: Boolean? = null,
    val confidence: String? = null,
    @SerialName("signal_age_seconds") val signalAgeSeconds: Int? = null,
)

@Serializable
data class OwnerMoodPayload(
    val mood: String = "calm",
    val intensity: Int = 0,
    val expression: String = "Neutral",
    @SerialName("updated_at") val updatedAt: Double? = null,
)

@Serializable
data class ComponentSnapshot(
    val status: String? = null,
    val detail: String? = null,
    val provider: String? = null,
)

@Serializable
data class HealthResponse(
    val status: String? = null,
    val components: Map<String, ComponentSnapshot> = emptyMap(),
    @SerialName("owner_presence") val ownerPresence: OwnerPresencePayload? = null,
    @SerialName("owner_mood") val ownerMood: OwnerMoodPayload? = null,
    @SerialName("owner_runtime") val ownerRuntime: OwnerRuntimePayload? = null,
)

@Serializable
data class VoiceRouteCapability(
    val label: String = "",
    val detail: String = "",
    val languages: List<String> = emptyList(),
    @SerialName("supports_emotion") val supportsEmotion: Boolean = false,
    @SerialName("supports_romanji") val supportsRomanji: Boolean = false,
    @SerialName("emotion_mode") val emotionMode: String = "metadata_only",
    @SerialName("style_mode") val styleMode: String = "metadata_only",
    val strict: Boolean = false,
)

@Serializable
data class SttVadCapability(
    val enabled: Boolean = false,
    val mode: String = "",
    @SerialName("silence_ms") val silenceMs: Int = 0,
    @SerialName("start_timeout_ms") val startTimeoutMs: Int = 0,
)

@Serializable
data class SttCapability(
    val languages: List<String> = emptyList(),
    val states: List<String> = emptyList(),
    @SerialName("error_codes") val errorCodes: List<String> = emptyList(),
    val vad: SttVadCapability = SttVadCapability(),
)

@Serializable
data class VoiceContractCapability(
    @SerialName("request_fields") val requestFields: List<String> = emptyList(),
    @SerialName("metadata_fields") val metadataFields: List<String> = emptyList(),
    @SerialName("strict_routes") val strictRoutes: List<String> = emptyList(),
)

@Serializable
data class AddressTermOption(
    val id: String,
    val label: String,
    val spoken: String,
    val detail: String = "",
    val romaji: String = "",
)

@Serializable
data class SystemCapabilitiesResponse(
    @SerialName("schema_version") val schemaVersion: Int = 1,
    @SerialName("voice_routes") val voiceRoutes: Map<String, VoiceRouteCapability> = emptyMap(),
    val stt: SttCapability = SttCapability(),
    @SerialName("voice_contract") val voiceContract: VoiceContractCapability = VoiceContractCapability(),
    @SerialName("address_terms") val addressTerms: Map<String, List<AddressTermOption>> = emptyMap(),
)

@Serializable
data class OwnerPresenceEnvelope(
    val ok: Boolean = true,
    @SerialName("owner_presence") val ownerPresence: OwnerPresencePayload,
)

@Serializable
data class OwnerPresenceRequestPayload(
    val status: String,
    val label: String? = null,
    val note: String? = null,
    val source: String = "mobile_realm",
    @SerialName("ttl_minutes") val ttlMinutes: Int? = null,
)

@Serializable
data class MobileRealmContextPayload(
    val interfaceName: String = "lily_mobile_realm_android",
    val chatMode: String = "Lily Constellation",
    @SerialName("character_name") val characterName: String = "Lily",
    val language: String,
    @SerialName("language_label") val languageLabel: String,
    @SerialName("language_prompt_hint") val languagePromptHint: String,
    @SerialName("voice_route") val voiceRoute: String = "sovits",
    @SerialName("voice_language") val voiceLanguage: String,
    @SerialName("voice_profile") val voiceProfile: String,
    @SerialName("translate_voice_output") val translateVoiceOutput: Boolean = false,
    @SerialName("language_practice") val languagePractice: LanguagePracticeOptions? = null,
    @SerialName("address_term") val addressTerm: String = "darling",
    @SerialName("ui_mood") val uiMood: String,
    @SerialName("ui_mood_label") val uiMoodLabel: String,
    @SerialName("prompt_hint") val promptHint: String,
    @SerialName("owner_presence") val ownerPresence: OwnerPresencePayload? = null,
) {
    @SerialName("interface")
    val interfaceAlias: String = interfaceName

    @SerialName("chat_mode")
    val chatModeAlias: String = chatMode
}

@Serializable
data class MobileRealmIngestPayload(
    val message: String,
    @SerialName("want_voice") val wantVoice: Boolean = true,
    @SerialName("want_subtitle") val wantSubtitle: Boolean = true,
    @SerialName("delivery_channel") val deliveryChannel: String = "wa",
    @SerialName("delivery_target") val deliveryTarget: String = "owner",
    val context: MobileRealmContextPayload,
    @SerialName("owner_presence") val ownerPresence: OwnerPresencePayload? = null,
)

@Serializable
data class MobileRealmIngestRequest(
    @SerialName("trace_id") val traceId: String? = null,
    val source: String = "mobile_realm",
    @SerialName("session_id") val sessionId: String,
    val mode: String = "owner_chat",
    val payload: MobileRealmIngestPayload,
)

@Serializable
data class CoreResultPayload(
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("reply_target") val replyTarget: String = "",
    val text: String? = null,
    val subtitle: String? = null,
    val emotion: String? = null,
    val expression: String? = null,
    @SerialName("audio_url") val audioUrl: String? = null,
    val metadata: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class IngestEnvelope(
    val ok: Boolean = true,
    @SerialName("trace_id") val traceId: String? = null,
    val priority: Int? = null,
    val result: CoreResultPayload? = null,
)

@Serializable
data class SessionResetResponse(
    val ok: Boolean = false,
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("cleared_event_count") val clearedEventCount: Int = 0,
    @SerialName("session_preserved") val sessionPreserved: Boolean = true,
)

@Serializable
data class OwnerActivityRequestPayload(
    val activity: String = "app_foreground",
    val source: String = "mobile_realm",
    @SerialName("device_id") val deviceId: String,
    val confidence: String = "medium",
)

@Serializable
data class OwnerActivityEnvelope(
    val ok: Boolean = true,
    @SerialName("owner_presence") val ownerPresence: OwnerPresencePayload,
)

@Serializable
data class OwnerRoutine(
    val id: String,
    val label: String,
    val time: String,
    val days: List<Int> = emptyList(),
    val enabled: Boolean = true,
    val message: String = "",
)

@Serializable
data class OwnerRoutineEnvelope(
    val ok: Boolean = true,
    val enabled: Boolean = true,
    val timezone: String = "Asia/Jakarta",
    val items: List<OwnerRoutine> = emptyList(),
    @SerialName("next_routine_id") val nextRoutineId: String? = null,
    @SerialName("next_routine_at") val nextRoutineAt: String? = null,
    @SerialName("delivery_summary") val deliverySummary: OwnerRoutineDeliverySummary = OwnerRoutineDeliverySummary(),
    @SerialName("recent_deliveries") val recentDeliveries: List<OwnerRoutineDelivery> = emptyList(),
)

@Serializable
data class OwnerRoutineDeliverySummary(
    val pending: Int = 0,
    val leased: Int = 0,
    val failed: Int = 0,
    val sent: Int = 0,
    val abandoned: Int = 0,
)

@Serializable
data class OwnerRoutineDelivery(
    val id: String = "",
    @SerialName("routine_id") val routineId: String = "",
    val status: String = "unknown",
    val attempts: Int = 0,
    @SerialName("last_error") val lLily-Voice-Hostror: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("sent_at") val sentAt: String? = null,
    @SerialName("next_attempt_at") val nextAttemptAt: String? = null,
)

@Serializable
data class OwnerActivitySnapshot(
    val activity: String = "unknown",
    val source: String = "unknown",
    val confidence: String = "low",
    @SerialName("observed_at") val observedAt: String? = null,
    @SerialName("age_seconds") val ageSeconds: Int? = null,
)

@Serializable
data class WaRuntimeProfile(
    val profile: String = "",
    val ready: Boolean = false,
    val online: Boolean = false,
    val status: String = "unknown",
    @SerialName("client_state") val clientState: String = "unknown",
    @SerialName("last_seen_at") val lastSeenAt: String? = null,
    @SerialName("age_seconds") val ageSeconds: Int? = null,
    @SerialName("routine_delivery") val routineDelivery: OwnerRoutineDelivery? = null,
)

@Serializable
data class OwnerRuntimePayload(
    @SerialName("generated_at") val generatedAt: String? = null,
    @SerialName("owner_activity") val ownerActivity: OwnerActivitySnapshot = OwnerActivitySnapshot(),
    @SerialName("wa_profiles") val waProfiles: Map<String, WaRuntimeProfile> = emptyMap(),
    val routines: OwnerRoutineEnvelope = OwnerRoutineEnvelope(),
)

@Serializable
data class OwnerRoutineToggleRequest(val enabled: Boolean)

@Serializable
data class ChatHistoryRow(
    @SerialName("user_message") val userMessage: String = "",
    @SerialName("bot_response") val botResponse: String = "",
    val timestamp: String? = null,
    @SerialName("language_practice") val practice: PracticeFeedback? = null,
)

@Serializable
data class ToolArtifact(
    val id: String = "",
    val name: String = "",
    val kind: String = "",
    @SerialName("mime_type") val mimeType: String = "",
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    val sha256: String = "",
    @SerialName("download_url") val downloadUrl: String = "",
)

@Serializable
data class ToolTask(
    val id: String = "",
    val action: String = "",
    val task: String = "",
    val source: String = "",
    val status: String = "",
    val risk: String = "",
    val requester: String = "",
    @SerialName("session_id") val sessionId: String = "",
    val error: String = "",
    @SerialName("result_text") val resultText: String = "",
    @SerialName("requires_approval") val requiresApproval: Boolean = false,
    @SerialName("created_at_iso") val createdAtIso: String = "",
    @SerialName("approved_at_iso") val approvedAtIso: String = "",
    @SerialName("completed_at_iso") val completedAtIso: String = "",
    @SerialName("delivered_at_iso") val deliveredAtIso: String = "",
    @SerialName("tool_provider") val toolProvider: String = "",
    @SerialName("requested_provider") val requestedProvider: String = "",
    @SerialName("fallback_used") val fallbackUsed: Boolean = false,
    @SerialName("provider_attempts") val providerAttempts: List<JsonObject> = emptyList(),
    @SerialName("delivery_channel") val deliveryChannel: String = "",
    @SerialName("delivery_target") val deliveryTarget: String = "",
    @SerialName("delivery_profile") val deliveryProfile: String = "",
    @SerialName("delivery_status") val deliveryStatus: String = "",
    @SerialName("delivery_claimed_at") val deliveryClaimedAt: Double? = null,
    @SerialName("delivery_error") val deliveryError: String = "",
    @SerialName("delivery_attempt_count") val deliveryAttemptCount: Int = 0,
    @SerialName("delivery_latency_ms") val deliveryLatencyMs: Long? = null,
    @SerialName("approval_expires_at_iso") val approvalExpiresAtIso: String = "",
    @SerialName("progress_percent") val progressPercent: Int = 0,
    @SerialName("progress_message") val progressMessage: String = "",
    @SerialName("estimated_duration_seconds") val estimatedDurationSeconds: Int = 0,
    @SerialName("elapsed_seconds") val elapsedSeconds: Int = 0,
    @SerialName("execution_started_at_iso") val executionStartedAtIso: String = "",
    @SerialName("execution_completed_at_iso") val executionCompletedAtIso: String = "",
    @SerialName("execution_latency_ms") val executionLatencyMs: Long? = null,
    @SerialName("retry_count") val retryCount: Int = 0,
    @SerialName("recovery_required") val recoveryRequired: Boolean = false,
    @SerialName("updated_at_iso") val updatedAtIso: String = "",
    @SerialName("input_files") val inputFiles: List<ToolArtifact> = emptyList(),
    val artifacts: List<ToolArtifact> = emptyList(),
)

@Serializable
data class ToolListEnvelope(
    val ok: Boolean = true,
    val items: List<ToolTask> = emptyList(),
)

@Serializable
data class ToolMutationRequest(
    val approver: String = "owner",
    val reason: String = "",
    @SerialName("idempotency_key") val idempotencyKey: String = "",
)

@Serializable
data class ToolRetryRequest(
    val kind: String = "execution",
    @SerialName("idempotency_key") val idempotencyKey: String = "",
)

@Serializable
data class ToolMutationResponse(
    val ok: Boolean = true,
    val status: String = "",
    val detail: String = "",
    val task: ToolTask? = null,
)

@Serializable
data class ToolMaintenance(
    @SerialName("artifact_count") val artifactCount: Int = 0,
    @SerialName("artifact_bytes") val artifactBytes: Long = 0,
    @SerialName("quota_bytes") val quotaBytes: Long = 0,
    @SerialName("quota_used_percent") val quotaUsedPercent: Double = 0.0,
    @SerialName("retention_days") val retentionDays: Int = 0,
    @SerialName("prunable_count") val prunableCount: Int = 0,
    @SerialName("last_prune_at_iso") val lastPruneAtIso: String = "",
)

@Serializable
data class ToolMaintenanceResponse(
    val ok: Boolean = true,
    @SerialName("candidate_count") val candidateCount: Int = 0,
    @SerialName("deleted_count") val deletedCount: Int = 0,
    @SerialName("deleted_bytes") val deletedBytes: Long = 0,
    val maintenance: ToolMaintenance = ToolMaintenance(),
)

@Serializable
data class SttSegment(
    val start: Double = 0.0,
    val end: Double = 0.0,
    val text: String = "",
)

@Serializable
data class SttTranscriptionResponse(
    val text: String = "",
    val language: String = "",
    @SerialName("duration_seconds") val durationSeconds: Double = 0.0,
    val model: String = "",
    val segments: List<SttSegment> = emptyList(),
)

@Serializable
data class HomeDevice(
    val id: String,
    val provider: String = "",
    val kind: String = "device",
    val name: String,
    val room: String = "",
    val aliases: List<String> = emptyList(),
)

@Serializable
data class HomeDeviceList(val devices: List<HomeDevice> = emptyList())

@Serializable
data class HomeDeviceState(
    @SerialName("device_id") val deviceId: String,
    val provider: String = "",
    val online: Boolean = false,
    val state: Boolean? = null,
    val brightness: Int? = null,
    @SerialName("temperature_kelvin") val temperatureKelvin: Int? = null,
    val rgb: List<Int>? = null,
    @SerialName("scene_id") val sceneId: Int? = null,
)

@Serializable
data class HomeControlRequest(
    val state: String? = null,
    val brightness: Int? = null,
    @SerialName("temperature_kelvin") val temperatureKelvin: Int? = null,
    val rgb: List<Int>? = null,
    @SerialName("scene_id") val sceneId: Int? = null,
    val speed: Int? = null,
    @SerialName("dry_run") val dryRun: Boolean = false,
)

@Serializable
data class HomeControlResponse(
    val ok: Boolean = false,
    @SerialName("device_id") val deviceId: String = "",
    val state: HomeDeviceState? = null,
)

@Serializable
data class HomeSceneAction(
    val device: String,
    val state: String? = null,
    val brightness: Int? = null,
    @SerialName("temperature_kelvin") val temperatureKelvin: Int? = null,
    val rgb: List<Int>? = null,
)

@Serializable
data class HomeScene(
    val id: String,
    val name: String,
    val aliases: List<String> = emptyList(),
    @SerialName("action_count") val actionCount: Int = 0,
    val source: String = "user",
    @SerialName("read_only") val readOnly: Boolean = false,
    val actions: List<HomeSceneAction> = emptyList(),
)

@Serializable
data class HomeSceneList(val scenes: List<HomeScene> = emptyList())

@Serializable
data class HomeSceneUpsertRequest(
    val name: String,
    val aliases: List<String> = emptyList(),
    val actions: List<HomeSceneAction>,
)

@Serializable
data class HomeSceneActivateRequest(@SerialName("dry_run") val dryRun: Boolean = false)

@Serializable
data class HomeSceneActivationResponse(
    val ok: Boolean = false,
    @SerialName("scene_id") val sceneId: String = "",
)

@Serializable
data class FamilyDevice(
    val id: String,
    val name: String,
    val platform: String = "Android",
    @SerialName("last_seen_at") val lastSeenAt: Double? = null,
    @SerialName("last_location_at") val lastLocationAt: Double? = null,
    @SerialName("location_accuracy_m") val locationAccuracyM: Double? = null,
    val online: Boolean = false,
    @SerialName("sharing_enabled") val sharingEnabled: Boolean = false,
    @SerialName("sms_permission") val smsPermission: Boolean = false,
    @SerialName("location_permission") val locationPermission: Boolean = false,
    @SerialName("location_mode") val locationMode: String = "paused",
    @SerialName("revoked_at") val revokedAt: Double? = null,
)

@Serializable
data class FamilyDeviceList(val devices: List<FamilyDevice> = emptyList())

@Serializable
data class FamilyInvitation(
    val id: String = "",
    @SerialName("invitation_token") val invitationToken: String = "",
    @SerialName("expires_at") val expiresAt: Double = 0.0,
)

@Serializable
data class FamilyPairingRequest(
    val id: String,
    val name: String,
    val platform: String = "Android",
    val status: String = "pending",
    @SerialName("expires_at") val expiresAt: Double = 0.0,
)

@Serializable
data class FamilyPairingEnvelope(val requests: List<FamilyPairingRequest> = emptyList())

@Serializable
data class FamilySmsItem(
    val id: Long = 0,
    val sender: String = "",
    val body: String = "",
    @SerialName("received_at") val receivedAt: Double = 0.0,
    @SerialName("sim_slot") val simSlot: Int? = null,
)

@Serializable
data class FamilySmsEnvelope(val items: List<FamilySmsItem> = emptyList())

@Serializable
data class FamilyLocationPoint(
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    @SerialName("accuracy_m") val accuracyM: Double = 0.0,
    @SerialName("captured_at") val capturedAt: Double = 0.0,
    val mode: String = "eco",
    val stale: Boolean = true,
)

@Serializable
data class FamilyLocationEnvelope(val location: FamilyLocationPoint? = null)

@Serializable
data class FamilyCommand(
    val id: String,
    val type: String = "",
    val payload: JsonObject = JsonObject(emptyMap()),
    val status: String = "pending",
    val error: String = "",
    @SerialName("updated_at") val updatedAt: Double? = null,
)

@Serializable
data class FamilyLocationModeRequest(val mode: String)

@Serializable
data class FinanceAccount(
    val name: String,
    val label: String = name,
    val balance: Long = 0,
    val currency: String = "IDR",
)

@Serializable
data class FinanceSummary(
    val month: String? = null,
    val income: Long = 0,
    val expense: Long = 0,
    @SerialName("transfer_in") val transferIn: Long = 0,
    @SerialName("transfer_out") val transferOut: Long = 0,
    val net: Long = 0,
    @SerialName("total_balance") val totalBalance: Long = 0,
    val accounts: List<FinanceAccount> = emptyList(),
    val currency: String = "IDR",
)

@Serializable
data class FinanceTransactionInput(
    val direction: String,
    val amount: Long,
    val account: String,
    @SerialName("to_account") val toAccount: String? = null,
    @SerialName("category_id") val categoryId: String? = null,
    val category: String = "uncategorized",
    val merchant: String? = null,
    val note: String = "",
    @SerialName("occurred_at") val occurredAt: String? = null,
    val currency: String? = null,
    @SerialName("attachment_ids") val attachmentIds: List<String> = emptyList(),
)

@Serializable
data class FinanceTransaction(
    val id: String = "",
    val direction: String,
    val amount: Long,
    val account: String,
    @SerialName("to_account") val toAccount: String? = null,
    val category: String = "uncategorized",
    val merchant: String? = null,
    val note: String = "",
    @SerialName("occurred_at") val occurredAt: String = "",
    @SerialName("created_at") val createdAt: String = "",
    val currency: String? = null,
)

@Serializable
data class FinanceTransactionList(val items: List<FinanceTransaction> = emptyList())

@Serializable
data class FinanceDraftCreateRequest(val transaction: FinanceTransactionInput)

@Serializable
data class FinanceDraft(
    val id: String,
    val transaction: FinanceTransactionInput,
    val source: String = "mobile",
    @SerialName("created_at") val createdAt: Double = 0.0,
    @SerialName("expires_at") val expiresAt: Double = 0.0,
    val status: String = "pending",
)

@Serializable
data class FinanceConfirmRequest(val confirmed: Boolean = true)

@Serializable
data class FinanceConfirmResponse(
    val ok: Boolean = false,
    val transaction: FinanceTransaction? = null,
)

@Serializable
data class FinanceReceiptResponse(
    val ok: Boolean = false,
    val confidence: Double = 0.0,
    @SerialName("needs_confirmation") val needsConfirmation: Boolean = false,
    val reason: String = "",
    val drafts: List<FinanceDraft> = emptyList(),
)

data class CoreStreamEvent(val id: Long, val type: String, val data: String)

data class SecretaryContactImportResult(val added: Int, val alreadyPresent: Int)

class MobileRealmApi(
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    },
    private val connectionManager: CoreConnectionManager? = null,
    private val pinnedRoute: CorePinnedRoute? = null,
) {
    @Volatile
    private var ownerApiToken: String = ""

    fun setOwnerApiToken(value: String) {
        ownerApiToken = value.trim()
    }

    @Synchronized
    private fun applyOwnerAuthorization(connection: HttpURLConnection, token: String = ownerApiToken) {
        token.takeIf { it.isNotBlank() }?.let {
            connection.setRequestProperty("Authorization", "Bearer $it")
        }
    }

    private val eventConnection = AtomicReference<HttpURLConnection?>(null)
    @Volatile var activeEventStreamBaseUrl: String? = null
        private set

    fun closeEventStream() {
        activeEventStreamBaseUrl = null
        eventConnection.getAndSet(null)?.disconnect()
    }

    private fun directConnection(url: String, method: String, token: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            instanceFollowRedirects = false
            applyOwnerAuthorization(this, token)
        }

    private fun openConnection(url: String, method: String): HttpURLConnection {
        val manager = connectionManager ?: return directConnection(url, method, ownerApiToken)
        val pinned = pinnedRoute ?: manager.pin()
        return directConnection(manager.resolveUrl(url, pinned), method, pinned.token)
    }

    private fun <T> readCoreGet(url: String, connectMillis: Int, readMillis: Int, accept: String, read: (HttpURLConnection) -> T): T {
        fun perform(resolved: String, token: String): T {
            val connection = directConnection(resolved, "GET", token).apply {
                connectTimeout = connectMillis
                readTimeout = readMillis
                setRequestProperty("Accept", accept)
            }
            return try { read(connection) } finally { connection.disconnect() }
        }
        if (pinnedRoute != null && connectionManager != null) return perform(connectionManager.resolveUrl(url, pinnedRoute), pinnedRoute.token)
        return connectionManager?.get(url, ::perform) ?: perform(url, ownerApiToken)
    }

    suspend fun getHealth(baseUrl: String): HealthResponse =
        getJson("${normalizeBaseUrl(baseUrl)}/health")

    suspend fun getWaInbox(baseUrl: String): WaInboxResponse =
        getJson("${normalizeBaseUrl(baseUrl)}/api/wa/review")

    suspend fun getWaNotices(baseUrl: String): WaNoticesResponse =
        getJson("${normalizeBaseUrl(baseUrl)}/api/wa/notifications")

    suspend fun updateWaInbox(baseUrl: String, action: String, body: WaInboxAction): JsonObject {
        require(action in setOf("resolve", "correct", "remind", "cancel-reminder"))
        return postJson("${normalizeBaseUrl(baseUrl)}/api/wa/review/$action", body)
    }

    suspend fun addSecretaryContacts(
        baseUrl: String,
        contacts: List<VCardPhoneContact>,
    ): SecretaryContactImportResult {
        require(contacts.isNotEmpty()) { "Choose at least one phone number from the VCF." }

        val endpoint = "${normalizeBaseUrl(baseUrl)}/api/wa/secretary/settings"
        val snapshot: JsonObject = getJson(endpoint)
        val revision = snapshot["revision"] as? JsonPrimitive
            ?: error("Secretary settings are missing their revision. Reload and try again.")
        val settings = snapshot["settings"] as? JsonObject
            ?: error("Secretary settings could not be read.")
        val existingContacts = settings["contacts"] as? JsonArray ?: JsonArray(emptyList())
        val existingNumbers = existingContacts.mapNotNull { entry ->
            ((entry as? JsonObject)?.get("number") as? JsonPrimitive)?.content?.let { number ->
                runCatching { normalizeSecretaryPhoneNumber(number) }.getOrNull()
            }
        }.toMutableSet()
        val additions = mutableListOf<JsonObject>()
        var alreadyPresent = 0

        contacts.forEach { contact ->
            val number = normalizeSecretaryPhoneNumber(contact.number)
            if (!existingNumbers.add(number)) {
                alreadyPresent += 1
            } else {
                additions += JsonObject(mapOf(
                    "number" to JsonPrimitive(number),
                    "label" to JsonPrimitive(contact.label.trim().take(80)),
                    "action" to JsonPrimitive("summary_only"),
                ))
            }
        }

        if (additions.isEmpty()) return SecretaryContactImportResult(added = 0, alreadyPresent = alreadyPresent)
        require(existingContacts.size + additions.size <= 300) {
            "Secretary already has 300 contact rules. Remove a rule before importing more."
        }

        val updatedSettings = JsonObject(settings.toMutableMap().apply {
            put("contacts", JsonArray(existingContacts + additions))
        })
        postJson<JsonObject, JsonObject>(endpoint, JsonObject(mapOf(
            "revision" to revision,
            "settings" to updatedSettings,
        )))
        return SecretaryContactImportResult(added = additions.size, alreadyPresent = alreadyPresent)
    }

    private fun normalizeSecretaryPhoneNumber(value: String): String {
        require(value.isNotBlank() && value.all { it == '+' || it.isDigit() || it.isWhitespace() || it in "().-" }) {
            "Choose a phone number rather than a contact ID."
        }
        var digits = value.filter(Char::isDigit)
        if (digits.startsWith("00")) digits = digits.drop(2)
        if (digits.startsWith("0")) digits = "62${digits.drop(1)}"
        require(digits.length in 8..16) { "Phone number must contain 8–16 digits." }
        return digits
    }

    suspend fun getOwnerPresence(baseUrl: String): OwnerPresenceEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/presence")

    suspend fun setOwnerPresence(baseUrl: String, payload: OwnerPresencePayload, ttlMinutes: Int?): OwnerPresenceEnvelope {
        val body = OwnerPresenceRequestPayload(
            status = payload.status,
            label = payload.label,
            note = payload.note,
            source = payload.source ?: "mobile_realm",
            ttlMinutes = ttlMinutes,
        )
        return postJson("${normalizeBaseUrl(baseUrl)}/api/owner/presence", body)
    }

    suspend fun reportOwnerActivity(
        baseUrl: String,
        deviceId: String,
        activity: String = "app_foreground",
        confidence: String = "medium",
    ): OwnerActivityEnvelope =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/owner/activity",
            OwnerActivityRequestPayload(
                activity = activity,
                deviceId = deviceId,
                confidence = confidence,
            ),
        )

    suspend fun getOwnerRoutines(baseUrl: String): OwnerRoutineEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/routines")

    suspend fun setOwnerRoutinesEnabled(baseUrl: String, enabled: Boolean): OwnerRoutineEnvelope =
        putJson(
            "${normalizeBaseUrl(baseUrl)}/api/owner/routines",
            OwnerRoutineToggleRequest(enabled),
        )

    suspend fun setOwnerRoutineEnabled(baseUrl: String, routineId: String, enabled: Boolean): OwnerRoutineEnvelope =
        putJson(
            "${normalizeBaseUrl(baseUrl)}/api/owner/routines/${encodePath(routineId)}",
            OwnerRoutineToggleRequest(enabled),
        )

    suspend fun ingest(baseUrl: String, request: MobileRealmIngestRequest): IngestEnvelope =
        postJson("${normalizeBaseUrl(baseUrl)}/api/core/ingest", request)

    suspend fun getSystemCapabilities(baseUrl: String): SystemCapabilitiesResponse =
        getJson("${normalizeBaseUrl(baseUrl)}/api/system/capabilities")

    suspend fun getChatHistory(baseUrl: String, userId: String, limit: Int = 16): List<ChatHistoryRow> {
        val encodedUserId = encodePath(userId.trim())
        val normalizedLimit = limit.coerceIn(1, 200)
        return getJson(
            "${normalizeBaseUrl(baseUrl)}/api/history?user_id=$encodedUserId&limit=$normalizedLimit"
        )
    }

    suspend fun resetSessionConversation(baseUrl: String, sessionId: String): SessionResetResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/core/session/${encodePath(sessionId.trim())}/reset",
            JsonObject(emptyMap()),
        )

    suspend fun getOpenClawRequests(baseUrl: String, limit: Int = 20): ToolListEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/requests?limit=$limit")

    suspend fun approveTask(baseUrl: String, taskId: String, idempotencyKey: String): ToolMutationResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/$taskId/approve",
            ToolMutationRequest(idempotencyKey = idempotencyKey),
        )

    suspend fun denyTask(baseUrl: String, taskId: String, idempotencyKey: String): ToolMutationResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/$taskId/deny",
            ToolMutationRequest(reason = "Denied from Lily Constellation.", idempotencyKey = idempotencyKey),
        )

    suspend fun cancelTask(baseUrl: String, taskId: String): ToolMutationResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/$taskId/cancel",
            ToolMutationRequest(reason = "Cancelled from Lily Constellation."),
        )

    suspend fun retryTask(baseUrl: String, taskId: String, kind: String, idempotencyKey: String): ToolMutationResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/$taskId/retry",
            ToolRetryRequest(kind = kind, idempotencyKey = idempotencyKey),
        )

    suspend fun getToolMaintenance(baseUrl: String): ToolMaintenance =
        getJson("${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/maintenance")

    suspend fun pruneToolArtifacts(baseUrl: String, dryRun: Boolean = false): ToolMaintenanceResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/maintenance/prune",
            JsonObject(mapOf("dry_run" to JsonPrimitive(dryRun))),
        )

    suspend fun downloadArtifact(baseUrl: String, taskId: String, artifactId: String): ByteArray =
        withContext(Dispatchers.IO) {
            readCoreGet("${normalizeBaseUrl(baseUrl)}/api/tools/openclaw/${encodePath(taskId)}/artifacts/${encodePath(artifactId)}",
                10000, 75000, "application/octet-stream") { connection ->
                val status = connection.responseCode
                if (status !in 200..299) {
                    val detail = runCatching { readCompleteBytes(connection).toString(Charsets.UTF_8) }.getOrDefault("")
                    throw CoreHttpException(status, detail.ifBlank { "Artifact download failed with HTTP $status." })
                }
                readCompleteBytes(connection)
            }
        }

    suspend fun getHomeDevices(baseUrl: String): HomeDeviceList =
        getJson("${normalizeBaseUrl(baseUrl)}/api/home/devices")

    suspend fun getHomeState(baseUrl: String, deviceId: String): HomeDeviceState =
        getJson("${normalizeBaseUrl(baseUrl)}/api/home/devices/${encodePath(deviceId)}/state")

    suspend fun controlHomeDevice(baseUrl: String, deviceId: String, request: HomeControlRequest): HomeControlResponse =
        postJson("${normalizeBaseUrl(baseUrl)}/api/home/devices/${encodePath(deviceId)}/state", request)

    suspend fun getHomeScenes(baseUrl: String): HomeSceneList =
        getJson("${normalizeBaseUrl(baseUrl)}/api/home/scenes")

    suspend fun saveHomeScene(baseUrl: String, sceneId: String, request: HomeSceneUpsertRequest): HomeScene =
        putJson("${normalizeBaseUrl(baseUrl)}/api/home/scenes/${encodePath(sceneId)}", request)

    suspend fun deleteHomeScene(baseUrl: String, sceneId: String): JsonObject =
        deleteJson("${normalizeBaseUrl(baseUrl)}/api/home/scenes/${encodePath(sceneId)}")

    suspend fun activateHomeScene(baseUrl: String, sceneId: String): HomeSceneActivationResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/home/scenes/${encodePath(sceneId)}/activate",
            HomeSceneActivateRequest(),
        )

    suspend fun getFamilyDevices(baseUrl: String): FamilyDeviceList =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/devices")

    suspend fun createFamilyInvitation(baseUrl: String): FamilyInvitation =
        postEmptyJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/invitations")

    suspend fun getFamilyPairingRequests(baseUrl: String): FamilyPairingEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/pairing/requests")

    suspend fun decideFamilyPairing(baseUrl: String, requestId: String, approve: Boolean): JsonObject =
        postEmptyJson(
            "${normalizeBaseUrl(baseUrl)}/api/owner/family/pairing/requests/${encodePath(requestId)}/${if (approve) "approve" else "deny"}",
        )

    suspend fun getFamilySms(baseUrl: String, deviceId: String): FamilySmsEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/devices/${encodePath(deviceId)}/sms?limit=50")

    suspend fun getFamilyLocation(baseUrl: String, deviceId: String): FamilyLocationEnvelope =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/devices/${encodePath(deviceId)}/location")

    suspend fun getFamilyCommands(baseUrl: String, deviceId: String): List<FamilyCommand> =
        getJson("${normalizeBaseUrl(baseUrl)}/api/owner/family/devices/${encodePath(deviceId)}/commands")

    suspend fun requestFamilyLocationMode(baseUrl: String, deviceId: String, mode: String): FamilyCommand {
        require(mode in setOf("live", "eco"))
        return postJson(
            "${normalizeBaseUrl(baseUrl)}/api/owner/family/devices/${encodePath(deviceId)}/location-mode",
            FamilyLocationModeRequest(mode),
        )
    }

    suspend fun getFinanceSummary(baseUrl: String): FinanceSummary =
        getJson("${normalizeBaseUrl(baseUrl)}/api/finance/summary")

    suspend fun getFinanceTransactions(baseUrl: String, limit: Int = 20): FinanceTransactionList =
        getJson("${normalizeBaseUrl(baseUrl)}/api/finance/transactions?limit=${limit.coerceIn(1, 100)}")

    suspend fun createFinanceDraft(baseUrl: String, transaction: FinanceTransactionInput): FinanceDraft =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/finance/drafts",
            FinanceDraftCreateRequest(transaction),
        )

    suspend fun confirmFinanceDraft(baseUrl: String, draftId: String): FinanceConfirmResponse =
        postJson(
            "${normalizeBaseUrl(baseUrl)}/api/finance/drafts/${encodePath(draftId)}/confirm",
            FinanceConfirmRequest(),
        )

    suspend fun cancelFinanceDraft(baseUrl: String, draftId: String): JsonObject =
        deleteJson("${normalizeBaseUrl(baseUrl)}/api/finance/drafts/${encodePath(draftId)}")

    suspend fun parseFinanceReceipt(baseUrl: String, imageFile: File, account: String, hint: String): FinanceReceiptResponse =
        postMultipartReceipt(
            url = "${normalizeBaseUrl(baseUrl)}/api/finance/receipts/parse",
            file = imageFile,
            account = account,
            hint = hint,
        )

    suspend fun transcribeAudio(baseUrl: String, audioFile: File, language: String): SttTranscriptionResponse =
        postMultipartAudio(
            url = "${normalizeBaseUrl(baseUrl)}/api/stt/transcribe",
            file = audioFile,
            language = language,
        )

    fun absoluteMediaUrl(baseUrl: String, value: String?): String? {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return null
        connectionManager?.let { return it.mediaUrl(if (raw.startsWith("/" ) || raw.startsWith("http")) raw else "/$raw") }
        if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
        return "${normalizeBaseUrl(baseUrl)}${if (raw.startsWith("/")) raw else "/$raw"}"
    }

    fun streamEvents(baseUrl: String, lastEventId: Long, shouldContinue: () -> Boolean = { true }, onEvent: (CoreStreamEvent) -> Unit) {
        val connection = openConnection("${normalizeBaseUrl(baseUrl)}/api/events/stream", "GET").apply {
            connectTimeout = 10000
            readTimeout = 25000
            setRequestProperty("Accept", "text/event-stream")
            if (lastEventId > 0) setRequestProperty("Last-Event-ID", lastEventId.toString())
        }
        if (!shouldContinue()) { connection.disconnect(); return }
        activeEventStreamBaseUrl = "${connection.url.protocol}://${connection.url.authority}"
        eventConnection.getAndSet(connection)?.disconnect()
        try {
            if (connection.responseCode !in 200..299) {
                throw CoreHttpException(connection.responseCode, "Event stream failed with HTTP ${connection.responseCode}.")
            }
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                var eventId = lastEventId
                var eventType = "message"
                val data = StringBuilder()
                while (shouldContinue() && !Thread.currentThread().isInterrupted && eventConnection.get() === connection) {
                    val line = reader.readLine() ?: break
                    if (!shouldContinue() || eventConnection.get() !== connection) break
                    when {
                        line.startsWith("id:") -> eventId = line.substringAfter(':').trim().toLongOrNull() ?: eventId
                        line.startsWith("event:") -> eventType = line.substringAfter(':').trim()
                        line.startsWith("data:") -> {
                            if (data.isNotEmpty()) data.append('\n')
                            data.append(line.substringAfter(':').trimStart())
                        }
                        line.isBlank() -> {
                            if (eventType.isNotBlank()) onEvent(CoreStreamEvent(eventId, eventType, data.toString()))
                            eventType = "message"
                            data.clear()
                        }
                    }
                }
            }
        } finally {
            if (eventConnection.compareAndSet(connection, null)) activeEventStreamBaseUrl = null
            connection.disconnect()
        }
    }

    companion object {
        private fun encodePath(value: String): String =
            java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

        fun normalizeBaseUrl(value: String): String {
            val trimmed = value.trim().trimEnd('/')
            if (trimmed.isBlank()) return DEFAULT_CORE_BASE_URL

            val hasScheme = trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true)
            val withScheme = if (hasScheme) trimmed else "http://$trimmed"

            if (hasScheme) return withScheme.trimEnd('/')

            val authority = withScheme
                .removePrefix("http://")
                .substringBefore('/')
            val hasPort = authority.substringAfterLast(':', "").toIntOrNull() != null
            if (hasPort || authority.contains("]")) return withScheme.trimEnd('/')

            val path = withScheme
                .removePrefix("http://")
                .substringAfter('/', "")
            if (path.isNotBlank()) return withScheme.trimEnd('/')

            return "http://$authority:$DEFAULT_CORE_PORT"
        }

    }

    private suspend inline fun <reified T> getJson(url: String): T = withContext(Dispatchers.IO) {
        readCoreGet(url, 7000, 7000, "application/json") { decodeResponse<T>(it) }
    }

    private suspend inline fun <reified T, reified B> postJson(url: String, body: B): T = withContext(Dispatchers.IO) {
        requestJson("POST", url, body)
    }

    private suspend inline fun <reified T> postEmptyJson(url: String): T = withContext(Dispatchers.IO) {
        val connection = openConnection(url, "POST").apply {
            connectTimeout = 10000
            readTimeout = 45000
            setRequestProperty("Accept", "application/json")
            doOutput = true
            setFixedLengthStreamingMode(0)
        }
        try {
            decodeResponse<T>(connection)
        } finally {
            connection.disconnect()
        }
    }

    private suspend inline fun <reified T, reified B> putJson(url: String, body: B): T = withContext(Dispatchers.IO) {
        requestJson("PUT", url, body)
    }

    private suspend inline fun <reified T> deleteJson(url: String): T = withContext(Dispatchers.IO) {
        val connection = openConnection(url, "DELETE").apply {
            connectTimeout = 10000
            readTimeout = 45000
            setRequestProperty("Accept", "application/json")
            doOutput = true
            setFixedLengthStreamingMode(0)
        }
        try {
            connection.outputStream.close()
            decodeResponse<T>(connection)
        } finally {
            connection.disconnect()
        }
    }

    private inline fun <reified T, reified B> requestJson(
        method: String,
        url: String,
        body: B,
    ): T {
        val payload = when (body) {
            is String -> body
            else -> json.encodeToString(body)
        }
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val connection = openConnection(url, method).apply {
            connectTimeout = 10000
            readTimeout = 45000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setFixedLengthStreamingMode(bytes.size)
        }
        return try {
            connection.outputStream.use { it.write(bytes) }
            decodeResponse<T>(connection)
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun postMultipartAudio(url: String, file: File, language: String): SttTranscriptionResponse =
        withContext(Dispatchers.IO) {
            val boundary = "----LilyMobileRealm${System.currentTimeMillis()}"
            val connection = openConnection(url, "POST").apply {
                connectTimeout = 10000
                readTimeout = 75000
                doOutput = true
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                setRequestProperty("Accept", "application/json")
                setChunkedStreamingMode(8192)
            }
            try {
                connection.outputStream.buffered().use { output ->
                    fun writeText(value: String) {
                        output.write(value.toByteArray(Charsets.UTF_8))
                    }

                    writeText("--$boundary\r\n")
                    writeText("Content-Disposition: form-data; name=\"language\"\r\n\r\n")
                    writeText(language.trim().lowercase())
                    writeText("\r\n")

                    writeText("--$boundary\r\n")
                    writeText("Content-Disposition: form-data; name=\"file\"; filename=\"mobile_voice.m4a\"\r\n")
                    writeText("Content-Type: audio/mp4\r\n\r\n")
                    file.inputStream().use { input -> input.copyTo(output) }
                    writeText("\r\n--$boundary--\r\n")
                    output.flush()
                }
                decodeResponse(connection)
            } finally {
                connection.disconnect()
            }
        }

    private suspend fun postMultipartReceipt(
        url: String,
        file: File,
        account: String,
        hint: String,
    ): FinanceReceiptResponse = withContext(Dispatchers.IO) {
        val boundary = "----LilyFinance${System.currentTimeMillis()}"
        val connection = openConnection(url, "POST").apply {
            connectTimeout = 10000
            readTimeout = 75000
            doOutput = true
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            setRequestProperty("Accept", "application/json")
            setChunkedStreamingMode(8192)
        }
        try {
            connection.outputStream.buffered().use { output ->
                fun writeText(value: String) = output.write(value.toByteArray(Charsets.UTF_8))
                fun writeField(name: String, value: String) {
                    writeText("--$boundary\r\n")
                    writeText("Content-Disposition: form-data; name=\"$name\"\r\n\r\n")
                    writeText(value)
                    writeText("\r\n")
                }
                writeField("account", account.trim())
                writeField("hint", hint.trim())
                writeText("--$boundary\r\n")
                writeText("Content-Disposition: form-data; name=\"file\"; filename=\"receipt.jpg\"\r\n")
                writeText("Content-Type: image/jpeg\r\n\r\n")
                file.inputStream().use { input -> input.copyTo(output) }
                writeText("\r\n--$boundary--\r\n")
                output.flush()
            }
            decodeResponse(connection)
        } finally {
            connection.disconnect()
        }
    }

    private fun readCompleteBytes(connection: HttpURLConnection): ByteArray {
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val bytes = (stream ?: connection.inputStream).use { it.readBytes() }
        val expected = connection.contentLengthLong
        if (expected >= 0 && bytes.size.toLong() != expected) throw java.io.EOFException("Core response ended before the download completed.")
        return bytes
    }

    private inline fun <reified T> decodeResponse(connection: HttpURLConnection): T {
        val status = connection.responseCode
        if (status !in 200..299) {
            val text = runCatching { readCompleteBytes(connection).toString(Charsets.UTF_8) }.getOrDefault("")
            throw CoreHttpException(status, text.ifBlank { "Request failed with HTTP $status." })
        }
        val text = readCompleteBytes(connection).toString(Charsets.UTF_8)
        return json.decodeFromString(text)
    }
}
