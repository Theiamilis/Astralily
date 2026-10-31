
package com.lilyconstellation.mobile.ui

import android.app.Application
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.lilyconstellation.mobile.BuildConfig
import com.lilyconstellation.mobile.LilyRealmApplication
import com.lilyconstellation.mobile.data.CoreConnectionConfig
import com.lilyconstellation.mobile.data.CoreHttpException
import com.lilyconstellation.mobile.data.DEFAULT_TUNNEL_BASE_URL
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MIN_MODEL_OFFSET_Y
import com.lilyconstellation.mobile.live2d.ModelPositionLimits.MAX_MODEL_OFFSET_Y
import com.lilyconstellation.mobile.data.ChatHistoryRow
import com.lilyconstellation.mobile.data.CachedChatMessage
import com.lilyconstellation.mobile.data.ChatCacheStore
import com.lilyconstellation.mobile.data.LanguagePracticeOptions
import com.lilyconstellation.mobile.data.PracticeFeedback
import com.lilyconstellation.mobile.data.PracticeSession
import com.lilyconstellation.mobile.data.ComponentSnapshot
import com.lilyconstellation.mobile.data.AddressTermOption
import com.lilyconstellation.mobile.data.HealthResponse
import com.lilyconstellation.mobile.data.FinanceDraft
import com.lilyconstellation.mobile.data.FinanceSummary
import com.lilyconstellation.mobile.data.FinanceTransaction
import com.lilyconstellation.mobile.data.FinanceTransactionInput
import com.lilyconstellation.mobile.data.FamilyDevice
import com.lilyconstellation.mobile.data.FamilyCommand
import com.lilyconstellation.mobile.data.FamilyInvitation
import com.lilyconstellation.mobile.data.FamilyLocationPoint
import com.lilyconstellation.mobile.data.FamilyPairingRequest
import com.lilyconstellation.mobile.data.FamilySmsItem
import com.lilyconstellation.mobile.data.HomeControlRequest
import com.lilyconstellation.mobile.data.HomeDevice
import com.lilyconstellation.mobile.data.HomeDeviceState
import com.lilyconstellation.mobile.data.HomeScene
import com.lilyconstellation.mobile.data.HomeSceneAction
import com.lilyconstellation.mobile.data.HomeSceneUpsertRequest
import com.lilyconstellation.mobile.data.MobileRealmApi
import com.lilyconstellation.mobile.data.WaInboxItem
import com.lilyconstellation.mobile.data.WaInboxAction
import com.lilyconstellation.mobile.data.VCardPhoneContact
import com.lilyconstellation.mobile.data.MobileRealmContextPayload
import com.lilyconstellation.mobile.data.MobileRealmIngestPayload
import com.lilyconstellation.mobile.data.MobileRealmIngestRequest
import com.lilyconstellation.mobile.data.OwnerPresencePayload
import com.lilyconstellation.mobile.data.OwnerRoutine
import com.lilyconstellation.mobile.data.PocketRealmSettings
import com.lilyconstellation.mobile.data.SettingsStore
import com.lilyconstellation.mobile.data.SystemCapabilitiesResponse
import com.lilyconstellation.mobile.data.ToolArtifact
import com.lilyconstellation.mobile.data.ToolMaintenance
import com.lilyconstellation.mobile.data.ToolTask
import com.lilyconstellation.mobile.notifications.RealmNotificationCenter
import com.lilyconstellation.mobile.notifications.RealmNotificationScheduler
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

private const val DEFAULT_MODEL_SCALE = 1.0f
private const val MIN_MODEL_SCALE = 0.78f
private const val MAX_MODEL_SCALE = 3.25f
private const val MAX_MODEL_OFFSET_X = 0.85f
private const val STARTUP_MODEL_GRACE_MS = 900L
private const val EVENT_REFRESH_DEBOUNCE_MS = 450L
private const val FOREGROUND_POLL_INTERVAL_MS = 15_000L

data class RealmMoodOption(
    val id: String,
    val label: String,
    val promptHint: String,
)

data class RealmLanguageOption(
    val id: String,
    val label: String,
    val promptHint: String,
    val speechLang: String,
)

data class RealmVoiceOption(
    val id: String,
    val label: String,
)

data class RealmPresenceOption(
    val id: String,
    val label: String,
)

data class RealmModelOption(
    val id: String,
    val label: String,
    val detail: String,
    val expressionCount: Int,
)

data class ChatBubble(
    val id: String,
    val sender: String,
    val text: String,
    val timeLabel: String,
    val isRead: Boolean = false,
    val practice: PracticeFeedback? = null,
)

private fun welcomeBubble(characterName: String): ChatBubble = ChatBubble(
    id = "welcome",
    sender = "lily",
    text = "$characterName is ready. I am right here.",
    timeLabel = currentTimeLabel(),
)

data class DownloadedArtifact(
    val taskId: String,
    val artifactId: String,
    val name: String,
    val mimeType: String,
    val uri: Uri,
    val localPath: String,
)

data class PocketRealmUiState(
    val coreBaseUrl: String = "http://lily-core-host:8000",
    val tunnelBaseUrl: String = DEFAULT_TUNNEL_BASE_URL,
    val connectionMode: String = "auto",
    val activeConnectionRoute: String? = null,
    val routeConnectionStatus: String = "checking",
    val characterName: String = "Lily",
    val coreConnectionState: String = "connecting",
    val lastCoreSyncAt: String? = null,
    val deviceTarget: String = "",
    val activeModelId: String = "lily_jirai_kei",
    val activeLanguage: String = "ja",
    val practiceLanguage: String = "off",
    val practiceLevel: String = "beginner",
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
    val currentExpression: String = "Neutral",
    val followEnabled: Boolean = true,
    val presenceStatus: String = "available",
    val presenceNote: String = "",
    val presenceAutomatic: Boolean = false,
    val automaticPresenceEnabled: Boolean = true,
    val ownerMood: String = "calm",
    val ownerMoodIntensity: Int = 0,
    val routinesEnabled: Boolean = true,
    val routines: List<OwnerRoutine> = emptyList(),
    val voiceRepliesEnabled: Boolean = true,
    val notificationsEnabled: Boolean = true,
    val biometricLockEnabled: Boolean = false,
    val darkModeEnabled: Boolean = false,
    val ownerApiToken: String = "",
    val health: HealthResponse? = null,
    val capabilities: SystemCapabilitiesResponse? = null,
    val availableVoiceRoutes: Set<String> = setOf("sovits", "rvc", "alibaba"),
    val messages: List<ChatBubble> = listOf(
        welcomeBubble("Lily")
    ),
    val pendingApproval: ToolTask? = null,
    val recentTasks: List<ToolTask> = emptyList(),
    val waInbox: List<WaInboxItem> = emptyList(),
    val waInboxBusy: Boolean = false,
    val waInboxError: String? = null,
    val waInboxOpenRequest: String? = null,
    val secretaryContactImportBusy: Boolean = false,
    val secretaryContactImportMessage: String? = null,
    val secretaryContactImportError: Boolean = false,
    val secretaryContactImportSuccess: Boolean = false,
    val selectedTask: ToolTask? = null,
    val downloadedArtifact: DownloadedArtifact? = null,
    val isDownloadingArtifact: Boolean = false,
    val artifactMessage: String? = null,
    val artifactPreviewText: String? = null,
    val toolMaintenance: ToolMaintenance? = null,
    val isToolMaintenanceRefreshing: Boolean = false,
    val toolMaintenanceMessage: String? = null,
    val pendingDeepLinkTaskId: String? = null,
    val homeDevices: List<HomeDevice> = emptyList(),
    val homeStates: Map<String, HomeDeviceState> = emptyMap(),
    val homeScenes: List<HomeScene> = emptyList(),
    val isHomeRefreshing: Boolean = false,
    val homeError: String? = null,
    val financeSummary: FinanceSummary? = null,
    val financeTransactions: List<FinanceTransaction> = emptyList(),
    val financePendingDraft: FinanceDraft? = null,
    val isFinanceRefreshing: Boolean = false,
    val financeError: String? = null,
    val familyDevices: List<FamilyDevice> = emptyList(),
    val familyPairingRequests: List<FamilyPairingRequest> = emptyList(),
    val familyInvitation: FamilyInvitation? = null,
    val familyLocations: Map<String, FamilyLocationPoint?> = emptyMap(),
    val familyCommands: Map<String, List<FamilyCommand>> = emptyMap(),
    val familySmsDeviceId: String? = null,
    val familySmsItems: List<FamilySmsItem> = emptyList(),
    val isFamilyRefreshing: Boolean = false,
    val familyError: String? = null,
    val familyNotice: String? = null,
    val pendingAudioUrl: String? = null,
    val pendingSubtitleText: String? = null,
    val isReplyPending: Boolean = false,
    val replyProgress: String = "Connecting…",
    val isVoiceRecording: Boolean = false,
    val isTranscribingVoice: Boolean = false,
    val voiceInputState: String = "idle",
    val voiceErrorCode: String? = null,
    val isClearingHistory: Boolean = false,
    val isRefreshing: Boolean = false,
    val errorMessage: String? = null,
) {
    val isPracticing: Boolean get() = PracticeSession.isActive(practiceLanguage)
    val chatSessionId: String get() = PracticeSession.id(deviceTarget, practiceLanguage)
    val chatChannel: String get() = PracticeSession.channel(practiceLanguage)
}

class PocketRealmViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsStore = SettingsStore(application)
    private val settings = settingsStore.load()
    private val chatCacheStore = ChatCacheStore(application)
    private val cachedMessages = chatCacheStore.load().map { cached ->
        ChatBubble(cached.id, cached.sender, cached.text, cached.timeLabel, cached.isRead, cached.practice)
    }
    private val connectionManager = (application as LilyRealmApplication).coreConnectionManager
    private val api = MobileRealmApi(connectionManager = connectionManager).also { it.setOwnerApiToken(settings.ownerApiToken) }
    private val _uiState = MutableStateFlow(
        PocketRealmUiState(
            coreBaseUrl = settings.coreBaseUrl,
            tunnelBaseUrl = settings.tunnelBaseUrl,
            connectionMode = settings.connectionMode,
            characterName = settings.characterName,
            activeModelId = settings.activeModelId,
            deviceTarget = settings.deliveryTarget,
            activeLanguage = settings.activeLanguage,
            speechInputProvider = settings.speechInputProvider,
            speechInputLanguage = settings.speechInputLanguage,
            voiceRoute = settings.voiceRoute,
            voiceLanguage = settings.voiceLanguage,
            addressTerm = settings.addressTerm,
            japaneseVoiceProfile = settings.japaneseVoiceProfile,
            englishVoiceProfile = settings.englishVoiceProfile,
            activeMood = settings.activeMood,
            modelScaleMultiplier = settings.modelScaleMultiplier,
            modelOffsetX = settings.modelOffsetX,
            modelOffsetY = settings.modelOffsetY,
            defaultModelScaleMultiplier = settings.defaultModelScaleMultiplier,
            defaultModelOffsetX = settings.defaultModelOffsetX,
            defaultModelOffsetY = settings.defaultModelOffsetY,
            followEnabled = settings.followEnabled,
            presenceStatus = settings.presenceStatus,
            presenceNote = settings.presenceNote,
            automaticPresenceEnabled = settings.automaticPresenceEnabled,
            voiceRepliesEnabled = settings.voiceRepliesEnabled,
            notificationsEnabled = settings.notificationsEnabled,
            biometricLockEnabled = settings.biometricLockEnabled,
            darkModeEnabled = settings.darkModeEnabled,
            ownerApiToken = settings.ownerApiToken,
            messages = cachedMessages.ifEmpty {
                listOf(welcomeBubble(settings.characterName))
            },
        )
    )
    val uiState: StateFlow<PocketRealmUiState> = _uiState.asStateFlow()

    private var pollingJob: Job? = null
    private var eventStreamJob: Job? = null
    private var eventRefreshJob: Job? = null
    private var initialHydrationCompleted = false
    @Volatile private var pendingGeneralEventRefresh = false
    @Volatile private var pendingHomeEventRefresh = false
    @Volatile private var pendingFinanceEventRefresh = false
    @Volatile private var lastSseEventAt: Long = 0
    @Volatile private var lastSseEventId: Long = 0
    @Volatile private var lastOwnerActivityEventAt: Long = 0
    private var bubbleCounter = 0
    private var loadedHistoryKey: String? = null

    init {
        viewModelScope.launch {
            connectionManager.status.collect { connection ->
                _uiState.value = _uiState.value.copy(
                    activeConnectionRoute = connection.route,
                    routeConnectionStatus = connection.status,
                )
                if (connection.status == "online" && api.activeEventStreamBaseUrl != null &&
                    api.activeEventStreamBaseUrl != connection.baseUrl && pollingJob?.isActive == true) {
                    startEventStream()
                }
            }
        }
    }

    val languageOptions = listOf(
        RealmLanguageOption("id", "Indonesia", "Reply in natural Indonesian. Keep the active character warm, playful, and concise.", "id-ID"),
        RealmLanguageOption("en", "English", "Reply in natural English. Keep the active character warm, playful, and concise.", "en-US"),
        RealmLanguageOption("ja", "Japanese", "Reply in natural Japanese. Keep the active character warm, playful, and concise.", "ja-JP"),
    )
    val voiceLanguageOptions = listOf(
        RealmLanguageOption("id", "Indonesia", "", "id-ID"),
        RealmLanguageOption("ja", "Japanese", "", "ja-JP"),
        RealmLanguageOption("en", "English", "", "en-US"),
    )
    private val defaultVoiceRouteOptions = listOf(
        RealmVoiceOption("sovits", "SoVITS"),
        RealmVoiceOption("sovits2", "SoVITS 2"),
        RealmVoiceOption("rvc", "RVC"),
        RealmVoiceOption("alibaba", "Alibaba"),
    )
    val voiceRouteOptions: List<RealmVoiceOption>
        get() = defaultVoiceRouteOptions.filter { it.id in _uiState.value.availableVoiceRoutes }
            .ifEmpty { defaultVoiceRouteOptions }

    private val fallbackAddressTerms = mapOf(
        "id" to listOf(
            AddressTermOption("sayang", "Sayang", "sayang", "Natural and warm"),
            AddressTermOption("cintaku", "Cintaku", "cintaku", "More romantic"),
            AddressTermOption("beb", "Beb", "beb", "Casual and playful"),
        ),
        "en" to listOf(
            AddressTermOption("love", "Love", "love", "Natural and warm"),
            AddressTermOption("darling", "Darling", "darling", "Romantic"),
            AddressTermOption("dear", "Dear", "dear", "Soft and gentle"),
        ),
        "ja" to listOf(
            AddressTermOption("darling", "ダーリン", "ダーリン", "Romantic; natural TTS spelling", "dārin"),
            AddressTermOption("anata", "あなた", "あなた", "Intimate, spouse-like", "anata"),
            AddressTermOption("kimi", "君", "君", "Close and casual", "kimi"),
        ),
    )

    fun addressTermOptions(language: String): List<AddressTermOption> =
        _uiState.value.capabilities?.addressTerms?.get(language)
            ?.takeIf { it.isNotEmpty() }
            ?: fallbackAddressTerms[language].orEmpty()
    val moodOptions = listOf(
        RealmMoodOption("heart", "Heart", "Reply with extra warmth, reassurance, and soft affection."),
        RealmMoodOption("smile", "Smile", "Reply in a cheerful, bright tone."),
        RealmMoodOption("talk", "Talk", "Reply naturally as a relaxed private companion."),
        RealmMoodOption("crown", "Crown", "Reply with playful confidence and gentle bossy-cute energy."),
        RealmMoodOption("tune", "Tune", "Reply concise and easy to speak aloud."),
    )
    val englishVoiceOptions = listOf(
        RealmVoiceOption("zeta_en", "Zeta"),
        RealmVoiceOption("watson_en", "Watson"),
    )
    val japaneseVoiceOptions = listOf(
        RealmVoiceOption("ja", "Neptune"),
        RealmVoiceOption("kokomi_ja", "Kokomi"),
    )
    val presenceOptions = listOf(
        RealmPresenceOption("available", "Available"),
        RealmPresenceOption("busy", "Busy"),
        RealmPresenceOption("at_office", "At Office"),
        RealmPresenceOption("sleeping", "Sleeping"),
        RealmPresenceOption("gaming", "Gaming"),
        RealmPresenceOption("away", "Away"),
    )
    val modelOptions = listOf(
        RealmModelOption("lily_jirai_kei", "Jirai Kei", "Everyday black and pink outfit", 16),
        RealmModelOption("lily_maid_pink", "Purple Maid", "The local DLC purple maid outfit", 19),
    )

    fun startForegroundPolling() {
        if (pollingJob?.isActive == true) return
        pollingJob = viewModelScope.launch {
            if (!initialHydrationCompleted) {
                refresh(silent = false, includeExtended = false).join()
                delay(STARTUP_MODEL_GRACE_MS)
                if (!isActive) return@launch
                refresh(silent = true, includeExtended = true).join()
                if (!isActive) return@launch
                startEventStream()
                initialHydrationCompleted = true
            } else {
                refresh(silent = true, includeExtended = false).join()
                if (!isActive) return@launch
                startEventStream()
            }

            while (true) {
                withContext(Dispatchers.IO) { runCatching { connectionManager.pin() } }
                checkInboxNotifications()
                delay(FOREGROUND_POLL_INTERVAL_MS)
                if (System.currentTimeMillis() - lastSseEventAt > 30_000) {
                    refresh(silent = true)
                }
            }
        }
    }

    private suspend fun checkInboxNotifications() {
        val state = _uiState.value
        if (!state.notificationsEnabled) return
        val noticeApi = api
        runCatching { RealmNotificationCenter.checkInbox(getApplication(), noticeApi, state.coreBaseUrl, state.ownerApiToken) }
    }

    private fun startEventStream() {
        api.closeEventStream()
        eventStreamJob?.cancel()
        eventStreamJob = viewModelScope.launch(Dispatchers.IO) {
            var retryDelayMs = 2_000L
            while (isActive) {
                runCatching {
                    api.streamEvents(_uiState.value.coreBaseUrl, lastSseEventId, shouldContinue = { isActive }) { event ->
                        lastSseEventAt = System.currentTimeMillis()
                        if (event.id > 0 && event.id <= lastSseEventId) return@streamEvents
                        retryDelayMs = 2_000L
                        if (event.id > 0) lastSseEventId = event.id
                        lastSseEventAt = System.currentTimeMillis()
                        if (event.type == "request.progress") {
                            val data = runCatching { org.json.JSONObject(event.data) }.getOrNull()
                            if (data != null) viewModelScope.launch {
                                val state = _uiState.value
                                if (state.isReplyPending && data.optString("trace_id") == activeReplyTraceId &&
                                    data.optString("session_id") == state.chatSessionId) {
                                    val label = when (data.optString("phase")) {
                                        "thinking" -> "Thinking…"
                                        "synthesizing" -> "Synthesizing voice…"
                                        else -> null
                                    }
                                    if (label != null) _uiState.value = state.copy(replyProgress = label)
                                }
                            }
                        } else scheduleEventRefresh(event.type)
                    }
                }
                if (isActive) delay(retryDelayMs)
                retryDelayMs = (retryDelayMs * 2).coerceAtMost(30_000L)
            }
        }
    }

    private fun scheduleEventRefresh(eventType: String) {
        when {
            eventType.startsWith("home.") -> pendingHomeEventRefresh = true
            eventType.startsWith("finance.") -> pendingFinanceEventRefresh = true
            else -> pendingGeneralEventRefresh = true
        }
        eventRefreshJob?.cancel()
        eventRefreshJob = viewModelScope.launch {
            delay(EVENT_REFRESH_DEBOUNCE_MS)
            val refreshGeneral = pendingGeneralEventRefresh
            val refreshHome = pendingHomeEventRefresh
            val refreshFinance = pendingFinanceEventRefresh
            pendingGeneralEventRefresh = false
            pendingHomeEventRefresh = false
            pendingFinanceEventRefresh = false

            if (refreshGeneral) {
                refresh(silent = true)
            } else {
                if (refreshHome) refreshHome()
                if (refreshFinance) refreshFinance()
            }
        }
    }

    fun selectModel(modelId: String) {
        val normalized = modelOptions.firstOrNull { it.id == modelId }?.id ?: modelOptions.first().id
        settingsStore.saveActiveModelId(normalized)
        _uiState.value = _uiState.value.copy(activeModelId = normalized, currentExpression = "Neutral")
    }

    fun stopForegroundPolling() {
        api.closeEventStream()
        pollingJob?.cancel()
        pollingJob = null
        eventStreamJob?.cancel()
        eventStreamJob = null
        eventRefreshJob?.cancel()
        eventRefreshJob = null
    }

    fun selectLanguage(languageId: String) {
        val normalized = normalizeLanguage(languageId)
        settingsStore.saveLanguage(normalized)
        val selectedTerm = addressTermOptions(normalized).firstOrNull { it.id == _uiState.value.addressTerm }?.id
            ?: addressTermOptions(normalized).firstOrNull()?.id
            ?: "darling"
        settingsStore.saveAddressTerm(selectedTerm)
        _uiState.value = _uiState.value.copy(activeLanguage = normalized, addressTerm = selectedTerm)
    }

    fun selectAddressTerm(termId: String) {
        val selected = addressTermOptions(_uiState.value.activeLanguage).firstOrNull { it.id == termId } ?: return
        settingsStore.saveAddressTerm(selected.id)
        _uiState.value = _uiState.value.copy(addressTerm = selected.id)
    }

    fun selectVoiceLanguage(languageId: String) {
        val normalized = languageId.trim().lowercase().takeIf { it in setOf("id", "en", "ja") } ?: "ja"
        settingsStore.saveVoiceLanguage(normalized)
        _uiState.value = _uiState.value.copy(voiceLanguage = normalized)
    }

    fun selectVoiceRoute(routeId: String) {
        val normalized = voiceRouteOptions.firstOrNull { it.id == routeId }?.id ?: "sovits"
        settingsStore.saveVoiceRoute(normalized)
        _uiState.value = _uiState.value.copy(voiceRoute = normalized)
    }

    fun selectEnglishVoiceProfile(profileId: String) {
        settingsStore.saveEnglishVoiceProfile(profileId)
        _uiState.value = _uiState.value.copy(englishVoiceProfile = profileId)
    }

    fun selectJapaneseVoiceProfile(profileId: String) {
        val normalized = japaneseVoiceOptions.firstOrNull { it.id == profileId }?.id ?: "ja"
        settingsStore.saveJapaneseVoiceProfile(normalized)
        _uiState.value = _uiState.value.copy(japaneseVoiceProfile = normalized)
    }

    fun selectMood(moodId: String) {
        settingsStore.saveMood(moodId)
        _uiState.value = _uiState.value.copy(activeMood = moodId)
    }

    fun setModelScaleMultiplier(value: Float) {
        val normalized = value.coerceIn(MIN_MODEL_SCALE, MAX_MODEL_SCALE)
        settingsStore.saveModelScaleMultiplier(normalized)
        _uiState.value = _uiState.value.copy(modelScaleMultiplier = normalized)
    }

    fun zoomModel(delta: Float) {
        setModelScaleMultiplier(_uiState.value.modelScaleMultiplier + delta)
    }

    fun nudgeModel(horizontalDelta: Float = 0f, verticalDelta: Float = 0f) {
        val nextX = (_uiState.value.modelOffsetX + horizontalDelta)
            .coerceIn(-MAX_MODEL_OFFSET_X, MAX_MODEL_OFFSET_X)
        val nextY = (_uiState.value.modelOffsetY + verticalDelta)
            .coerceIn(MIN_MODEL_OFFSET_Y, MAX_MODEL_OFFSET_Y)
        settingsStore.saveModelOffset(nextX, nextY)
        _uiState.value = _uiState.value.copy(
            modelOffsetX = nextX,
            modelOffsetY = nextY,
        )
    }

    fun resetModelTransform() {
        val state = _uiState.value
        settingsStore.saveModelScaleMultiplier(state.defaultModelScaleMultiplier)
        settingsStore.saveModelOffset(state.defaultModelOffsetX, state.defaultModelOffsetY)
        _uiState.value = _uiState.value.copy(
            modelScaleMultiplier = state.defaultModelScaleMultiplier,
            modelOffsetX = state.defaultModelOffsetX,
            modelOffsetY = state.defaultModelOffsetY,
        )
    }

    fun saveCurrentModelTransformAsDefault() {
        val state = _uiState.value
        settingsStore.saveDefaultModelTransform(
            state.modelScaleMultiplier,
            state.modelOffsetX,
            state.modelOffsetY,
        )
        _uiState.value = state.copy(
            defaultModelScaleMultiplier = state.modelScaleMultiplier,
            defaultModelOffsetX = state.modelOffsetX,
            defaultModelOffsetY = state.modelOffsetY,
        )
    }

    fun updateBaseUrl(value: String): String {
        val state = _uiState.value
        return updateConnectionSettings(value, state.tunnelBaseUrl, state.connectionMode, state.ownerApiToken).privateUrl
    }

    fun updateOwnerApiToken(value: String) {
        val state = _uiState.value
        updateConnectionSettings(state.coreBaseUrl, state.tunnelBaseUrl, state.connectionMode, value)
    }

    fun updateConnectionSettings(privateUrl: String, tunnelUrl: String, mode: String, ownerToken: String): CoreConnectionConfig {
        val next = CoreConnectionConfig.validated(privateUrl, tunnelUrl, mode, allowPrivateHttp = BuildConfig.DEBUG)
        val state = _uiState.value
        val cleanToken = ownerToken.trim()
        val endpointChanged = state.coreBaseUrl != next.privateUrl || state.tunnelBaseUrl != next.tunnelUrl || state.ownerApiToken != cleanToken
        settingsStore.saveConnectionConfig(next)
        settingsStore.saveOwnerApiToken(cleanToken)
        connectionManager.configure(next, cleanToken)
        api.setOwnerApiToken(cleanToken)
        _uiState.value = state.copy(coreBaseUrl = next.privateUrl, tunnelBaseUrl = next.tunnelUrl,
            connectionMode = next.mode, ownerApiToken = cleanToken, errorMessage = null)
        if (endpointChanged) lastSseEventId = 0
        lastSseEventAt = 0
        if (pollingJob?.isActive == true) startEventStream()
        return next
    }

    override fun onCleared() {
        stopForegroundPolling()
        super.onCleared()
    }

    suspend fun resolvePlaybackUrl(value: String): String = withContext(Dispatchers.IO) {
        connectionManager.pin()
        connectionManager.mediaUrl(value)
    }

    fun updatePresenceDraft(status: String, note: String) {
        settingsStore.savePresence(status, note)
        _uiState.value = _uiState.value.copy(presenceStatus = status, presenceNote = note)
    }

    fun setVoiceRepliesEnabled(enabled: Boolean) {
        settingsStore.saveVoiceRepliesEnabled(enabled)
        _uiState.value = _uiState.value.copy(
            voiceRepliesEnabled = enabled,
            pendingAudioUrl = if (enabled) _uiState.value.pendingAudioUrl else null,
            pendingSubtitleText = if (enabled) _uiState.value.pendingSubtitleText else null,
        )
    }

    fun setAutomaticPresenceEnabled(enabled: Boolean) {
        settingsStore.saveAutomaticPresenceEnabled(enabled)
        _uiState.value = _uiState.value.copy(automaticPresenceEnabled = enabled)
        if (enabled) reportForegroundActivity()
    }

    fun reportForegroundActivity() {
        reportOwnerActivityEvent("app_foreground", "medium")
    }

    private fun reportOwnerActivityEvent(activity: String, confidence: String = "medium") {
        if (!_uiState.value.automaticPresenceEnabled) return
        val now = System.currentTimeMillis()
        if (activity == "app_foreground" && now - lastOwnerActivityEventAt < 10_000) return
        lastOwnerActivityEventAt = now
        viewModelScope.launch {
            val state = _uiState.value
            runCatching {
                api.reportOwnerActivity(
                    state.coreBaseUrl,
                    state.deviceTarget,
                    activity,
                    confidence,
                )
            }.onSuccess { envelope ->
                _uiState.value = _uiState.value.copy(
                    presenceStatus = envelope.ownerPresence.status,
                    presenceNote = envelope.ownerPresence.note.orEmpty(),
                    presenceAutomatic = envelope.ownerPresence.automatic == true,
                )
            }
        }
    }

    fun setRoutinesEnabled(enabled: Boolean) {
        viewModelScope.launch {
            val state = _uiState.value
            runCatching { api.setOwnerRoutinesEnabled(state.coreBaseUrl, enabled) }
                .onSuccess { routines ->
                    _uiState.value = _uiState.value.copy(
                        routinesEnabled = routines.enabled,
                        routines = routines.items,
                        errorMessage = null,
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        errorMessage = friendlyErrorMessage(
                            error,
                            state.coreBaseUrl,
                            "Daily routines could not be updated.",
                        ),
                    )
                }
        }
    }

    fun setRoutineEnabled(routineId: String, enabled: Boolean) {
        viewModelScope.launch {
            val state = _uiState.value
            runCatching { api.setOwnerRoutineEnabled(state.coreBaseUrl, routineId, enabled) }
                .onSuccess { routines ->
                    _uiState.value = _uiState.value.copy(
                        routinesEnabled = routines.enabled,
                        routines = routines.items,
                        errorMessage = null,
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        errorMessage = friendlyErrorMessage(
                            error,
                            state.coreBaseUrl,
                            "That routine could not be updated.",
                        ),
                    )
                }
        }
    }

    fun setFollowEnabled(enabled: Boolean) {
        settingsStore.saveFollowEnabled(enabled)
        _uiState.value = _uiState.value.copy(followEnabled = enabled)
    }

    fun setNotificationsEnabled(enabled: Boolean) {
        settingsStore.saveNotificationsEnabled(enabled)
        _uiState.value = _uiState.value.copy(notificationsEnabled = enabled)
        if (enabled) RealmNotificationScheduler.enable(getApplication())
        else RealmNotificationScheduler.disable(getApplication())
    }

    fun setBiometricLockEnabled(enabled: Boolean) {
        settingsStore.saveBiometricLockEnabled(enabled)
        _uiState.value = _uiState.value.copy(biometricLockEnabled = enabled)
    }

    fun updateCharacterName(value: String): String {
        val normalized = settingsStore.saveCharacterName(value)
        val state = _uiState.value
        _uiState.value = state.copy(
            characterName = normalized,
            messages = state.messages.map { bubble ->
                if (bubble.id == "welcome") welcomeBubble(normalized) else bubble
            },
        )
        cacheMessages()
        return normalized
    }

    fun setDarkModeEnabled(enabled: Boolean) {
        settingsStore.saveDarkModeEnabled(enabled)
        _uiState.value = _uiState.value.copy(darkModeEnabled = enabled)
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(errorMessage = null)
    }

    fun consumePendingAudio() {
        _uiState.value = _uiState.value.copy(
            pendingAudioUrl = null,
            pendingSubtitleText = null,
        )
    }

    fun setVoiceRecording(recording: Boolean) {
        _uiState.value = _uiState.value.copy(
            isVoiceRecording = recording,
            voiceInputState = if (recording) "listening" else "idle",
            voiceErrorCode = if (recording) null else _uiState.value.voiceErrorCode,
            errorMessage = if (recording) null else _uiState.value.errorMessage,
        )
    }

    private val voiceSession = VoiceInputSession()
    private var voiceTranscriptionJob: Job? = null

    fun selectSpeechInput(provider: String, language: String) {
        if (_uiState.value.isVoiceRecording || _uiState.value.isTranscribingVoice) return
        val selectedProvider = if (provider == "android") "android" else "lily-core-host"
        val selectedLanguage = language.takeIf { it in setOf("id", "en", "ja") } ?: "chat"
        settingsStore.saveSpeechInput(selectedProvider, selectedLanguage)
        _uiState.value = _uiState.value.copy(speechInputProvider = selectedProvider, speechInputLanguage = selectedLanguage)
    }

    fun spokenLanguage(): String = _uiState.value.let {
        if (it.isPracticing) it.practiceLanguage
        else if (it.speechInputLanguage == "chat") it.activeLanguage else it.speechInputLanguage
    }

    fun selectPractice(language: String, level: String = _uiState.value.practiceLevel) {
        val state = _uiState.value
        if (state.isReplyPending || state.isVoiceRecording || state.isTranscribingVoice || state.isClearingHistory) return
        val selected = language.takeIf { PracticeSession.isActive(it) } ?: "off"
        val selectedLevel = if (level == "intermediate") "intermediate" else "beginner"
        if (selected == state.practiceLanguage) {
            _uiState.value = state.copy(practiceLevel = selectedLevel)
            return
        }
        cacheMessages()
        val cached = chatCacheStore.load(PracticeSession.channel(selected)).map {
            ChatBubble(it.id, it.sender, it.text, it.timeLabel, it.isRead, it.practice)
        }
        val welcome = if (selected == "off") welcomeBubble(state.characterName) else ChatBubble(
            "welcome", "lily",
            "Let's chat in ${if (selected == "ja") "Japanese" else "English"}. Say hello or tell me about your day. Tap Notes on a reply for more.",
            currentTimeLabel(),
        )
        _uiState.value = state.copy(
            practiceLanguage = selected, practiceLevel = selectedLevel,
            messages = cached.ifEmpty { listOf(welcome) },
            pendingAudioUrl = null, pendingSubtitleText = null, errorMessage = null,
        )
        loadedHistoryKey = null
        refresh(silent = true)
    }

    fun beginVoiceInput(): Long? {
        val state = _uiState.value
        if (state.isReplyPending || state.isVoiceRecording || state.isTranscribingVoice) return null
        consumePendingAudio()
        val id = voiceSession.begin()
        setVoiceRecording(true)
        return id
    }

    fun isVoiceInputActive(id: Long): Boolean = voiceSession.isActive(id)

    fun awaitVoiceInput(id: Long) {
        if (!voiceSession.isActive(id)) return
        _uiState.value = _uiState.value.copy(isVoiceRecording = false, isTranscribingVoice = true, voiceInputState = "transcribing")
    }

    fun cancelVoiceInput() {
        voiceSession.cancel()
        voiceTranscriptionJob?.cancel()
        voiceTranscriptionJob = null
        _uiState.value = _uiState.value.copy(isVoiceRecording = false, isTranscribingVoice = false, voiceInputState = "idle")
    }

    fun completeVoiceInput(id: Long, text: String) {
        if (!voiceSession.finish(id)) return
        val transcript = text.trim()
        _uiState.value = _uiState.value.copy(isVoiceRecording = false, isTranscribingVoice = false, voiceInputState = "complete")
        if (transcript.isBlank()) {
            reportVoiceInputError("No speech was recognized. Try again or change the speech input provider.", "empty_audio")
        } else {
            reportOwnerActivityEvent("voice_used", "high")
            sendMessage(transcript)
        }
    }

    fun failVoiceInput(id: Long, message: String, code: String) {
        if (voiceSession.finish(id)) reportVoiceInputError(message, code)
    }

    fun setVoiceActivity(hasSpeech: Boolean) {
        if (!_uiState.value.isVoiceRecording) return
        _uiState.value = _uiState.value.copy(
            voiceInputState = if (hasSpeech) "recording" else "listening",
        )
    }

    fun setVoiceSilenceDetected() {
        if (!_uiState.value.isVoiceRecording) return
        _uiState.value = _uiState.value.copy(voiceInputState = "silence_detected")
    }

    fun reportVoiceInputError(message: String, code: String = "unknown") {
        appendMessage("lily", message)
        _uiState.value = _uiState.value.copy(
            isVoiceRecording = false,
            isTranscribingVoice = false,
            voiceInputState = "failed",
            voiceErrorCode = code,
            errorMessage = message,
        )
    }

    fun refresh(
        silent: Boolean = false,
        baseUrlOverride: String? = null,
        includeExtended: Boolean = true,
    ): Job = viewModelScope.launch {
            if (!silent) {
                _uiState.value = _uiState.value.copy(isRefreshing = true, errorMessage = null)
            }
            val state = _uiState.value
            val baseUrl = baseUrlOverride ?: state.coreBaseUrl
            runCatching {
                val historyKey = "$baseUrl|${state.chatSessionId}"
                val historyRows = if (
                    includeExtended &&
                    state.deviceTarget.isNotBlank() &&
                    loadedHistoryKey != historyKey
                ) {
                    runCatching { api.getChatHistory(baseUrl, state.chatSessionId) }.getOrNull()
                } else {
                    null
                }
                val health = api.getHealth(baseUrl)
                val capabilities = runCatching { api.getSystemCapabilities(baseUrl) }.getOrNull()
                val presence = if (includeExtended) {
                    runCatching { api.getOwnerPresence(baseUrl).ownerPresence }
                        .getOrElse { health.ownerPresence }
                } else {
                    health.ownerPresence
                }
                val routines = if (includeExtended) runCatching { api.getOwnerRoutines(baseUrl) }.getOrNull() else null
                val requests = if (includeExtended) runCatching { api.getOpenClawRequests(baseUrl) }.getOrNull() else null
                val toolMaintenance = if (includeExtended) runCatching { api.getToolMaintenance(baseUrl) }.getOrNull() else null
                val homeDevices = if (includeExtended) {
                    runCatching { api.getHomeDevices(baseUrl).devices }.getOrDefault(state.homeDevices)
                } else {
                    state.homeDevices
                }
                val homeScenes = if (includeExtended) {
                    runCatching { api.getHomeScenes(baseUrl).scenes }.getOrDefault(state.homeScenes)
                } else {
                    state.homeScenes
                }
                val homeStates = if (includeExtended) {
                    homeDevices.associate { device ->
                        device.id to runCatching { api.getHomeState(baseUrl, device.id) }
                            .getOrElse { state.homeStates[device.id] ?: HomeDeviceState(device.id, online = false) }
                    }
                } else {
                    state.homeStates
                }
                val financeSummary = if (includeExtended) runCatching { api.getFinanceSummary(baseUrl) }.getOrNull() else null
                val financeTransactions = if (includeExtended) {
                    runCatching { api.getFinanceTransactions(baseUrl).items }.getOrNull()
                } else {
                    null
                }
                val pending = requests?.items?.firstOrNull { it.status == "pending" }
                val historyMessages = historyRows?.toChatBubbles().orEmpty()
                if (historyRows != null && state.chatSessionId == _uiState.value.chatSessionId) {
                    loadedHistoryKey = historyKey
                }
                val nextTasks = requests?.items ?: state.recentTasks
                val nextSelectedTask = state.selectedTask?.let { selected ->
                    nextTasks.firstOrNull { it.id == selected.id } ?: selected
                } ?: state.pendingDeepLinkTaskId?.let { taskId -> nextTasks.firstOrNull { it.id == taskId } }
                val currentMessages = _uiState.value.messages
                _uiState.value = _uiState.value.copy(
                    health = health,
                    capabilities = capabilities ?: state.capabilities,
                    availableVoiceRoutes = capabilities?.voiceRoutes?.keys?.takeIf { it.isNotEmpty() }
                        ?: state.availableVoiceRoutes,
                    presenceStatus = presence?.status ?: state.presenceStatus,
                    presenceNote = presence?.note ?: state.presenceNote,
                    presenceAutomatic = presence?.automatic == true,
                    ownerMood = health.ownerMood?.mood ?: state.ownerMood,
                    ownerMoodIntensity = health.ownerMood?.intensity ?: state.ownerMoodIntensity,
                    currentExpression = health.ownerMood?.expression ?: state.currentExpression,
                    routinesEnabled = routines?.enabled ?: state.routinesEnabled,
                    routines = routines?.items ?: state.routines,
                    pendingApproval = if (includeExtended) pending else state.pendingApproval,
                    recentTasks = nextTasks,
                    selectedTask = nextSelectedTask,
                    pendingDeepLinkTaskId = if (nextSelectedTask != null) null else state.pendingDeepLinkTaskId,
                    toolMaintenance = toolMaintenance ?: state.toolMaintenance,
                    homeDevices = homeDevices,
                    homeStates = homeStates,
                    homeScenes = homeScenes,
                    isHomeRefreshing = false,
                    homeError = null,
                    financeSummary = financeSummary ?: state.financeSummary,
                    financeTransactions = financeTransactions ?: state.financeTransactions,
                    messages = when {
                        state.chatSessionId != _uiState.value.chatSessionId -> currentMessages
                        historyRows == null -> currentMessages
                        historyMessages.isEmpty() -> currentMessages
                        currentMessages != state.messages -> currentMessages
                        currentMessages.any { it.id != "welcome" } -> currentMessages
                        else -> historyMessages
                    },
                    isFinanceRefreshing = false,
                    financeError = null,
                    coreBaseUrl = baseUrl,
                    coreConnectionState = "online",
                    lastCoreSyncAt = currentTimeLabel(),
                    isRefreshing = false,
                    errorMessage = null,
                )
                cacheMessages()
                if (includeExtended && state.notificationsEnabled) {
                    pending?.let { task ->
                        RealmNotificationCenter.notifyOnce(
                            getApplication(),
                            "approval:${task.id}",
                            "${state.characterName} needs your approval",
                            task.task.ifBlank { "An owner action is waiting in Lily Constellation." },
                        )
                    }
                }
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isRefreshing = false,
                    coreBaseUrl = baseUrl,
                    coreConnectionState = "offline",
                    errorMessage = friendlyErrorMessage(error, baseUrl),
                )
            }
    }

    fun requestOpenInbox(itemId: String) {
        _uiState.value = _uiState.value.copy(waInboxOpenRequest = itemId.ifBlank { "inbox" })
    }

    fun consumeInboxOpenRequest() {
        _uiState.value = _uiState.value.copy(waInboxOpenRequest = null)
    }

    fun refreshWaInbox() {
        if (_uiState.value.waInboxBusy) return
        viewModelScope.launch {
            val state = _uiState.value
            val inboxApi = api
            _uiState.value = state.copy(waInboxBusy = true, waInboxError = null)
            val result = runCatching { inboxApi.getWaInbox(state.coreBaseUrl) }
            if (_uiState.value.coreBaseUrl != state.coreBaseUrl || _uiState.value.ownerApiToken != state.ownerApiToken) {
                _uiState.value = _uiState.value.copy(waInboxBusy = false, waInbox = emptyList())
                return@launch
            }
            result.onSuccess { response ->
                _uiState.value = _uiState.value.copy(waInbox = response.items, waInboxBusy = false)
            }.onFailure {
                _uiState.value = _uiState.value.copy(waInbox = emptyList(), waInboxBusy = false,
                    waInboxError = "Inbox unavailable. Check Core, the personal WA service, and owner access.")
            }
        }
    }

    fun updateWaInbox(action: String, item: WaInboxItem, dueAt: String = "", note: String = "", category: String? = null) {
        if (_uiState.value.waInboxBusy) return
        viewModelScope.launch {
            val state = _uiState.value
            val inboxApi = api
            _uiState.value = state.copy(waInboxBusy = true, waInboxError = null)
            val result = runCatching {
                inboxApi.updateWaInbox(state.coreBaseUrl, action, WaInboxAction(item.id, dueAt, note, category))
                inboxApi.getWaInbox(state.coreBaseUrl)
            }
            if (_uiState.value.coreBaseUrl != state.coreBaseUrl || _uiState.value.ownerApiToken != state.ownerApiToken) {
                _uiState.value = _uiState.value.copy(waInboxBusy = false, waInbox = emptyList())
                return@launch
            }
            result.onSuccess { response ->
                _uiState.value = _uiState.value.copy(waInbox = response.items, waInboxBusy = false)
            }.onFailure {
                _uiState.value = _uiState.value.copy(waInboxBusy = false,
                    waInboxError = "Could not update this conversation. Refresh before trying again.")
            }
        }
    }

    fun refreshHome() {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isHomeRefreshing = true, homeError = null)
            runCatching {
                val devices = api.getHomeDevices(state.coreBaseUrl).devices
                val scenes = api.getHomeScenes(state.coreBaseUrl).scenes
                val states = devices.associate { device ->
                    device.id to api.getHomeState(state.coreBaseUrl, device.id)
                }
                Triple(devices, states, scenes)
            }.onSuccess { (devices, states, scenes) ->
                _uiState.value = _uiState.value.copy(
                    homeDevices = devices,
                    homeStates = states,
                    homeScenes = scenes,
                    isHomeRefreshing = false,
                    homeError = null,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isHomeRefreshing = false,
                    homeError = friendlyErrorMessage(error, state.coreBaseUrl, "Home controls are unavailable."),
                )
            }
        }
    }

    fun refreshFinance() {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFinanceRefreshing = true, financeError = null)
            runCatching {
                api.getFinanceSummary(state.coreBaseUrl) to api.getFinanceTransactions(state.coreBaseUrl).items
            }.onSuccess { (summary, transactions) ->
                _uiState.value = _uiState.value.copy(
                    financeSummary = summary,
                    financeTransactions = transactions,
                    isFinanceRefreshing = false,
                    financeError = null,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isFinanceRefreshing = false,
                    financeError = friendlyErrorMessage(error, state.coreBaseUrl, "Finance is unavailable."),
                )
            }
        }
    }

    fun refreshFamily() {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null, familyNotice = null)
            runCatching {
                val devices = api.getFamilyDevices(state.coreBaseUrl).devices.filter { it.revokedAt == null }
                val requests = api.getFamilyPairingRequests(state.coreBaseUrl).requests.filter { it.status == "pending" }
                val commands = devices.associate { device ->
                    device.id to api.getFamilyCommands(state.coreBaseUrl, device.id)
                }
                Triple(devices, requests, commands)
            }.onSuccess { (devices, requests, commands) ->
                _uiState.value = _uiState.value.copy(
                    familyDevices = devices,
                    familyPairingRequests = requests,
                    familyCommands = commands,
                    isFamilyRefreshing = false,
                    familyError = null,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isFamilyRefreshing = false,
                    familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Family data is unavailable."),
                )
            }
        }
    }

    fun createFamilyInvitation() {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null, familyNotice = null)
            runCatching { api.createFamilyInvitation(state.coreBaseUrl) }
                .onSuccess { invitation ->
                    _uiState.value = _uiState.value.copy(
                        familyInvitation = invitation,
                        isFamilyRefreshing = false,
                        familyNotice = "One-use invitation created. It expires in about 10 minutes.",
                        familyError = null,
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isFamilyRefreshing = false,
                        familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Family invitation could not be created."),
                    )
                }
        }
    }

    fun decideFamilyPairing(requestId: String, approve: Boolean) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null)
            runCatching { api.decideFamilyPairing(state.coreBaseUrl, requestId, approve) }
                .onSuccess {
                    _uiState.value = _uiState.value.copy(
                        isFamilyRefreshing = false,
                        familyNotice = if (approve) "Family phone paired." else "Pairing request declined.",
                    )
                    refreshFamily()
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isFamilyRefreshing = false,
                        familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Family pairing decision failed."),
                    )
                }
        }
    }

    fun loadFamilySms(deviceId: String) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null, familySmsDeviceId = deviceId)
            runCatching { api.getFamilySms(state.coreBaseUrl, deviceId).items }
                .onSuccess { items ->
                    _uiState.value = _uiState.value.copy(familySmsItems = items, isFamilyRefreshing = false)
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        familySmsDeviceId = null,
                        familySmsItems = emptyList(),
                        isFamilyRefreshing = false,
                        familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Family messages are unavailable."),
                    )
                }
        }
    }

    fun closeFamilySms() {
        _uiState.value = _uiState.value.copy(familySmsDeviceId = null, familySmsItems = emptyList())
    }

    fun loadFamilyLocation(deviceId: String) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null)
            runCatching {
                api.getFamilyLocation(state.coreBaseUrl, deviceId).location to
                    api.getFamilyCommands(state.coreBaseUrl, deviceId)
            }.onSuccess { (location, commands) ->
                _uiState.value = _uiState.value.copy(
                    familyLocations = _uiState.value.familyLocations + (deviceId to location),
                    familyCommands = _uiState.value.familyCommands + (deviceId to commands),
                    isFamilyRefreshing = false,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isFamilyRefreshing = false,
                    familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Family location is unavailable."),
                )
            }
        }
    }

    fun requestFamilyLocationMode(deviceId: String, mode: String) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFamilyRefreshing = true, familyError = null, familyNotice = null)
            runCatching { api.requestFamilyLocationMode(state.coreBaseUrl, deviceId, mode) }
                .onSuccess { command ->
                    _uiState.value = _uiState.value.copy(
                        familyCommands = _uiState.value.familyCommands +
                            (deviceId to listOf(command) + _uiState.value.familyCommands[deviceId].orEmpty()),
                        isFamilyRefreshing = false,
                        familyNotice = "Location request is ${command.status}; the phone must confirm it.",
                    )
                    loadFamilyLocation(deviceId)
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isFamilyRefreshing = false,
                        familyError = friendlyErrorMessage(error, state.coreBaseUrl, "Location mode request failed."),
                    )
                }
        }
    }

    fun createFinanceDraft(transaction: FinanceTransactionInput) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFinanceRefreshing = true, financeError = null)
            runCatching { api.createFinanceDraft(state.coreBaseUrl, transaction) }
                .onSuccess { draft ->
                    _uiState.value = _uiState.value.copy(
                        financePendingDraft = draft,
                        isFinanceRefreshing = false,
                        financeError = null,
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isFinanceRefreshing = false,
                        financeError = friendlyErrorMessage(error, state.coreBaseUrl, "Finance draft could not be created."),
                    )
                }
        }
    }

    fun confirmFinanceDraft() {
        val draft = _uiState.value.financePendingDraft ?: return
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFinanceRefreshing = true, financeError = null)
            runCatching { api.confirmFinanceDraft(state.coreBaseUrl, draft.id) }
                .onSuccess {
                    _uiState.value = _uiState.value.copy(
                        financePendingDraft = null,
                        isFinanceRefreshing = false,
                        financeError = null,
                    )
                    refreshFinance()
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isFinanceRefreshing = false,
                        financeError = friendlyErrorMessage(error, state.coreBaseUrl, "Finance confirmation failed."),
                    )
                }
        }
    }

    fun cancelFinanceDraft() {
        val draft = _uiState.value.financePendingDraft ?: return
        viewModelScope.launch {
            val state = _uiState.value
            runCatching { api.cancelFinanceDraft(state.coreBaseUrl, draft.id) }
                .onSuccess {
                    _uiState.value = _uiState.value.copy(financePendingDraft = null, financeError = null)
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        financeError = friendlyErrorMessage(error, state.coreBaseUrl, "Finance draft could not be cancelled."),
                    )
                }
        }
    }

    fun parseFinanceReceipt(uri: Uri, account: String, hint: String) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isFinanceRefreshing = true, financeError = null)
            var tempFile: File? = null
            runCatching {
                val resolver = getApplication<Application>().contentResolver
                tempFile = File.createTempFile("lily_receipt_", ".jpg", getApplication<Application>().cacheDir)
                resolver.openInputStream(uri)?.use { input ->
                    tempFile!!.outputStream().use { output -> input.copyTo(output) }
                } ?: error("Receipt image could not be opened.")
                api.parseFinanceReceipt(state.coreBaseUrl, tempFile!!, account, hint)
            }.onSuccess { response ->
                _uiState.value = _uiState.value.copy(
                    financePendingDraft = response.drafts.firstOrNull(),
                    isFinanceRefreshing = false,
                    financeError = if (response.drafts.isEmpty()) response.reason.ifBlank { "No transaction was found in that receipt." } else null,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isFinanceRefreshing = false,
                    financeError = friendlyErrorMessage(error, state.coreBaseUrl, "Receipt parsing failed."),
                )
            }
            tempFile?.delete()
        }
    }

    fun controlHomeDevice(deviceId: String, request: HomeControlRequest) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isHomeRefreshing = true, homeError = null)
            runCatching { api.controlHomeDevice(state.coreBaseUrl, deviceId, request) }
                .onSuccess { response ->
                    val nextState = response.state ?: runCatching {
                        api.getHomeState(state.coreBaseUrl, deviceId)
                    }.getOrNull()
                    _uiState.value = _uiState.value.copy(
                        homeStates = nextState?.let { _uiState.value.homeStates + (deviceId to it) }
                            ?: _uiState.value.homeStates,
                        isHomeRefreshing = false,
                        homeError = null,
                    )
                }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isHomeRefreshing = false,
                        homeError = friendlyErrorMessage(error, state.coreBaseUrl, "Home control failed."),
                    )
                }
        }
    }

    fun activateHomeScene(sceneId: String) {
        viewModelScope.launch {
            val state = _uiState.value
            _uiState.value = state.copy(isHomeRefreshing = true, homeError = null)
            runCatching { api.activateHomeScene(state.coreBaseUrl, sceneId) }
                .onSuccess { refreshHome() }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isHomeRefreshing = false,
                        homeError = friendlyErrorMessage(error, state.coreBaseUrl, "Scene activation failed."),
                    )
                }
        }
    }

    fun saveCurrentHomeScene(name: String, deviceId: String) {
        val trimmed = name.trim()
        val state = _uiState.value.homeStates[deviceId] ?: return
        if (trimmed.isBlank()) return
        val action = HomeSceneAction(
            device = deviceId,
            state = if (state.state == false) "off" else "on",
            brightness = if (state.state == false) null else state.brightness,
            temperatureKelvin = if (state.state == false) null else state.temperatureKelvin,
            rgb = if (state.state == false || state.temperatureKelvin != null) null else state.rgb,
        )
        val sceneId = trimmed.lowercase()
            .replace(Regex("[^a-z0-9]+"), "_")
            .trim('_')
            .ifBlank { "scene_${System.currentTimeMillis()}" }
        viewModelScope.launch {
            val current = _uiState.value
            _uiState.value = current.copy(isHomeRefreshing = true, homeError = null)
            runCatching {
                api.saveHomeScene(
                    current.coreBaseUrl,
                    sceneId,
                    HomeSceneUpsertRequest(name = trimmed, actions = listOf(action)),
                )
            }.onSuccess { refreshHome() }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isHomeRefreshing = false,
                        homeError = friendlyErrorMessage(error, current.coreBaseUrl, "Scene save failed."),
                    )
                }
        }
    }

    private var activeReplyTraceId: String? = null

    fun sendMessage(message: String) {
        val trimmed = message.trim()
        if (trimmed.isBlank() || _uiState.value.isReplyPending || _uiState.value.isVoiceRecording || _uiState.value.isTranscribingVoice) return
        reportOwnerActivityEvent("chat_sent", "high")
        appendMessage("user", trimmed)
        activeReplyTraceId = java.util.UUID.randomUUID().toString()
        _uiState.value = _uiState.value.copy(
            isReplyPending = true,
            replyProgress = "Connecting…",
            errorMessage = null,
        )

        viewModelScope.launch {
            val state = _uiState.value
            val replyLanguageId = if (state.isPracticing) state.practiceLanguage else state.activeLanguage
            val spokenLanguageId = if (state.isPracticing) state.practiceLanguage else state.voiceLanguage
            val language = languageOptions.firstOrNull { it.id == replyLanguageId } ?: languageOptions.first()
            val voiceLanguage = voiceLanguageOptions.firstOrNull { it.id == spokenLanguageId }
                ?: voiceLanguageOptions.first()
            val mood = moodOptions.firstOrNull { it.id == state.activeMood } ?: moodOptions.first()
            val voiceProfile = when (voiceLanguage.id) {
                "en" -> state.englishVoiceProfile
                "id" -> "id"
                else -> state.japaneseVoiceProfile
            }
            val presence = OwnerPresencePayload(
                status = state.presenceStatus,
                label = state.presenceStatus.replace('_', ' ').replaceFirstChar { it.uppercase() },
                note = state.presenceNote.ifBlank { null },
                source = "mobile_realm",
            )
            val request = MobileRealmIngestRequest(
                traceId = activeReplyTraceId,
                sessionId = state.chatSessionId,
                mode = if (state.isPracticing) "language_practice" else "owner_chat",
                payload = MobileRealmIngestPayload(
                    message = trimmed,
                    wantVoice = state.voiceRepliesEnabled,
                    context = MobileRealmContextPayload(
                        characterName = state.characterName,
                        language = language.id,
                        languageLabel = language.label,
                        languagePromptHint = language.promptHint,
                        voiceRoute = state.voiceRoute,
                        voiceLanguage = voiceLanguage.id,
                        voiceProfile = voiceProfile,
                        translateVoiceOutput = language.id != voiceLanguage.id,
                        languagePractice = if (state.isPracticing) LanguagePracticeOptions(state.practiceLanguage, state.practiceLevel) else null,
                        addressTerm = state.addressTerm,
                        uiMood = mood.id,
                        uiMoodLabel = mood.label,
                        promptHint = mood.promptHint,
                        ownerPresence = presence,
                    ),
                    ownerPresence = presence,
                ),
            )
            runCatching {
                api.ingest(state.coreBaseUrl, request)
            }.onSuccess { envelope ->
                val result = envelope.result
                val replyText = result?.text?.trim().orEmpty().ifBlank {
                    "Lily Constellation received the request, but ${state.characterName} did not send text back yet."
                }
                val pendingAudioUrl = if (state.voiceRepliesEnabled) {
                    api.absoluteMediaUrl(state.coreBaseUrl, result?.audioUrl)
                } else {
                    null
                }
                publishLilyReply(
                    text = replyText,
                    expression = result?.expression,
                    audioUrl = pendingAudioUrl,
                    subtitleText = result?.subtitle?.trim().orEmpty().ifBlank { replyText },
                    practice = PracticeFeedback.fromMetadata(result?.metadata),
                )
                refresh(silent = true)
            }.onFailure { error ->
                val friendly = if (state.isPracticing && error.message.orEmpty().contains("language_practice")) {
                    "Core needs an update before conversation mode can be used."
                } else friendlyErrorMessage(error, state.coreBaseUrl)
                appendMessage("lily", friendly)
                _uiState.value = _uiState.value.copy(
                    isReplyPending = false,
                    errorMessage = friendly,
                    coreConnectionState = "offline",
                )
            }
        }
    }

    fun sendVoiceRecording(audioFile: File, id: Long, language: String) {
        if (!voiceSession.isActive(id)) { audioFile.delete(); return }
        val baseUrl = _uiState.value.coreBaseUrl
        awaitVoiceInput(id)
        voiceTranscriptionJob = viewModelScope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            try {
                val transcription = api.transcribeAudio(baseUrl, audioFile, language)
                completeVoiceInput(id, transcription.text)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                failVoiceInput(id, friendlyVoiceInputError(error, baseUrl), voiceErrorCodeFor(error))
            } finally {
                audioFile.delete()
            }
        }
    }

    fun submitPresence() {
        viewModelScope.launch {
            val state = _uiState.value
            val presence = OwnerPresencePayload(
                status = state.presenceStatus,
                label = state.presenceStatus.replace('_', ' ').replaceFirstChar { it.uppercase() },
                note = state.presenceNote.ifBlank { null },
                source = "mobile_realm",
            )
            runCatching {
                api.setOwnerPresence(state.coreBaseUrl, presence, presenceTtlMinutes(state.presenceStatus))
            }.onSuccess { response ->
                _uiState.value = _uiState.value.copy(
                    presenceStatus = response.ownerPresence.status,
                    presenceNote = response.ownerPresence.note.orEmpty(),
                    errorMessage = null,
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    errorMessage = friendlyErrorMessage(error, _uiState.value.coreBaseUrl, "Presence update failed."),
                )
            }
        }
    }

    fun addSecretaryContacts(contacts: List<VCardPhoneContact>) {
        if (contacts.isEmpty() || _uiState.value.secretaryContactImportBusy) return
        viewModelScope.launch {
            val baseUrl = _uiState.value.coreBaseUrl
            _uiState.value = _uiState.value.copy(
                secretaryContactImportBusy = true,
                secretaryContactImportMessage = null,
                secretaryContactImportError = false,
                secretaryContactImportSuccess = false,
            )
            try {
                val result = api.addSecretaryContacts(baseUrl, contacts)
                val message = when {
                    result.added == 0 -> "Those numbers are already in Secretary."
                    result.alreadyPresent > 0 -> "Added ${result.added}; ${result.alreadyPresent} already existed."
                    else -> "Added ${result.added} contact${if (result.added == 1) "" else "s"}."
                }
                _uiState.value = _uiState.value.copy(
                    secretaryContactImportBusy = false,
                    secretaryContactImportMessage = message,
                    secretaryContactImportError = false,
                    secretaryContactImportSuccess = true,
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _uiState.value = _uiState.value.copy(
                    secretaryContactImportBusy = false,
                    secretaryContactImportMessage = friendlyErrorMessage(error, baseUrl, "VCF import failed."),
                    secretaryContactImportError = true,
                    secretaryContactImportSuccess = false,
                )
            }
        }
    }

    fun approvePendingTask(taskId: String) {
        mutateTask { baseUrl -> api.approveTask(baseUrl, taskId, UUID.randomUUID().toString()) }
    }

    fun denyPendingTask(taskId: String) {
        mutateTask { baseUrl -> api.denyTask(baseUrl, taskId, UUID.randomUUID().toString()) }
    }

    fun cancelTask(taskId: String) {
        mutateTask { baseUrl -> api.cancelTask(baseUrl, taskId) }
    }

    fun retryTaskExecution(taskId: String) {
        mutateTask { baseUrl -> api.retryTask(baseUrl, taskId, "execution", UUID.randomUUID().toString()) }
    }

    fun retryTaskDelivery(taskId: String) {
        mutateTask { baseUrl -> api.retryTask(baseUrl, taskId, "delivery", UUID.randomUUID().toString()) }
    }

    fun requestOpenTask(taskId: String) {
        val normalized = taskId.trim().takeIf { it.isNotBlank() } ?: return
        val task = _uiState.value.recentTasks.firstOrNull { it.id == normalized }
        _uiState.value = _uiState.value.copy(
            selectedTask = task,
            pendingDeepLinkTaskId = if (task == null) normalized else null,
        )
    }

    fun refreshToolMaintenance() {
        val state = _uiState.value
        _uiState.value = state.copy(isToolMaintenanceRefreshing = true, toolMaintenanceMessage = null)
        viewModelScope.launch {
            runCatching { api.getToolMaintenance(state.coreBaseUrl) }
                .onSuccess { maintenance ->
                    _uiState.value = _uiState.value.copy(
                        toolMaintenance = maintenance,
                        isToolMaintenanceRefreshing = false,
                    )
                }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isToolMaintenanceRefreshing = false,
                        toolMaintenanceMessage = friendlyErrorMessage(error, state.coreBaseUrl, "Artifact maintenance is unavailable."),
                    )
                }
        }
    }

    fun pruneToolArtifacts() {
        val state = _uiState.value
        _uiState.value = state.copy(isToolMaintenanceRefreshing = true, toolMaintenanceMessage = null)
        viewModelScope.launch {
            runCatching { api.pruneToolArtifacts(state.coreBaseUrl) }
                .onSuccess { response ->
                    _uiState.value = _uiState.value.copy(
                        toolMaintenance = response.maintenance,
                        isToolMaintenanceRefreshing = false,
                        toolMaintenanceMessage = "Pruned ${response.deletedCount} artifact(s).",
                    )
                    refresh(silent = true)
                }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isToolMaintenanceRefreshing = false,
                        toolMaintenanceMessage = friendlyErrorMessage(error, state.coreBaseUrl, "Artifact cleanup failed."),
                    )
                }
        }
    }

    fun selectTask(task: ToolTask) {
        _uiState.value = _uiState.value.copy(selectedTask = task)
    }

    fun clearSelectedTask() {
        _uiState.value = _uiState.value.copy(selectedTask = null)
    }

    fun downloadArtifact(task: ToolTask, artifact: ToolArtifact) {
        val taskId = task.id.trim()
        val artifactId = artifact.id.trim()
        if (taskId.isBlank() || artifactId.isBlank() || _uiState.value.isDownloadingArtifact) return

        val state = _uiState.value
        _uiState.value = state.copy(isDownloadingArtifact = true, artifactMessage = null)
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val bytes = api.downloadArtifact(state.coreBaseUrl, taskId, artifactId)
                check(bytes.isNotEmpty()) { "The artifact was empty." }
                val application = getApplication<Application>()
                val downloadsDir = application
                    .getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                    ?: File(application.filesDir, "downloads")
                downloadsDir.mkdirs()
                val safeName = artifact.name
                    .trim()
                    .replace(Regex("[^A-Za-z0-9._ -]"), "_")
                    .trim('.', ' ', '_')
                    .ifBlank { "artifact_$artifactId" }
                val output = File(downloadsDir, "${taskId}_$safeName")
                output.writeBytes(bytes)
                DownloadedArtifact(
                    taskId = taskId,
                    artifactId = artifactId,
                    name = safeName,
                    mimeType = artifact.mimeType.ifBlank { "application/octet-stream" },
                    localPath = output.absolutePath,
                    uri = FileProvider.getUriForFile(
                        application,
                        "${BuildConfig.APPLICATION_ID}.fileprovider",
                        output,
                    ),
                )
            }.onSuccess { downloaded ->
                _uiState.value = _uiState.value.copy(
                    downloadedArtifact = downloaded,
                    isDownloadingArtifact = false,
                    artifactPreviewText = if (downloaded.mimeType.startsWith("text/")) {
                        runCatching { File(downloaded.localPath).readText().take(8_000) }.getOrNull()
                    } else null,
                    artifactMessage = "Downloaded ${downloaded.name}",
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isDownloadingArtifact = false,
                    artifactMessage = error.message ?: "Artifact download failed.",
                )
            }
        }
    }

    fun clearArtifactMessage() {
        _uiState.value = _uiState.value.copy(artifactMessage = null)
    }

    fun clearArtifactPreview() {
        _uiState.value = _uiState.value.copy(artifactPreviewText = null)
    }

    fun previewArtifact(task: ToolTask, artifact: ToolArtifact) {
        val downloaded = _uiState.value.downloadedArtifact?.takeIf {
            it.taskId == task.id && it.artifactId == artifact.id
        }
        if (downloaded == null) {
            downloadArtifact(task, artifact)
            return
        }
        if (downloaded.mimeType.startsWith("text/")) {
            _uiState.value = _uiState.value.copy(
                artifactPreviewText = runCatching { File(downloaded.localPath).readText().take(8_000) }
                    .getOrElse { "This text artifact could not be previewed safely." },
            )
        }
    }

    private fun mutateTask(block: suspend (String) -> Unit) {
        viewModelScope.launch {
            val baseUrl = _uiState.value.coreBaseUrl
            runCatching { block(baseUrl) }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        errorMessage = friendlyErrorMessage(error, baseUrl, "Task update failed."),
                    )
                }
            refresh(silent = false)
        }
    }

    private fun appendMessage(sender: String, text: String) {
        bubbleCounter += 1
        _uiState.value = _uiState.value.copy(
            messages = _uiState.value.messages + ChatBubble(
                id = "bubble_$bubbleCounter",
                sender = sender,
                text = text,
                timeLabel = currentTimeLabel(),
                isRead = sender == "lily",
            )
        )
        cacheMessages()
    }

    private fun publishLilyReply(
        text: String,
        expression: String?,
        audioUrl: String?,
        subtitleText: String?,
        practice: PracticeFeedback? = null,
    ) {
        bubbleCounter += 1
        val state = _uiState.value
        val publishedAt = currentTimeLabel()
        _uiState.value = state.copy(
            messages = state.messages + ChatBubble(
                id = "bubble_$bubbleCounter",
                sender = "lily",
                text = text,
                timeLabel = publishedAt,
                isRead = true,
                practice = practice,
            ),
            currentExpression = expression ?: state.currentExpression,
            coreConnectionState = "online",
            lastCoreSyncAt = publishedAt,
            pendingAudioUrl = audioUrl,
            pendingSubtitleText = subtitleText?.takeIf { audioUrl != null },
            isReplyPending = false,
            errorMessage = null,
        )
        cacheMessages()
    }

    private fun cacheMessages() {
        chatCacheStore.save(
            _uiState.value.messages.map { bubble ->
                CachedChatMessage(bubble.id, bubble.sender, bubble.text, bubble.timeLabel, bubble.isRead, bubble.practice)
            },
            channel = _uiState.value.chatChannel,
        )
    }

    fun clearChatHistory() {
        val state = _uiState.value
        val sessionId = state.chatSessionId.trim()
        if (sessionId.isBlank() || state.isClearingHistory) return

        _uiState.value = state.copy(isClearingHistory = true, errorMessage = null)
        viewModelScope.launch {
            runCatching {
                api.resetSessionConversation(state.coreBaseUrl, sessionId).also { result ->
                    check(result.ok) { "Core declined the conversation reset." }
                }
            }.onSuccess {
                    chatCacheStore.clear(state.chatChannel)
                    loadedHistoryKey = "${state.coreBaseUrl}|$sessionId"
                    _uiState.value = _uiState.value.copy(
                        messages = listOf(
                            ChatBubble(
                                id = "welcome_reset",
                                sender = "lily",
                                text = "Fresh page. What are we talking about now?",
                                timeLabel = currentTimeLabel(),
                                isRead = true,
                            ),
                        ),
                        pendingAudioUrl = null,
                        pendingSubtitleText = null,
                        isReplyPending = false,
                        currentExpression = "Neutral",
                        isClearingHistory = false,
                        errorMessage = null,
                    )
                    cacheMessages()
                }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isClearingHistory = false,
                        errorMessage = friendlyErrorMessage(
                            error,
                            state.coreBaseUrl,
                            "Chat history could not be cleared.",
                        ),
                    )
                }
        }
    }

    private fun List<ChatHistoryRow>.toChatBubbles(): List<ChatBubble> = flatMapIndexed { index, row ->
        val timeLabel = historyTimeLabel(row.timestamp)
        buildList {
            row.userMessage.trim().takeIf { it.isNotBlank() }?.let { message ->
                add(
                    ChatBubble(
                        id = "history_${index}_user",
                        sender = "user",
                        text = message,
                        timeLabel = timeLabel,
                    )
                )
            }
            row.botResponse.trim().takeIf { it.isNotBlank() }?.let { response ->
                add(
                    ChatBubble(
                        id = "history_${index}_lily",
                        sender = "lily",
                        text = response,
                        timeLabel = timeLabel,
                        isRead = true,
                        practice = row.practice,
                    )
                )
            }
        }
    }

    private fun presenceTtlMinutes(status: String): Int? = when (status) {
        "busy" -> 120
        "at_office" -> 540
        "sleeping" -> 480
        "gaming" -> 240
        "away" -> 180
        else -> null
    }

    private fun friendlyErrorMessage(
        error: Throwable,
        baseUrl: String,
        fallback: String = "Lily Constellation could not reach the core right now.",
    ): String {
        val raw = error.message.orEmpty()
        return when {
            error is javax.net.ssl.SSLException ->
                "The Core certificate could not be verified. Check the HTTPS address and certificate."
            error is CoreHttpException -> when (error.status) {
                401, 403 -> "Owner authentication failed. Check the owner API token in Settings."
                400, 422 -> "Core rejected the request. Check the entered values."
                429 -> "Core is limiting requests. Wait before trying again."
                in 300..399 -> "Core redirected the request. Enter its direct address in Settings."
                else -> "Core returned HTTP ${error.status}. Try again when the service is ready."
            }
            raw.contains("Failed to connect", ignoreCase = true) ||
                raw.contains("Connection refused", ignoreCase = true) ||
            raw.contains("timeout", ignoreCase = true) ->
                "Core could not be reached. Check the connection mode and addresses in Settings."

            raw.contains("/127.0.0.1:8000") || baseUrl.contains("127.0.0.1") ->
                "This phone is still pointing at localhost. Change the Core URL in Settings to your PC or Tailscale address."

            raw.isNotBlank() -> fallback
            else -> fallback
        }
    }

    private fun friendlyVoiceInputError(error: Throwable, baseUrl: String): String {
        if (error is CoreHttpException || error is javax.net.ssl.SSLException) return friendlyErrorMessage(error, baseUrl)
        val raw = error.message.orEmpty()
        return when {
            raw.contains("Failed to connect", ignoreCase = true) ||
                raw.contains("Connection refused", ignoreCase = true) ||
                raw.contains("timeout", ignoreCase = true) ->
                "Voice input could not reach STT through Core. Check the Core and STT services."

            raw.contains("413") || raw.contains("too long", ignoreCase = true) ->
                "That voice note is too long for Lily Constellation voice input right now."

            baseUrl.contains("127.0.0.1") ->
                "This phone is still pointing at localhost. Change the Core URL in Settings to your PC or Tailscale address."

            else -> "Voice input could not be transcribed right now."
        }
    }

    private fun voiceErrorCodeFor(error: Throwable): String {
        val raw = error.message.orEmpty().lowercase()
        return when {
            raw.contains("permission") || raw.contains("not allowed") -> "permission"
            raw.contains("413") || raw.contains("too long") || raw.contains("duration") -> "duration"
            raw.contains("empty") || raw.contains("no speech") -> "empty_audio"
            raw.contains("connect") || raw.contains("timeout") || raw.contains("network") -> "network"
            raw.contains("provider") || raw.contains("stt") || raw.contains("transcription") || raw.contains("speech") -> "provider"
            else -> "unknown"
        }
    }

    private fun normalizeLanguage(value: String): String =
        when (value.trim().lowercase()) {
            "en", "english" -> "en"
            "id", "in", "indo", "indonesian", "bahasa indonesia" -> "id"
            else -> "ja"
        }
}

fun HealthResponse.componentOrEmpty(key: String): ComponentSnapshot = components[key] ?: ComponentSnapshot(status = "offline")

private fun currentTimeLabel(): String = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))

private fun historyTimeLabel(value: String?): String {
    val raw = value?.trim().orEmpty()
    if (raw.isBlank()) return currentTimeLabel()

    val instant = runCatching { Instant.parse(raw) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull()
        ?: runCatching { LocalDateTime.parse(raw).toInstant(ZoneOffset.UTC) }.getOrNull()

    return instant
        ?.atZone(ZoneId.systemDefault())
        ?.toLocalTime()
        ?.format(DateTimeFormatter.ofPattern("HH:mm"))
        ?: currentTimeLabel()
}
