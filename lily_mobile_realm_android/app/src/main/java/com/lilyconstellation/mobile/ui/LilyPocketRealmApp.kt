package com.lilyconstellation.mobile.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteSweep
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Headphones
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.ReceiptLong
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.RestartAlt
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.SentimentSatisfied
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.lilyconstellation.mobile.R
import com.lilyconstellation.mobile.data.ComponentSnapshot
import com.lilyconstellation.mobile.data.HealthResponse
import com.lilyconstellation.mobile.data.HomeControlRequest
import com.lilyconstellation.mobile.data.FinanceDraft
import com.lilyconstellation.mobile.data.FinanceTransactionInput
import com.lilyconstellation.mobile.data.HomeDevice
import com.lilyconstellation.mobile.data.HomeDeviceState
import com.lilyconstellation.mobile.data.ToolArtifact
import com.lilyconstellation.mobile.data.ToolTask
import com.lilyconstellation.mobile.live2d.Live2DStageHost
import com.lilyconstellation.mobile.ui.theme.LilyTheme
import kotlinx.coroutines.delay
import java.io.File
import java.time.Duration
import java.time.Instant
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

private enum class PocketTab { Chat, Tasks, Wardrobe, Lily, Settings }

private val PocketPink = Color(0xFFC43C7D)
private val PocketPinkDeep = Color(0xFFA83269)
private val PocketVoice = Color(0xFF7654A5)
private val PocketOnline = Color(0xFF22C55E)
private val PocketText: Color
    @Composable get() = MaterialTheme.colorScheme.onSurface
private val PocketSubtle: Color
    @Composable get() = if (MaterialTheme.colorScheme.background.luminance() > 0.5f) Color(0xFF7A5369) else Color(0xFFD6A9BE)
private val PocketMuted: Color
    @Composable get() = if (MaterialTheme.colorScheme.background.luminance() > 0.5f) Color(0xFFAC7B91) else Color(0xFFAD8296)
private val PocketBorder: Color
    @Composable get() = MaterialTheme.colorScheme.outline
private val PocketWhite: Color
    @Composable get() = MaterialTheme.colorScheme.surface
private val PocketBlush: Color
    @Composable get() = MaterialTheme.colorScheme.surfaceVariant
private val PocketGlassBorder: Color
    @Composable get() = MaterialTheme.colorScheme.outline
private val PocketGlass: Color
    @Composable get() = MaterialTheme.colorScheme.surface.copy(alpha = 0.82f)
private val StagePink: Color
    @Composable get() = if (MaterialTheme.colorScheme.background.luminance() > 0.5f) Color(0xFFF7C9DC) else Color(0xFF291923)
private const val VoiceSubtitleSegmentLimit = 44
private const val StartupMinimumLoadingMs = 1_200L
private const val StartupLoadingTimeoutMs = 12_000L
private val VoiceSubtitleWhitespace = Regex("\\s+")
private val PreviewLanguageOptions = listOf(
    RealmLanguageOption("id", "Indonesia", "", "id-ID"),
    RealmLanguageOption("en", "English", "", "en-US"),
    RealmLanguageOption("ja", "Japanese", "", "ja-JP"),
)

private val ToolTaskTemplates = listOf(
    "Word document" to "Buatkan dokumen Word yang rapi tentang ",
    "PDF report" to "Buatkan laporan PDF dengan ringkasan, detail, dan kesimpulan tentang ",
    "Formal letter" to "Buatkan surat formal dalam format Word untuk ",
    "Spreadsheet" to "Buatkan spreadsheet dengan tabel dan rumus sederhana untuk ",
)

// Temporary visual fallback for UI tuning. Native Cubism takes over when the SDK and model are ready.
private const val STAGE_MOCK_OVERLAY_ENABLED = false

private data class VoiceSubtitleFrame(
    val text: String,
    val spokenCharacterCount: Int,
    val progress: Float,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LilyPocketRealmApp(
    viewModel: PocketRealmViewModel = viewModel(),
    onDarkModeChanged: (Boolean) -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    LaunchedEffect(state.darkModeEnabled) {
        onDarkModeChanged(state.darkModeEnabled)
    }
    LilyTheme(darkTheme = state.darkModeEnabled) {
        LilyPocketRealmContent(viewModel = viewModel, state = state)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LilyPocketRealmContent(viewModel: PocketRealmViewModel, state: PocketRealmUiState) {
    var activeTab by remember { mutableStateOf(PocketTab.Chat) }
    var inputValue by remember { mutableStateOf(TextFieldValue("")) }
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val focusManager = LocalFocusManager.current
    var lipSyncLevel by remember { mutableFloatStateOf(0f) }
    var voicePlaybackActive by remember { mutableStateOf(false) }
    var voicePlaybackPositionMs by remember { mutableStateOf(0) }
    var voicePlaybackDurationMs by remember { mutableStateOf(0) }
    var quickMenuVisible by remember { mutableStateOf(false) }
    var homeSheetVisible by remember { mutableStateOf(false) }
    val startupStartedAt = remember { SystemClock.elapsedRealtime() }
    var live2DStageReady by remember { mutableStateOf(false) }
    var startupOverlayVisible by remember { mutableStateOf(true) }
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val voiceInput = remember(context, viewModel) { MobileVoiceInput(context.applicationContext, viewModel) }
    var startRecordingAfterMicrophonePermission by remember { mutableStateOf(false) }
    var audioCapturePermissionGranted by remember {
        mutableStateOf(
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val microphonePermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        audioCapturePermissionGranted = granted
        val shouldStartRecording = startRecordingAfterMicrophonePermission
        startRecordingAfterMicrophonePermission = false
        if (granted && shouldStartRecording) {
            if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) voiceInput.start()
        } else if (!granted && shouldStartRecording) {
            viewModel.reportVoiceInputError("Microphone permission is needed for ${state.characterName}'s voice input.", "permission")
        }
    }
    val notificationPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) viewModel.setNotificationsEnabled(false)
    }

    LaunchedEffect(live2DStageReady) {
        if (live2DStageReady && startupOverlayVisible) {
            val elapsed = SystemClock.elapsedRealtime() - startupStartedAt
            val remaining = (StartupMinimumLoadingMs - elapsed).coerceAtLeast(0L)
            if (remaining > 0L) delay(remaining)
            startupOverlayVisible = false
        }
    }

    LaunchedEffect(startupStartedAt) {
        delay(StartupLoadingTimeoutMs)
        startupOverlayVisible = false
    }

    LaunchedEffect(activeTab) {
        if (activeTab != PocketTab.Chat) {
            focusManager.clearFocus()
            voiceInput.cancel()
        }
    }

    LaunchedEffect(state.selectedTask?.id) {
        if (state.selectedTask != null) activeTab = PocketTab.Tasks
    }
    LaunchedEffect(state.waInboxOpenRequest) {
        if (state.waInboxOpenRequest != null) activeTab = PocketTab.Tasks
    }


    LaunchedEffect(state.notificationsEnabled) {
        if (
            state.notificationsEnabled &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    LaunchedEffect(state.voiceRepliesEnabled) {
        if (state.voiceRepliesEnabled && !audioCapturePermissionGranted) {
            delay(1_500)
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                startRecordingAfterMicrophonePermission = false
                microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    LaunchedEffect(state.isVoiceRecording) {
        if (state.isVoiceRecording) {
            delay(20_000)
            if (viewModel.uiState.value.isVoiceRecording) {
                voiceInput.stop()
            }
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> viewModel.startForegroundPolling()
                Lifecycle.Event.ON_RESUME -> viewModel.reportForegroundActivity()
                Lifecycle.Event.ON_STOP -> {
                    startRecordingAfterMicrophonePermission = false
                    voiceInput.cancel()
                    viewModel.stopForegroundPolling()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            viewModel.startForegroundPolling()
            viewModel.reportForegroundActivity()
        }
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            voiceInput.cancel()
            viewModel.stopForegroundPolling()
        }
    }

    PocketRealmAudioEffect(
        audioUrl = state.pendingAudioUrl,
        resolveAudioUrl = viewModel::resolvePlaybackUrl,
        onPlaybackState = { playing ->
            voicePlaybackActive = playing
            if (!playing) {
                lipSyncLevel = 0f
                voicePlaybackPositionMs = 0
                voicePlaybackDurationMs = 0
                viewModel.consumePendingAudio()
            }
        },
        onPlaybackProgress = { positionMs, durationMs ->
            voicePlaybackPositionMs = positionMs
            voicePlaybackDurationMs = durationMs
        },
        onLipSyncTick = { level -> lipSyncLevel = level },
    )

    state.pendingApproval?.let { task ->
        AlertDialog(
            onDismissRequest = { },
            title = { Text("Tool approval needed") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(task.action.ifBlank { "owner_tool" }, fontWeight = FontWeight.SemiBold)
                    Text(task.task)
                    Text("Approve in Lily Constellation, or deny it here before anything runs.")
                }
            },
            confirmButton = {
                TextButton(onClick = { viewModel.approvePendingTask(task.id) }) {
                    Text("Approve")
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.denyPendingTask(task.id) }) {
                    Text("Deny")
                }
            },
        )
    }

    if (quickMenuVisible) {
        QuickMenuSheet(
            activeTab = activeTab,
            characterName = state.characterName,
            onDismiss = { quickMenuVisible = false },
            onTabSelected = {
                activeTab = it
                quickMenuVisible = false
            },
            onOpenHome = {
                quickMenuVisible = false
                homeSheetVisible = true
                viewModel.refreshHome()
            },
            onRefresh = {
                quickMenuVisible = false
                viewModel.refresh()
            },
        )
    }

    if (homeSheetVisible) {
        HomeControlSheet(
            state = state,
            onDismiss = { homeSheetVisible = false },
            onRefresh = viewModel::refreshHome,
            onControl = viewModel::controlHomeDevice,
            onActivateScene = viewModel::activateHomeScene,
            onSaveScene = viewModel::saveCurrentHomeScene,
        )
    }

    state.financePendingDraft?.let { draft ->
        FinanceConfirmationSheet(
            draft = draft,
            isBusy = state.isFinanceRefreshing,
            onConfirm = viewModel::confirmFinanceDraft,
            onCancel = viewModel::cancelFinanceDraft,
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(MaterialTheme.colorScheme.background, StagePink, PocketBlush))),
    ) {
        when (activeTab) {
            PocketTab.Chat -> MinimalChatScene(
                state = state,
                viewModel = viewModel,
                inputValue = inputValue,
                keyboardVisible = keyboardVisible,
                lipSyncLevel = lipSyncLevel,
                voicePlaybackActive = voicePlaybackActive,
                voicePlaybackPositionMs = voicePlaybackPositionMs,
                voicePlaybackDurationMs = voicePlaybackDurationMs,
                onInputChange = { inputValue = it },
                onSend = {
                    if (!state.isReplyPending && !state.isVoiceRecording && !state.isTranscribingVoice && inputValue.text.isNotBlank()) {
                        viewModel.sendMessage(inputValue.text)
                        inputValue = TextFieldValue("")
                    }
                },
                onStopVoice = {
                    viewModel.consumePendingAudio()
                    lipSyncLevel = 0f
                },
                onHomeClick = {
                    homeSheetVisible = true
                    viewModel.refreshHome()
                },
                onMenuClick = {
                    focusManager.clearFocus()
                    quickMenuVisible = true
                },
                onVoiceInputClick = {
                    focusManager.clearFocus()
                    if (state.isVoiceRecording) {
                        voiceInput.stop()
                    } else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        voiceInput.start()
                    } else {
                        startRecordingAfterMicrophonePermission = true
                        microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                },
                onStageReady = { live2DStageReady = true },
            )

            PocketTab.Tasks -> PanelTabScene(activeTab = activeTab, characterName = state.characterName, onTabSelected = { activeTab = it }) {
                TasksTab(
                    state = state,
                    viewModel = viewModel,
                    tasks = state.recentTasks,
                    onApprove = viewModel::approvePendingTask,
                    onDeny = viewModel::denyPendingTask,
                    onCancel = viewModel::cancelTask,
                    onRetryExecution = viewModel::retryTaskExecution,
                    onRetryDelivery = viewModel::retryTaskDelivery,
                    onSelectTask = viewModel::selectTask,
                    onDownloadArtifact = viewModel::downloadArtifact,
                    onPreviewArtifact = viewModel::previewArtifact,
                    onRefreshTasks = { viewModel.refresh(silent = true) },
                    onRefreshMaintenance = viewModel::refreshToolMaintenance,
                    onPruneArtifacts = viewModel::pruneToolArtifacts,
                    onUseTemplate = { template ->
                        activeTab = PocketTab.Chat
                        inputValue = TextFieldValue(template)
                    },
                    onControlHome = viewModel::controlHomeDevice,
                    onActivateScene = viewModel::activateHomeScene,
                    onSaveScene = viewModel::saveCurrentHomeScene,
                )
            }

            PocketTab.Wardrobe -> PanelTabScene(activeTab = activeTab, characterName = state.characterName, onTabSelected = { activeTab = it }) {
                WardrobeTab(state = state, viewModel = viewModel)
            }

            PocketTab.Lily -> PanelTabScene(activeTab = activeTab, characterName = state.characterName, onTabSelected = { activeTab = it }) {
                LilyPreferencesTab(
                    state = state,
                    viewModel = viewModel,
                    onStopVoice = {
                        viewModel.consumePendingAudio()
                        lipSyncLevel = 0f
                    },
                )
            }

            PocketTab.Settings -> PanelTabScene(activeTab = activeTab, characterName = state.characterName, onTabSelected = { activeTab = it }) {
                SettingsTab(state = state, viewModel = viewModel)
            }
        }

        if (activeTab == PocketTab.Chat && !keyboardVisible) {
            PocketBottomNav(
                activeTab = activeTab,
                characterName = state.characterName,
                onTabSelected = { activeTab = it },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(horizontal = 24.dp, vertical = 8.dp),
            )
        }

        AnimatedVisibility(
            visible = startupOverlayVisible,
            enter = fadeIn(animationSpec = tween(180)),
            exit = fadeOut(animationSpec = tween(420)),
            modifier = Modifier
                .fillMaxSize()
                .zIndex(100f),
        ) {
            LilyStartupOverlay(characterName = state.characterName)
        }
    }
}

@Composable
private fun LilyStartupOverlay(characterName: String) {
    val motion = rememberInfiniteTransition(label = "lily-startup-pulse")
    val pulse by motion.animateFloat(
        initialValue = 0.96f,
        targetValue = 1.04f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_050, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "lily-startup-logo-scale",
    )
    val background = MaterialTheme.colorScheme.background

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(background)
            .background(
                Brush.radialGradient(
                    colors = listOf(PocketPink.copy(alpha = 0.22f), Color.Transparent),
                    radius = 980f,
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(194.dp)
                    .graphicsLayer {
                        scaleX = pulse
                        scaleY = pulse
                    }
                    .shadow(22.dp, CircleShape)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.94f))
                    .border(1.dp, PocketPink.copy(alpha = 0.38f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(R.drawable.lily_logo),
                    contentDescription = "Lily Constellation logo",
                    modifier = Modifier.size(158.dp),
                    contentScale = ContentScale.Fit,
                )
            }
            Text(
                text = "Waking $characterName…",
                color = PocketText,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Preparing your private constellation",
                color = PocketSubtle,
                fontSize = 13.sp,
            )
            CircularProgressIndicator(
                modifier = Modifier
                    .padding(top = 4.dp)
                    .size(26.dp),
                color = PocketPink,
                strokeWidth = 3.dp,
            )
        }
    }
}

@Composable
private fun MinimalChatScene(
    state: PocketRealmUiState,
    viewModel: PocketRealmViewModel?,
    inputValue: TextFieldValue,
    keyboardVisible: Boolean,
    lipSyncLevel: Float,
    voicePlaybackActive: Boolean,
    voicePlaybackPositionMs: Int,
    voicePlaybackDurationMs: Int,
    onInputChange: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
    onStopVoice: () -> Unit,
    onHomeClick: () -> Unit,
    onMenuClick: () -> Unit,
    onVoiceInputClick: () -> Unit,
    onStageReady: () -> Unit = {},
    previewMode: Boolean = false,
) {
    var stageControlsVisible by remember { mutableStateOf(false) }
    var moodRailVisible by remember { mutableStateOf(false) }
    var defaultFrameSaved by remember { mutableStateOf(false) }
    var visibleStageError by remember { mutableStateOf<String?>(null) }
    var lastShownStageError by remember { mutableStateOf<String?>(null) }
    val density = LocalDensity.current
    val activeVoiceSubtitle = remember(
        state.pendingAudioUrl,
        state.pendingSubtitleText,
        voicePlaybackPositionMs,
        voicePlaybackDurationMs,
    ) {
        if (state.pendingAudioUrl == null) {
            null
        } else {
            voiceSubtitleFrame(
                text = state.pendingSubtitleText.orEmpty(),
                positionMs = voicePlaybackPositionMs,
                durationMs = voicePlaybackDurationMs,
            )
        }
    }

    LaunchedEffect(state.isRefreshing) {
        if (state.isRefreshing) {
            lastShownStageError = null
        }
    }

    LaunchedEffect(defaultFrameSaved) {
        if (defaultFrameSaved) {
            delay(1_600)
            defaultFrameSaved = false
        }
    }

    LaunchedEffect(keyboardVisible) {
        if (keyboardVisible) {
            stageControlsVisible = false
            moodRailVisible = false
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize().imePadding()) {
        val compact = maxWidth < 430.dp || maxHeight < 760.dp
        val bottomNavHeight = if (keyboardVisible) 0.dp else if (compact) 54.dp else 60.dp
        val bottomHudHeight = (if (keyboardVisible) 44.dp else if (compact) 78.dp else 84.dp) +
            (if (state.isPracticing) 47.dp else 0.dp)
        val bottomHudGap = if (compact) 16.dp else 18.dp
        val bottomHudBottomOffset = if (keyboardVisible) {
            10.dp
        } else {
            bottomNavHeight + bottomHudGap + if (compact) 42.dp else 48.dp
        }
        val topStageReserve = if (compact) 136.dp else 150.dp
        val bottomStageReserve = bottomHudBottomOffset + bottomHudHeight + if (keyboardVisible) {
            44.dp
        } else if (compact) {
            96.dp
        } else {
            108.dp
        }
        val topInsetPx = with(density) { topStageReserve.roundToPx() }
        val bottomInsetPx = with(density) { bottomStageReserve.roundToPx() }
        val compactStageError = state.errorMessage?.let {
            if (compact) "Core offline. Check Settings." else it.take(74)
        }

        LaunchedEffect(compactStageError) {
            if (compactStageError != null && compactStageError != lastShownStageError) {
                visibleStageError = compactStageError
                lastShownStageError = compactStageError
                delay(4_000)
                if (visibleStageError == compactStageError) {
                    visibleStageError = null
                }
            } else if (compactStageError == null) {
                visibleStageError = null
            }
        }

        PocketBackgroundDecoration()

        if (previewMode) {
            StageModelVisualLayer(
                compact = compact,
                modelScaleMultiplier = state.modelScaleMultiplier,
                modelOffsetX = state.modelOffsetX,
                modelOffsetY = state.modelOffsetY,
                topReserve = topStageReserve,
                bottomReserve = bottomStageReserve,
            )
        } else {
            Live2DStageHost(
                modifier = Modifier.fillMaxSize(),
                modelId = state.activeModelId,
                expression = state.currentExpression,
                lipSyncLevel = lipSyncLevel,
                followEnabled = state.followEnabled,
                darkModeEnabled = state.darkModeEnabled,
                onStageReady = onStageReady,
                modelScaleMultiplier = state.modelScaleMultiplier,
                modelOffsetX = state.modelOffsetX,
                modelOffsetY = state.modelOffsetY,
                topInsetPx = topInsetPx,
                bottomInsetPx = bottomInsetPx,
            )

            if (STAGE_MOCK_OVERLAY_ENABLED) {
                StageModelVisualLayer(
                    compact = compact,
                    modelScaleMultiplier = state.modelScaleMultiplier,
                    modelOffsetX = state.modelOffsetX,
                    modelOffsetY = state.modelOffsetY,
                    topReserve = topStageReserve,
                    bottomReserve = bottomStageReserve,
                )
            }
        }

        TopStageHud(
            state = state,
            compact = compact,
            onRefresh = { viewModel?.refresh() },
            onHomeClick = onHomeClick,
            onMenuClick = onMenuClick,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 10.dp),
        )

        visibleStageError?.let {
            StageNotice(
                text = it,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = if (compact) 88.dp else 98.dp, start = 18.dp, end = 18.dp),
            )
        }

        if (moodRailVisible) {
            MoodRail(
                state = state,
                compact = compact,
                onSelect = { viewModel?.selectMood(it) },
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = if (compact) 24.dp else 42.dp)
                    .offset(y = if (compact) (-18).dp else (-4).dp)
                    .zIndex(3f),
            )
        }

        val visibleConversation = state.messages.takeLast(if (keyboardVisible || compact) 2 else 3)
        if (visibleConversation.isNotEmpty() && !stageControlsVisible) {
        FloatingConversationStack(
                messages = visibleConversation,
                characterName = state.characterName,
                compact = compact,
                isReplyPending = state.isReplyPending,
                replyProgress = state.replyProgress,
                voiceRepliesEnabled = state.voiceRepliesEnabled,
                voicePlaybackActive = voicePlaybackActive,
                voiceSubtitleFrame = activeVoiceSubtitle,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(
                        start = if (compact) 18.dp else 34.dp,
                        end = if (compact) 18.dp else 34.dp,
                        bottom = bottomHudBottomOffset + bottomHudHeight + if (keyboardVisible) {
                            18.dp
                        } else if (compact) {
                            42.dp
                        } else {
                            54.dp
                        },
                    )
                    .fillMaxWidth()
                    .zIndex(2f),
            )
        }

        if (stageControlsVisible) {
            StageControlTray(
                compact = compact,
                characterName = state.characterName,
                zoomPercent = (state.modelScaleMultiplier * 100).roundToInt(),
                onZoomOut = { viewModel?.zoomModel(-0.10f) },
                onZoomIn = { viewModel?.zoomModel(0.10f) },
                onMoveLeft = { viewModel?.nudgeModel(horizontalDelta = -0.06f) },
                onMoveRight = { viewModel?.nudgeModel(horizontalDelta = 0.06f) },
                // Stored offsets follow OpenGL: positive Y moves the model up.
                onMoveUp = { viewModel?.nudgeModel(verticalDelta = 0.06f) },
                onMoveDown = { viewModel?.nudgeModel(verticalDelta = -0.06f) },
                onReset = { viewModel?.resetModelTransform() },
                defaultSaved = defaultFrameSaved,
                onSetDefault = {
                    viewModel?.saveCurrentModelTransformAsDefault()
                    defaultFrameSaved = true
                },
                onClose = { stageControlsVisible = false },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = bottomHudBottomOffset + bottomHudHeight + 28.dp)
                    .zIndex(4f),
            )
        }

        BottomStageHud(
            state = state,
            languageOptions = viewModel?.languageOptions ?: PreviewLanguageOptions,
            onLanguageSelect = { viewModel?.selectLanguage(it) },
            onEndPractice = { onStopVoice(); viewModel?.selectPractice("off") },
            inputValue = inputValue,
            keyboardVisible = keyboardVisible,
            onInputChange = onInputChange,
            onSend = onSend,
            onStopVoice = onStopVoice,
            onVoiceInputClick = onVoiceInputClick,
            controlsVisible = stageControlsVisible,
            onToggleControls = { stageControlsVisible = !stageControlsVisible },
            moodRailVisible = moodRailVisible,
            onToggleMoodRail = { moodRailVisible = !moodRailVisible },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 14.dp)
                .padding(bottom = bottomHudBottomOffset),
        )


    }
}

@Composable
private fun PanelTabScene(
    activeTab: PocketTab,
    characterName: String,
    onTabSelected: (PocketTab) -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(MaterialTheme.colorScheme.background, StagePink))),
    ) {
        PocketBackgroundDecoration()
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 18.dp)
                .padding(top = 24.dp, bottom = 132.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Text(
                    if (activeTab == PocketTab.Lily) characterName else activeTab.name,
                    style = MaterialTheme.typography.headlineMedium,
                    color = PocketPinkDeep,
                    fontWeight = FontWeight.Bold,
                )
            }
            item { content() }
        }
        PocketBottomNav(
            activeTab = activeTab,
            characterName = characterName,
            onTabSelected = onTabSelected,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun TopStageHud(
    state: PocketRealmUiState,
    compact: Boolean,
    onRefresh: () -> Unit,
    onHomeClick: () -> Unit,
    onMenuClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val core = state.health?.componentOrEmpty("core")?.status ?: "offline"
    val voiceStatus = state.health?.componentOrEmpty("voice")?.status ?: "offline"
    val voice = if (state.voiceRepliesEnabled) voiceStatus else "muted"

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IconButton(
                    onClick = onMenuClick,
                    modifier = Modifier.size(38.dp),
                    colors = IconButtonDefaults.iconButtonColors(containerColor = Color.White.copy(alpha = 0.22f)),
                ) {
                    Icon(Icons.Rounded.Menu, contentDescription = "Open quick menu", tint = Color.White, modifier = Modifier.size(21.dp))
                }
                Text(
                    "${state.characterName} Constellation",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = if (compact) 17.sp else 21.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledIconButton(
                    onClick = onHomeClick,
                    modifier = Modifier.size(if (compact) 36.dp else 42.dp),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = PocketVoice),
                ) {
                    Icon(Icons.Rounded.Home, contentDescription = "Home controls", tint = Color.White, modifier = Modifier.size(if (compact) 18.dp else 21.dp))
                }
                FilledIconButton(
                    onClick = onRefresh,
                    modifier = Modifier.size(if (compact) 36.dp else 42.dp),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = PocketPink),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Refresh", tint = Color.White, modifier = Modifier.size(if (compact) 18.dp else 21.dp))
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.fillMaxWidth()) {
            StatusPill(
                icon = Icons.Rounded.Refresh,
                text = if (compact) "Core ${core.shortStageStatus()}" else "Core ${core.titleCaseStatus()}",
                modifier = Modifier.weight(1f),
                compact = compact,
                accentColor = PocketOnline,
                online = core.isOnlineStatus(),
            )
            StatusPill(
                icon = Icons.Rounded.Headphones,
                text = voice.voiceStageLabel(compact),
                modifier = Modifier.weight(1f),
                compact = compact,
                accentColor = PocketVoice,
                online = state.voiceRepliesEnabled && voice.isOnlineStatus(),
            )
            StatusPill(
                text = state.presenceStatus.shortPresenceLabel(),
                dot = true,
                modifier = Modifier.weight(1f),
                compact = compact,
                accentColor = PocketPink,
                online = true,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuickMenuSheet(
    activeTab: PocketTab,
    characterName: String,
    onDismiss: () -> Unit,
    onTabSelected: (PocketTab) -> Unit,
    onOpenHome: () -> Unit,
    onRefresh: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = PocketWhite,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .navigationBarsPadding()
                .padding(bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Quick menu", color = PocketText, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Jump around Lily Constellation", color = PocketSubtle, fontSize = 13.sp)

            QuickMenuItem(Icons.Rounded.ChatBubble, "Chat", "Talk with $characterName", activeTab == PocketTab.Chat) {
                onTabSelected(PocketTab.Chat)
            }
            QuickMenuItem(Icons.Rounded.Check, "Tasks", "Review tools and generated files", activeTab == PocketTab.Tasks) {
                onTabSelected(PocketTab.Tasks)
            }
            QuickMenuItem(Icons.Rounded.Palette, "Wardrobe", "Choose the active Live2D model", activeTab == PocketTab.Wardrobe) {
                onTabSelected(PocketTab.Wardrobe)
            }
            QuickMenuItem(Icons.Rounded.Favorite, characterName, "Mood, language, voice, and presence", activeTab == PocketTab.Lily) {
                onTabSelected(PocketTab.Lily)
            }
            QuickMenuItem(Icons.Rounded.Settings, "Settings", "Core URL and privacy options", activeTab == PocketTab.Settings) {
                onTabSelected(PocketTab.Settings)
            }
            QuickMenuItem(Icons.Rounded.Home, "Home controls", "Lights and saved scenes", false, onOpenHome)
            QuickMenuItem(Icons.Rounded.Refresh, "Refresh Core", "Check the latest connection state", false, onRefresh)
        }
    }
}

@Composable
private fun QuickMenuItem(
    icon: ImageVector,
    title: String,
    subtitle: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) PocketBlush else PocketWhite)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            modifier = Modifier.size(40.dp),
            shape = CircleShape,
            color = if (selected) PocketPink else PocketBlush,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = if (selected) Color.White else PocketPinkDeep, modifier = Modifier.size(20.dp))
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = PocketText, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = PocketSubtle, fontSize = 12.sp)
        }
        if (selected) {
            Icon(Icons.Rounded.Check, contentDescription = "Selected", tint = PocketPinkDeep, modifier = Modifier.size(20.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeControlSheet(
    state: PocketRealmUiState,
    onDismiss: () -> Unit,
    onRefresh: () -> Unit,
    onControl: (String, HomeControlRequest) -> Unit,
    onActivateScene: (String) -> Unit,
    onSaveScene: (String, String) -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = PocketWhite,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 680.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text("Home", color = PocketText, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text("Clairie Lab and local scenes", color = PocketSubtle, fontSize = 13.sp)
                }
                IconButton(onClick = onRefresh, enabled = !state.isHomeRefreshing) {
                    if (state.isHomeRefreshing) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = PocketPink)
                    } else {
                        Icon(Icons.Rounded.Refresh, contentDescription = "Refresh home", tint = PocketPink)
                    }
                }
            }

            state.homeError?.let { error ->
                Surface(color = Color(0xFFFFE4E6), shape = RoundedCornerShape(8.dp)) {
                    Text(error, color = Color(0xFF9F1239), fontSize = 13.sp, modifier = Modifier.padding(12.dp))
                }
            }

            if (state.homeDevices.isEmpty() && !state.isHomeRefreshing) {
                Text("No home devices are available.", color = PocketMuted, modifier = Modifier.padding(vertical = 18.dp))
            }

            state.homeDevices.forEach { device ->
                HomeDeviceControls(
                    device = device,
                    current = state.homeStates[device.id],
                    busy = state.isHomeRefreshing,
                    onControl = { request -> onControl(device.id, request) },
                    onSaveScene = { name -> onSaveScene(name, device.id) },
                )
            }

            if (state.homeScenes.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Scenes", color = PocketText, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    state.homeScenes.forEach { scene ->
                        OutlinedButton(
                            onClick = { onActivateScene(scene.id) },
                            enabled = !state.isHomeRefreshing,
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp),
                        ) {
                            Icon(Icons.Rounded.Palette, contentDescription = null, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(scene.name, modifier = Modifier.weight(1f))
                            Text("${scene.actionCount}", color = PocketMuted)
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun HomeDeviceControls(
    device: HomeDevice,
    current: HomeDeviceState?,
    busy: Boolean,
    onControl: (HomeControlRequest) -> Unit,
    onSaveScene: (String) -> Unit,
) {
    val online = current?.online == true
    var brightness by remember(device.id, current?.brightness) {
        mutableFloatStateOf((current?.brightness ?: 50).toFloat())
    }
    var kelvin by remember(device.id, current?.temperatureKelvin) {
        mutableFloatStateOf((current?.temperatureKelvin ?: 4000).toFloat())
    }
    var sceneName by remember(device.id) { mutableStateOf("") }
    val swatches = listOf(
        Color(0xFFE53935) to listOf(255, 0, 0),
        Color(0xFF22C55E) to listOf(0, 255, 0),
        Color(0xFF3B82F6) to listOf(0, 96, 255),
        Color(0xFFA855F7) to listOf(150, 0, 255),
    )

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = PocketWhite,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, PocketBorder.copy(alpha = 0.65f)),
        shadowElevation = 1.dp,
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(device.name, color = PocketText, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Text(
                        if (online) "${device.room.ifBlank { "Home" }} - ${current?.brightness ?: 0}%" else "Offline",
                        color = if (online) PocketOnline else PocketMuted,
                        fontSize = 12.sp,
                    )
                }
                Switch(
                    checked = current?.state == true,
                    enabled = online && !busy,
                    onCheckedChange = { enabled -> onControl(HomeControlRequest(state = if (enabled) "on" else "off")) },
                )
            }

            Text("Brightness ${brightness.roundToInt()}%", color = PocketSubtle, fontSize = 13.sp)
            Slider(
                value = brightness,
                onValueChange = { brightness = it },
                onValueChangeFinished = {
                    onControl(HomeControlRequest(state = "on", brightness = brightness.roundToInt()))
                },
                enabled = online && !busy,
                valueRange = 1f..100f,
            )

            Text("White ${kelvin.roundToInt()}K", color = PocketSubtle, fontSize = 13.sp)
            Slider(
                value = kelvin,
                onValueChange = { kelvin = it },
                onValueChangeFinished = {
                    onControl(HomeControlRequest(state = "on", temperatureKelvin = kelvin.roundToInt()))
                },
                enabled = online && !busy,
                valueRange = 2200f..6500f,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                swatches.forEach { (color, rgb) ->
                    Surface(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(CircleShape)
                            .clickable(enabled = online && !busy) {
                                onControl(HomeControlRequest(state = "on", rgb = rgb))
                            },
                        shape = CircleShape,
                        color = color,
                        border = BorderStroke(2.dp, Color.White),
                        shadowElevation = 2.dp,
                    ) {}
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = sceneName,
                    onValueChange = { sceneName = it },
                    label = { Text("Scene name") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        onSaveScene(sceneName)
                        sceneName = ""
                    },
                    enabled = online && sceneName.isNotBlank() && !busy,
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Save")
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FinanceConfirmationSheet(
    draft: FinanceDraft,
    isBusy: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    val transaction = draft.transaction
    ModalBottomSheet(
        onDismissRequest = { if (!isBusy) onCancel() },
        containerColor = PocketWhite,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 22.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Confirm transaction", color = PocketText, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Nothing is saved until you confirm.", color = PocketSubtle, fontSize = 13.sp)
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = PocketWhite,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, PocketBorder),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(formatMoney(transaction.amount, transaction.currency ?: "IDR"), fontSize = 24.sp, fontWeight = FontWeight.Bold, color = PocketPinkDeep)
                    Text(transaction.direction.replaceFirstChar { it.uppercase() }, color = PocketText, fontWeight = FontWeight.SemiBold)
                    Text("${transaction.account} - ${transaction.category}", color = PocketSubtle)
                    transaction.merchant?.takeIf { it.isNotBlank() }?.let { Text(it, color = PocketSubtle) }
                    transaction.note.takeIf { it.isNotBlank() }?.let { Text(it, color = PocketMuted, fontSize = 12.sp) }
                }
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onCancel, enabled = !isBusy, modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp)) {
                    Text("Cancel")
                }
                Button(onClick = onConfirm, enabled = !isBusy, modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp)) {
                    if (isBusy) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                    else Text("Confirm")
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun StageNotice(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = PocketGlass,
        shape = RoundedCornerShape(24.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.55f)),
    ) {
        Text(
            text = text,
            color = PocketText,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun StatusPill(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    dot: Boolean = false,
    compact: Boolean = false,
    accentColor: Color = PocketPink,
    online: Boolean = false,
) {
    Surface(
        modifier = modifier.height(if (compact) 30.dp else 34.dp),
        shape = RoundedCornerShape(24.dp),
        color = if (online) accentColor.copy(alpha = 0.92f) else PocketMuted.copy(alpha = 0.58f),
        border = BorderStroke(1.dp, Color.White.copy(alpha = if (online) 0.35f else 0.18f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = if (compact) 7.dp else 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(if (compact) 12.dp else 14.dp))
                Spacer(Modifier.width(if (compact) 4.dp else 6.dp))
            }
            if (dot) {
                Box(Modifier.size(if (compact) 6.dp else 8.dp).background(Color.White.copy(alpha = 0.88f), CircleShape))
                Spacer(Modifier.width(if (compact) 4.dp else 6.dp))
            }
            Text(
                text,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = if (compact) 10.sp else 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StageModelVisualLayer(
    compact: Boolean,
    modelScaleMultiplier: Float,
    modelOffsetX: Float,
    modelOffsetY: Float,
    topReserve: Dp,
    bottomReserve: Dp,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val modelAspectRatio = 383f / 867f
        val usableStageHeight = (maxHeight - topReserve - bottomReserve).coerceAtLeast(maxHeight * 0.42f)
        val baseHeight = (usableStageHeight * if (compact) 0.92f else 0.96f).coerceAtMost(maxHeight * if (compact) 0.49f else 0.54f)
        val modelHeight = (baseHeight * modelScaleMultiplier).coerceIn(
            maxHeight * 0.34f,
            maxHeight * if (compact) 1.22f else 1.28f,
        )
        Image(
            painter = painterResource(R.drawable.lily_model_mock),
            contentDescription = "Lily preview model",
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .height(modelHeight)
                .width(modelHeight * modelAspectRatio)
                .align(Alignment.Center)
                .offset(
                    x = maxWidth * (modelOffsetX * 0.55f),
                    y = (maxHeight * (-modelOffsetY * 0.38f)) - (bottomReserve * 0.08f) + if (compact) 8.dp else 12.dp,
                ),
        )
    }
}

@Composable
private fun MoodRail(
    state: PocketRealmUiState,
    compact: Boolean,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val moods = listOf(
        Triple("heart", Icons.Rounded.Favorite, PocketPink),
        Triple("smile", Icons.Rounded.SentimentSatisfied, Color(0xFFE6B94B)),
        Triple("talk", Icons.Rounded.ChatBubble, Color(0xFF8294FF)),
        Triple("crown", Icons.Rounded.AutoAwesome, Color(0xFFE7C547)),
        Triple("tune", Icons.Rounded.MusicNote, Color(0xFF9F7AEA)),
    )
    Surface(
        modifier = modifier.width(if (compact) 40.dp else 48.dp),
        color = PocketGlass,
        shape = RoundedCornerShape(34.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.72f)),
        shadowElevation = 5.dp,
    ) {
        Column(
            modifier = Modifier.padding(vertical = 8.dp, horizontal = 5.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 8.dp),
        ) {
            Box(Modifier.width(28.dp).height(4.dp).background(PocketSubtle.copy(alpha = 0.8f), RoundedCornerShape(8.dp)))
            moods.forEach { (id, icon, tint) ->
                val selected = state.activeMood == id
                Box(
                    modifier = Modifier
                        .size(if (compact) 28.dp else 32.dp)
                        .clip(CircleShape)
                        .background(if (selected) PocketBlush.copy(alpha = 0.92f) else Color.Transparent)
                        .clickable { onSelect(id) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = id, tint = tint, modifier = Modifier.size(if (compact) 18.dp else 21.dp))
                }
            }
        }
    }
}

@Composable
private fun FloatingConversationStack(
    messages: List<ChatBubble>,
    characterName: String,
    compact: Boolean,
    isReplyPending: Boolean,
    replyProgress: String,
    voiceRepliesEnabled: Boolean,
    voicePlaybackActive: Boolean,
    voiceSubtitleFrame: VoiceSubtitleFrame?,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()

    LaunchedEffect(messages.lastOrNull()?.id, isReplyPending, voiceSubtitleFrame?.text) {
        scrollState.animateScrollTo(scrollState.maxValue)
    }

    Column(
        modifier = modifier
            .heightIn(max = if (compact) 332.dp else 392.dp)
            .verticalScroll(scrollState),
        verticalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 8.dp),
    ) {
        messages.forEach { bubble ->
            val fromUser = bubble.sender == "user"
            FloatingChatBubble(
                bubble = bubble,
                characterName = characterName,
                compact = compact,
                fromUser = fromUser,
                modifier = Modifier
                    .align(if (fromUser) Alignment.End else Alignment.Start)
                    .widthIn(max = if (compact) 252.dp else 312.dp),
            )
        }
        if (isReplyPending) {
            VoiceGenerationIndicator(
                characterName = characterName,
                statusText = replyProgress,
                compact = compact,
                modifier = Modifier
                    .align(Alignment.Start)
                    .widthIn(max = if (compact) 252.dp else 312.dp),
            )
        }
        voiceSubtitleFrame?.let { frame ->
            VoiceSubtitleCard(
                characterName = characterName,
                frame = frame,
                playbackActive = voicePlaybackActive,
                compact = compact,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .widthIn(max = if (compact) 286.dp else 344.dp),
            )
        }
    }
}

@Composable
private fun VoiceGenerationIndicator(
    characterName: String,
    statusText: String,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val pulse = rememberInfiniteTransition(label = "lily-reply-pulse")
    val dotAlphas = (0..2).map { index ->
        pulse.animateFloat(
            initialValue = 0.30f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 560, delayMillis = index * 120, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "lily-reply-dot-$index",
        ).value
    }

    Surface(
        modifier = modifier,
        color = PocketWhite.copy(alpha = 0.94f),
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 8.dp, bottomEnd = 20.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.76f)),
        shadowElevation = 6.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 13.dp, vertical = if (compact) 9.dp else 11.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                dotAlphas.forEach { alpha ->
                    Box(
                        Modifier
                            .size((5.5f + alpha).dp)
                            .background(PocketPink.copy(alpha = alpha), CircleShape),
                    )
                }
            }
            Text(
                text = statusText,
                color = PocketPinkDeep,
                fontSize = if (compact) 11.sp else 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun VoiceSubtitleCard(
    characterName: String,
    frame: VoiceSubtitleFrame,
    playbackActive: Boolean,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val spokenCount = frame.spokenCharacterCount.coerceIn(0, frame.text.length)
    val karaokeText = buildAnnotatedString {
        withStyle(SpanStyle(color = PocketPinkDeep, fontWeight = FontWeight.Bold)) {
            append(frame.text.take(spokenCount))
        }
        withStyle(SpanStyle(color = PocketText.copy(alpha = 0.58f))) {
            append(frame.text.drop(spokenCount))
        }
    }

    Surface(
        modifier = modifier,
        color = PocketWhite.copy(alpha = 0.95f),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.82f)),
        shadowElevation = 7.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 13.dp, vertical = if (compact) 9.dp else 11.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Rounded.Headphones,
                    contentDescription = null,
                    tint = PocketVoice,
                    modifier = Modifier.size(if (compact) 14.dp else 16.dp),
                )
                Text(
                    text = if (playbackActive) "$characterName • speaking" else "$characterName • ready",
                    color = PocketVoice,
                    fontSize = if (compact) 9.sp else 10.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Text(
                text = karaokeText,
                fontSize = if (compact) 12.sp else 14.sp,
                lineHeight = if (compact) 16.sp else 19.sp,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            LinearProgressIndicator(
                progress = { frame.progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .clip(RoundedCornerShape(999.dp)),
                color = PocketPink,
                trackColor = PocketBlush,
            )
        }
    }
}

private fun voiceSubtitleFrame(text: String, positionMs: Int, durationMs: Int): VoiceSubtitleFrame? {
    val segments = voiceSubtitleSegments(text)
    if (segments.isEmpty()) return null

    val progress = if (durationMs > 0) {
        positionMs.toFloat().div(durationMs.toFloat()).coerceIn(0f, 1f)
    } else {
        0f
    }
    val weights = segments.map(::voiceSubtitleWeight)
    val totalWeight = weights.sum().coerceAtLeast(1)
    var cursor = progress * totalWeight

    segments.forEachIndexed { index, segment ->
        val segmentWeight = weights[index]
        if (cursor <= segmentWeight || index == segments.lastIndex) {
            val contentWeight = segment.count { !it.isWhitespace() }.coerceAtLeast(1)
            val localProgress = cursor.coerceAtMost(contentWeight.toFloat()).div(contentWeight.toFloat())
            return VoiceSubtitleFrame(
                text = segment,
                spokenCharacterCount = (segment.length * localProgress).roundToInt().coerceIn(0, segment.length),
                progress = progress,
            )
        }
        cursor -= segmentWeight
    }
    return null
}

private fun voiceSubtitleSegments(text: String): List<String> {
    val normalized = text.replace(VoiceSubtitleWhitespace, " ").trim()
    if (normalized.isBlank()) return emptyList()

    val segments = mutableListOf<String>()
    val buffer = StringBuilder()
    fun flush() {
        buffer.toString().trim().takeIf(String::isNotBlank)?.let(segments::add)
        buffer.clear()
    }

    normalized.forEach { character ->
        buffer.append(character)
        val hardBreak = character in ".!?。！？"
        val softBreak = character in ",;:，；："
        if (
            hardBreak ||
            (softBreak && buffer.length >= VoiceSubtitleSegmentLimit / 2) ||
            buffer.length >= VoiceSubtitleSegmentLimit
        ) {
            flush()
        }
    }
    flush()
    return segments
}

private fun voiceSubtitleWeight(segment: String): Int {
    val spokenCharacters = segment.count { !it.isWhitespace() }.coerceAtLeast(1)
    val pauseWeight = if (segment.lastOrNull()?.let { it in ".!?。！？" } == true) 4 else 2
    return spokenCharacters + pauseWeight
}

@Composable
private fun FloatingChatBubble(
    bubble: ChatBubble,
    characterName: String,
    compact: Boolean,
    fromUser: Boolean,
    modifier: Modifier = Modifier,
) {
    val bubbleColor = if (fromUser) PocketPink.copy(alpha = 0.94f) else PocketWhite.copy(alpha = 0.96f)
    val textColor = if (fromUser) Color.White else PocketText
    val labelColor = if (fromUser) Color.White.copy(alpha = 0.96f) else PocketPinkDeep
    val timeColor = if (fromUser) Color.White.copy(alpha = 0.76f) else PocketSubtle
    val label = if (fromUser) "You" else characterName

    Surface(
        modifier = modifier,
        color = bubbleColor,
        shape = RoundedCornerShape(
            topStart = 20.dp,
            topEnd = 20.dp,
            bottomStart = if (fromUser) 20.dp else 8.dp,
            bottomEnd = if (fromUser) 8.dp else 20.dp,
        ),
        border = BorderStroke(1.dp, if (fromUser) Color.White.copy(alpha = 0.34f) else PocketGlassBorder.copy(alpha = 0.76f)),
        shadowElevation = 6.dp,
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(label, color = labelColor, fontWeight = FontWeight.Bold, fontSize = if (compact) 13.sp else 15.sp)
            Text(
                bubble.text,
                color = textColor,
                fontSize = if (compact) 11.sp else 13.sp,
                lineHeight = if (compact) 15.sp else 18.sp,
            )
            Text(
                bubble.timeLabel,
                color = timeColor,
                fontSize = if (compact) 9.sp else 11.sp,
                modifier = Modifier.align(Alignment.End),
            )
            if (!fromUser) bubble.practice?.let { LanguagePracticeNotes(bubble.id, it) }
        }
    }
}

@Composable
private fun StageControlTray(
    compact: Boolean,
    characterName: String,
    zoomPercent: Int,
    onZoomOut: () -> Unit,
    onZoomIn: () -> Unit,
    onMoveLeft: () -> Unit,
    onMoveRight: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onReset: () -> Unit,
    defaultSaved: Boolean,
    onSetDefault: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.width(if (compact) 236.dp else 268.dp),
        color = PocketWhite.copy(alpha = 0.94f),
        shape = RoundedCornerShape(24.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.78f)),
        shadowElevation = 8.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Adjust $characterName", color = PocketText, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                    Surface(
                        color = PocketBlush.copy(alpha = 0.75f),
                        shape = RoundedCornerShape(999.dp),
                    ) {
                        Text(
                            "Zoom $zoomPercent%",
                            color = PocketPinkDeep,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 9.sp,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    MiniControlButton(Icons.Rounded.RestartAlt, "Reset", onReset)
                    MiniControlButton(Icons.Rounded.Close, "Hide controls", onClose)
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MiniControlButton(Icons.Rounded.Remove, "Zoom out", onZoomOut)
                MiniControlButton(Icons.Rounded.Add, "Zoom in", onZoomIn)
                MiniControlButton(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "Move left", onMoveLeft)
                MiniControlButton(Icons.Rounded.KeyboardArrowUp, "Move up", onMoveUp)
                MiniControlButton(Icons.Rounded.KeyboardArrowDown, "Move down", onMoveDown)
                MiniControlButton(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Move right", onMoveRight)
            }
            OutlinedButton(
                onClick = onSetDefault,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(32.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.72f)),
            ) {
                Icon(
                    if (defaultSaved) Icons.Rounded.Check else Icons.Rounded.Settings,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = if (defaultSaved) Color(0xFF2B9B62) else PocketPink,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    if (defaultSaved) "Default saved" else "Set as default",
                    color = if (defaultSaved) Color(0xFF2B9B62) else PocketPinkDeep,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun MiniControlButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        shape = CircleShape,
        color = PocketWhite.copy(alpha = 0.94f),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.58f)),
        shadowElevation = 1.dp,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = contentDescription, tint = PocketPink, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
private fun BottomStageHud(
    state: PocketRealmUiState,
    languageOptions: List<RealmLanguageOption>,
    onLanguageSelect: (String) -> Unit,
    onEndPractice: () -> Unit,
    inputValue: TextFieldValue,
    keyboardVisible: Boolean,
    onInputChange: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
    onStopVoice: () -> Unit,
    onVoiceInputClick: () -> Unit,
    controlsVisible: Boolean,
    onToggleControls: () -> Unit,
    moodRailVisible: Boolean,
    onToggleMoodRail: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isSpeaking = state.pendingAudioUrl != null
    val inputText = inputValue.text
    val composerPlaceholder = when {
        state.isVoiceRecording -> "Listening..."
        state.isTranscribingVoice -> "Transcribing..."
        state.isPracticing -> if (state.practiceLanguage == "ja") "Chat in Japanese..." else "Chat in English..."
        else -> "Type a message..."
    }

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (state.isPracticing) {
            Surface(color = PocketWhite.copy(alpha = 0.96f), shape = RoundedCornerShape(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().height(40.dp).padding(start = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(if (state.practiceLanguage == "ja") "Japanese conversation" else "English conversation",
                        color = PocketPinkDeep, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    TextButton(onClick = onEndPractice, enabled = !state.isReplyPending && !state.isVoiceRecording && !state.isTranscribingVoice && !state.isClearingHistory) {
                        Text("End")
                    }
                }
            }
        }
        if (!keyboardVisible) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!state.isPracticing) {
                    LanguageSegmentControl(
                        activeLanguage = state.activeLanguage,
                        options = languageOptions,
                        onSelect = onLanguageSelect,
                        modifier = Modifier.width(116.dp),
                    )
                } else {
                    Text(conversationStyleLabel(state.practiceLevel), color = PocketPinkDeep, fontSize = 12.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                    FloatingHudButton(
                        icon = Icons.Rounded.AutoAwesome,
                        label = if (moodRailVisible) "Hide" else "Mood",
                        selected = moodRailVisible,
                        onClick = onToggleMoodRail,
                        modifier = Modifier.width(62.dp),
                        compact = true,
                    )
                    if (isSpeaking) {
                        FloatingHudButton(icon = Icons.Rounded.Headphones, label = "Stop", onClick = onStopVoice, modifier = Modifier.width(64.dp), compact = true)
                    }
                    FloatingHudButton(
                        icon = Icons.Rounded.Settings,
                        label = if (controlsVisible) "Hide" else "Move",
                        selected = controlsVisible,
                        onClick = onToggleControls,
                        modifier = Modifier.width(66.dp),
                        compact = true,
                    )
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Surface(
                modifier = Modifier
                    .weight(1f)
                    .height(40.dp),
                shape = RoundedCornerShape(28.dp),
                color = PocketWhite.copy(alpha = if (inputText.isBlank()) 0.88f else 0.96f),
                border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.62f)),
                shadowElevation = 3.dp,
            ) {
                BasicTextField(
                    value = inputValue,
                    onValueChange = { value ->
                        if (value.text.length <= 1_000) onInputChange(value)
                    },
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 17.dp, vertical = 9.dp),
                    textStyle = TextStyle(color = PocketText, fontSize = 15.sp, lineHeight = 18.sp),
                    cursorBrush = SolidColor(PocketPinkDeep),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(
                        onSend = {
                            if (inputText.isNotBlank() && !state.isReplyPending && !state.isVoiceRecording && !state.isTranscribingVoice) onSend()
                        },
                    ),
                    decorationBox = { innerTextField ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (inputText.isEmpty()) {
                                Text(
                                    text = composerPlaceholder,
                                    color = Color(0xFF9D8492),
                                    fontSize = 15.sp,
                                    lineHeight = 18.sp,
                                    maxLines = 1,
                                )
                            }
                            innerTextField()
                        }
                    },
                )
            }
            FilledIconButton(
                onClick = onVoiceInputClick,
                enabled = state.isVoiceRecording || (!state.isTranscribingVoice && !state.isReplyPending),
                modifier = Modifier.size(38.dp),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = when {
                        state.isVoiceRecording -> PocketVoice
                        state.isTranscribingVoice -> PocketBlush.copy(alpha = 0.78f)
                        else -> Color.White.copy(alpha = 0.82f)
                    },
                    contentColor = when {
                        state.isVoiceRecording -> Color.White
                        state.isTranscribingVoice -> PocketVoice.copy(alpha = 0.42f)
                        else -> PocketVoice
                    },
                    disabledContainerColor = PocketBlush.copy(alpha = 0.78f),
                    disabledContentColor = PocketVoice.copy(alpha = 0.42f),
                ),
            ) {
                Icon(
                    Icons.Rounded.Mic,
                    contentDescription = if (state.isVoiceRecording) "Stop recording" else "Record voice",
                    tint = if (state.isVoiceRecording) Color.White else PocketVoice,
                )
            }
            FilledIconButton(
                onClick = onSend,
                enabled = inputText.isNotBlank() && !state.isReplyPending,
                modifier = Modifier.size(38.dp),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = PocketPink,
                    disabledContainerColor = PocketBlush.copy(alpha = 0.78f),
                    disabledContentColor = PocketPink.copy(alpha = 0.42f),
                ),
            ) {
                Icon(
                    Icons.AutoMirrored.Rounded.Send,
                    contentDescription = "Send",
                    tint = if (inputText.isNotBlank() && !state.isReplyPending) Color.White else PocketPink.copy(alpha = 0.42f),
                )
            }
        }
    }
}

@Composable
private fun LanguageSegmentControl(
    activeLanguage: String,
    options: List<RealmLanguageOption>,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.height(36.dp),
        color = PocketGlass,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.72f)),
        shadowElevation = 2.dp,
    ) {
        Row(
            modifier = Modifier.padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            options.forEach { option ->
                val selected = activeLanguage == option.id
                val shortLabel = if (option.id == "ja") "JP" else option.id.uppercase()
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxSize()
                        .clip(RoundedCornerShape(15.dp))
                        .background(if (selected) PocketBlush.copy(alpha = 0.96f) else Color.Transparent)
                        .clickable { onSelect(option.id) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = shortLabel,
                        color = if (selected) PocketPink else PocketPinkDeep.copy(alpha = 0.82f),
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp,
                        lineHeight = 15.sp,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun FloatingHudButton(
    label: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    selected: Boolean = false,
    compact: Boolean = false,
    onClick: () -> Unit,
) {
    Surface(
        modifier = modifier
            .height(if (compact) 34.dp else 42.dp)
            .clickable(onClick = onClick),
        color = if (selected) PocketPink else PocketGlass,
        shape = RoundedCornerShape(if (compact) 18.dp else 22.dp),
        border = BorderStroke(1.dp, if (selected) PocketPink else PocketGlassBorder.copy(alpha = 0.72f)),
        shadowElevation = if (selected) 7.dp else 2.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = if (compact) 8.dp else 12.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = if (selected) Color.White else PocketPink, modifier = Modifier.size(if (compact) 15.dp else 20.dp))
                Spacer(Modifier.width(if (compact) 3.dp else 6.dp))
            }
            Text(
                label,
                color = if (selected) Color.White else PocketPinkDeep,
                fontWeight = FontWeight.Bold,
                fontSize = if (compact) 10.sp else 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SmallRoundButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(34.dp),
        colors = IconButtonDefaults.iconButtonColors(containerColor = PocketGlass),
    ) {
        Icon(icon, contentDescription = contentDescription, tint = PocketPink, modifier = Modifier.size(19.dp))
    }
}

@Composable
private fun PocketBottomNav(
    activeTab: PocketTab,
    characterName: String,
    onTabSelected: (PocketTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val navShape = RoundedCornerShape(12.dp)
    val tabs = listOf(
        Triple(PocketTab.Chat, Icons.Rounded.ChatBubble, "Chat"),
        Triple(PocketTab.Tasks, Icons.Rounded.Check, "Tasks"),
        Triple(PocketTab.Wardrobe, Icons.Rounded.AutoAwesome, "Wardrobe"),
        Triple(PocketTab.Lily, Icons.Rounded.Favorite, characterName),
        Triple(PocketTab.Settings, Icons.Rounded.Settings, "Settings"),
    )
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .shadow(5.dp, navShape, clip = false)
            .clip(navShape)
            .background(PocketWhite.copy(alpha = 0.92f))
            .border(1.dp, PocketGlassBorder.copy(alpha = 0.68f), navShape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 6.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEach { (tab, icon, label) ->
                val selected = activeTab == tab
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable { onTabSelected(tab) }
                        .padding(vertical = 2.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(width = 50.dp, height = 25.dp)
                            .widthIn(min = 36.dp, max = 46.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selected) PocketBlush.copy(alpha = 0.98f) else Color.Transparent),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            icon,
                            contentDescription = label,
                            tint = if (selected) PocketPink else PocketText.copy(alpha = 0.72f),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    Text(
                        label,
                        color = if (selected) PocketPink else PocketText.copy(alpha = 0.72f),
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 7.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun PocketBackgroundDecoration(modifier: Modifier = Modifier) {
    val motion = rememberInfiniteTransition(label = "pocket-background-motion")
    val orbitProgress by motion.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 12_000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "bubble-orbit",
    )
    val pulseProgress by motion.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 7_500, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "bubble-pulse",
    )

    Canvas(modifier = modifier.fillMaxSize()) {
        drawCircle(
            color = Color.White.copy(alpha = 0.05f),
            radius = size.minDimension * 0.46f,
            center = Offset(size.width * 0.54f, size.height * 0.46f),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.dp.toPx()),
        )
        val bubbles = listOf(
            Offset(size.width * 0.23f, size.height * 0.24f),
            Offset(size.width * 0.88f, size.height * 0.25f),
            Offset(size.width * 0.13f, size.height * 0.66f),
            Offset(size.width * 0.86f, size.height * 0.70f),
        )
        bubbles.forEachIndexed { index, anchor ->
            val direction = if (index % 2 == 0) 1f else -1f
            val angle = orbitProgress * (2f * PI.toFloat()) * direction + index * 1.37f
            val center = anchor + Offset(
                x = cos(angle.toDouble()).toFloat() * (7 + index * 2).dp.toPx(),
                y = sin(angle.toDouble()).toFloat() * (10 + index * 2).dp.toPx(),
            )
            val pulseAngle = pulseProgress * 2f * PI.toFloat() + index
            val pulse = 1f + sin(pulseAngle.toDouble()).toFloat() * 0.045f
            val radius = (26 + index * 7).dp.toPx() * pulse
            drawCircle(Color.White.copy(alpha = 0.08f), radius = radius, center = center)
            drawCircle(
                Color.White.copy(alpha = 0.14f),
                radius = radius,
                center = center,
                style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5.dp.toPx()),
            )
        }
    }
}

@Composable
private fun TasksTab(
    state: PocketRealmUiState,
    viewModel: PocketRealmViewModel,
    tasks: List<ToolTask>,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onCancel: (String) -> Unit,
    onRetryExecution: (String) -> Unit,
    onRetryDelivery: (String) -> Unit,
    onSelectTask: (ToolTask) -> Unit,
    onDownloadArtifact: (ToolTask, ToolArtifact) -> Unit,
    onPreviewArtifact: (ToolTask, ToolArtifact) -> Unit,
    onRefreshTasks: () -> Unit,
    onRefreshMaintenance: () -> Unit,
    onPruneArtifacts: () -> Unit,
    onUseTemplate: (String) -> Unit,
    onControlHome: (String, HomeControlRequest) -> Unit,
    onActivateScene: (String) -> Unit,
    onSaveScene: (String, String) -> Unit,
) {
    var section by remember { mutableStateOf(if (state.waInboxOpenRequest != null) "Inbox" else "Tasks") }
    LaunchedEffect(state.waInboxOpenRequest) {
        if (state.waInboxOpenRequest != null) section = "Inbox"
    }
    var receiptAccount by remember { mutableStateOf("") }
    var receiptHint by remember { mutableStateOf("") }
    val receiptPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { viewModel.parseFinanceReceipt(it, receiptAccount, receiptHint) }
    }

    LaunchedEffect(section) {
        if (section == "Inbox") viewModel.refreshWaInbox()
        if (section == "Finance") viewModel.refreshFinance()
        if (section == "Home") viewModel.refreshHome()
        if (section == "Family") viewModel.refreshFamily()
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Tasks", "Inbox", "Home", "Finance", "Family").forEach { label ->
                FloatingHudButton(
                    label = label,
                    modifier = Modifier.widthIn(min = 78.dp),
                    icon = when (label) {
                        "Tasks" -> Icons.Rounded.Check
                        "Home" -> Icons.Rounded.Home
                        "Inbox" -> Icons.Rounded.ChatBubble
                        "Family" -> Icons.Rounded.People
                        else -> Icons.Rounded.AccountBalanceWallet
                    },
                    selected = section == label,
                    onClick = { section = label },
                )
            }
        }

        if (section == "Inbox") WaInboxPanel(state, viewModel)
        if (section == "Family") FamilyTab(state, viewModel)

        if (section == "Tasks") {
            val pending = tasks.filter { it.status == "pending" }
            val history = tasks.filterNot { it.status == "pending" }
            PanelCard(title = "Task overview") {
                TaskStatusSummary(tasks)
            }
            PanelCard(title = "Task templates") {
                Text("Tap a template to continue the request in Chat.", color = PocketSubtle, fontSize = 11.sp)
                ToolTaskTemplates.forEach { (label, prompt) ->
                    OutlinedButton(
                        onClick = { onUseTemplate(prompt) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(label, modifier = Modifier.weight(1f))
                        Text("Use", color = PocketPinkDeep, fontSize = 11.sp)
                    }
                }
            }
            PanelCard(title = "Pending approvals (${pending.size})") {
                if (pending.isEmpty()) {
                    EmptyPanelText("No pending tool approvals right now.")
                } else {
                    pending.forEach { task ->
                        TaskCard(
                            task = task,
                            onOpenDetails = { onSelectTask(task) },
                            onApprove = { onApprove(task.id) },
                            onDeny = { onDeny(task.id) },
                            onCancel = { onCancel(task.id) },
                            onRetryExecution = { onRetryExecution(task.id) },
                            onRetryDelivery = { onRetryDelivery(task.id) },
                        )
                    }
                }
            }
            PanelCard(title = "Recent tasks (${history.size})") {
                if (history.isEmpty()) {
                    EmptyPanelText("No completed or failed tool tasks yet.")
                } else {
                    history.forEach { task ->
                        TaskCard(
                            task = task,
                            onOpenDetails = { onSelectTask(task) },
                            onCancel = { onCancel(task.id) },
                            onRetryExecution = { onRetryExecution(task.id) },
                            onRetryDelivery = { onRetryDelivery(task.id) },
                        )
                    }
                }
            }
            val recoveryTasks = tasks.filter { it.recoveryRequired }
            PanelCard(title = "Delivery recovery (${recoveryTasks.size})") {
                if (recoveryTasks.isEmpty()) {
                    EmptyPanelText("No failed artifact deliveries need recovery.")
                } else {
                    recoveryTasks.forEach { task ->
                        TaskCard(
                            task = task,
                            onOpenDetails = { onSelectTask(task) },
                            onRetryDelivery = { onRetryDelivery(task.id) },
                        )
                    }
                }
            }
            PanelCard(title = "Artifact maintenance") {
                val maintenance = state.toolMaintenance
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            if (maintenance == null) "Maintenance status is not loaded."
                            else "${maintenance.artifactCount} artifacts · ${formatArtifactSize(maintenance.artifactBytes)} · ${maintenance.quotaUsedPercent}% quota",
                            color = PocketSubtle,
                            fontSize = 11.sp,
                        )
                        maintenance?.let {
                            Text("Retention ${it.retentionDays} days · ${it.prunableCount} prunable", color = PocketSubtle, fontSize = 11.sp)
                        }
                    }
                    IconButton(onClick = onRefreshMaintenance, enabled = !state.isToolMaintenanceRefreshing) {
                        Icon(Icons.Rounded.Refresh, contentDescription = "Refresh artifact maintenance", tint = PocketPink)
                    }
                }
                state.toolMaintenanceMessage?.let { Text(it, color = PocketPinkDeep, fontSize = 11.sp) }
                OutlinedButton(
                    onClick = onPruneArtifacts,
                    enabled = !state.isToolMaintenanceRefreshing,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Prune expired artifacts") }
            }
            state.artifactMessage?.let { message ->
                Text(message, color = PocketPinkDeep, fontSize = 12.sp)
            }
        } else if (section == "Home") {
            PanelCard(title = "Home devices") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Direct controls through Lily Core", color = PocketSubtle, fontSize = 12.sp)
                    IconButton(onClick = viewModel::refreshHome, enabled = !state.isHomeRefreshing) {
                        if (state.isHomeRefreshing) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = PocketPink)
                        } else {
                            Icon(Icons.Rounded.Refresh, contentDescription = "Refresh Home", tint = PocketPink)
                        }
                    }
                }
                state.homeError?.let { Text(it, color = Color(0xFFBE123C), fontSize = 12.sp) }
                if (state.homeDevices.isEmpty() && !state.isHomeRefreshing) {
                    EmptyPanelText("No Home devices are available from Core.")
                }
                state.homeDevices.forEach { device ->
                    HomeDeviceControls(
                        device = device,
                        current = state.homeStates[device.id],
                        busy = state.isHomeRefreshing,
                        onControl = { request -> onControlHome(device.id, request) },
                        onSaveScene = { name -> onSaveScene(name, device.id) },
                    )
                }
            }
            if (state.homeScenes.isNotEmpty()) {
                PanelCard(title = "Scenes") {
                    state.homeScenes.forEach { scene ->
                        OutlinedButton(
                            onClick = { onActivateScene(scene.id) },
                            enabled = !state.isHomeRefreshing,
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp),
                        ) {
                            Icon(Icons.Rounded.Palette, contentDescription = null, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(scene.name, modifier = Modifier.weight(1f))
                            Text("${scene.actionCount}", color = PocketMuted)
                        }
                    }
                }
            }
        } else if (section == "Finance") {
            FinanceTab(
                state = state,
                onRefresh = viewModel::refreshFinance,
                onCreateDraft = viewModel::createFinanceDraft,
                onReceipt = { account, hint ->
                    receiptAccount = account
                    receiptHint = hint
                    receiptPicker.launch("image/*")
                },
            )
        }
    }

    state.selectedTask?.let { task ->
        TaskDetailDialog(
            task = task,
            onDismiss = { viewModel.clearSelectedTask() },
            onApprove = { onApprove(task.id) },
            onDeny = { onDeny(task.id) },
            onCancel = { onCancel(task.id) },
            onRetryExecution = { onRetryExecution(task.id) },
            onRetryDelivery = { onRetryDelivery(task.id) },
            onDownloadArtifact = onDownloadArtifact,
            onPreviewArtifact = onPreviewArtifact,
            onRefresh = onRefreshTasks,
            downloadedArtifact = state.downloadedArtifact,
            isDownloadingArtifact = state.isDownloadingArtifact,
            artifactPreviewText = state.artifactPreviewText,
            onClearArtifactPreview = viewModel::clearArtifactPreview,
        )
    }
}

@Composable
private fun FamilyTab(state: PocketRealmUiState, viewModel: PocketRealmViewModel) {
    val context = LocalContext.current
    var copiedInvitation by remember { mutableStateOf(false) }

    PanelCard(title = "Family sharing") {
        Text(
            "Separate household phones with local SMS and location consent. Owner-only data stays out of Lily chat.",
            color = PocketSubtle,
            fontSize = 12.sp,
        )
        state.familyError?.let { Text(it, color = Color(0xFFBE123C), fontSize = 12.sp) }
        state.familyNotice?.let { Text(it, color = PocketOnline, fontSize = 12.sp) }
        Button(
            onClick = viewModel::createFamilyInvitation,
            enabled = !state.isFamilyRefreshing,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PocketPink),
        ) {
            Text(if (state.isFamilyRefreshing) "Working…" else "Create one-use invitation")
        }
        state.familyInvitation?.let { invitation ->
            Text("Share this code with the family phone. It can be used once and expires ${familyTime(invitation.expiresAt)}.", color = PocketSubtle, fontSize = 11.sp)
            Text(invitation.invitationToken, color = PocketText, fontSize = 13.sp)
            OutlinedButton(
                onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Lily Family invitation", invitation.invitationToken))
                    copiedInvitation = true
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (copiedInvitation) "Invitation copied" else "Copy invitation") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Pending requests: ${state.familyPairingRequests.size}", color = PocketSubtle, fontSize = 12.sp, modifier = Modifier.weight(1f))
            IconButton(onClick = viewModel::refreshFamily, enabled = !state.isFamilyRefreshing) {
                if (state.isFamilyRefreshing) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = PocketPink)
                else Icon(Icons.Rounded.Refresh, contentDescription = "Refresh Family", tint = PocketPink)
            }
        }
        if (state.familyPairingRequests.isEmpty()) EmptyPanelText("No pairing requests are waiting for approval.")
        state.familyPairingRequests.forEach { request ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${request.name} · ${request.platform}", color = PocketText, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                Text("Invitation expires ${familyTime(request.expiresAt)}", color = PocketMuted, fontSize = 11.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { viewModel.decideFamilyPairing(request.id, true) },
                        enabled = !state.isFamilyRefreshing,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = PocketPink),
                    ) { Text("Approve") }
                    OutlinedButton(
                        onClick = { viewModel.decideFamilyPairing(request.id, false) },
                        enabled = !state.isFamilyRefreshing,
                        modifier = Modifier.weight(1f),
                    ) { Text("Decline") }
                }
            }
            HorizontalDivider(color = PocketBorder.copy(alpha = 0.6f))
        }
    }

    PanelCard(title = "Paired phones (${state.familyDevices.size})") {
        if (state.familyDevices.isEmpty()) EmptyPanelText("No family phones are paired yet.")
        state.familyDevices.forEach { device ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(device.name, color = PocketText, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text(if (device.online) "Online" else "Offline / stale", color = if (device.online) PocketOnline else PocketMuted, fontSize = 11.sp)
                }
                Text(
                    "Last sync ${familyTime(device.lastSeenAt)} · SMS ${if (device.smsPermission) "on" else "off"} · location ${if (device.locationPermission) device.locationMode else "off"}",
                    color = PocketSubtle,
                    fontSize = 11.sp,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { viewModel.loadFamilySms(device.id) },
                        enabled = !state.isFamilyRefreshing,
                        modifier = Modifier.weight(1f),
                    ) { Text("Private SMS") }
                    OutlinedButton(
                        onClick = { viewModel.loadFamilyLocation(device.id) },
                        enabled = !state.isFamilyRefreshing,
                        modifier = Modifier.weight(1f),
                    ) { Text("Location") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { viewModel.requestFamilyLocationMode(device.id, "live") },
                        enabled = !state.isFamilyRefreshing && device.locationPermission,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = PocketPink),
                    ) { Text("Request live") }
                    OutlinedButton(
                        onClick = { viewModel.requestFamilyLocationMode(device.id, "eco") },
                        enabled = !state.isFamilyRefreshing,
                        modifier = Modifier.weight(1f),
                    ) { Text("Request eco") }
                }
                state.familyLocations[device.id]?.let { location ->
                    Text(
                        "${"%.5f".format(Locale.ROOT, location.latitude)}, ${"%.5f".format(Locale.ROOT, location.longitude)} · ±${location.accuracyM.roundToInt()} m",
                        color = PocketText,
                        fontSize = 12.sp,
                    )
                    Text("Captured ${familyTime(location.capturedAt)} · ${if (location.stale) "stale" else "fresh"} · ${location.mode}", color = PocketSubtle, fontSize = 11.sp)
                }
                state.familyCommands[device.id].orEmpty().take(2).forEach { command ->
                    val mode = command.payload["mode"]?.toString()?.trim('"') ?: command.type
                    Text("$mode request: ${command.status}${command.error.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty()}", color = PocketSubtle, fontSize = 11.sp)
                }
            }
            HorizontalDivider(color = PocketBorder.copy(alpha = 0.6f))
        }
    }

    state.familySmsDeviceId?.let { deviceId ->
        PanelCard(title = "Private SMS · ${state.familyDevices.firstOrNull { it.id == deviceId }?.name ?: "Family phone"}") {
            Text("Recent messages are retained for 24 hours. This content is shown only here.", color = PocketSubtle, fontSize = 11.sp)
            TextButton(onClick = viewModel::closeFamilySms) { Text("Close viewer") }
            if (state.familySmsItems.isEmpty()) EmptyPanelText("No SMS in the last 24 hours.")
            state.familySmsItems.forEach { message ->
                Text("${message.sender} · ${familyTime(message.receivedAt)}", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
                Text(message.body, color = PocketText, fontSize = 13.sp)
                HorizontalDivider(color = PocketBorder.copy(alpha = 0.5f))
            }
        }
    }
}

private fun familyTime(seconds: Double?): String {
    if (seconds == null || seconds <= 0.0) return "not reported"
    return runCatching {
        Instant.ofEpochMilli((seconds * 1000).toLong())
            .atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.getDefault()))
    }.getOrDefault("not reported")
}

@Composable
private fun FinanceTab(
    state: PocketRealmUiState,
    onRefresh: () -> Unit,
    onCreateDraft: (FinanceTransactionInput) -> Unit,
    onReceipt: (String, String) -> Unit,
) {
    val summary = state.financeSummary
    var direction by remember { mutableStateOf("expense") }
    var amount by remember { mutableStateOf("") }
    var account by remember { mutableStateOf("") }
    var toAccount by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("uncategorized") }
    var merchant by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }

    LaunchedEffect(summary?.accounts) {
        if (account.isBlank()) account = summary?.accounts?.firstOrNull()?.name.orEmpty()
    }

    PanelCard(title = "Balance") {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(formatMoney(summary?.totalBalance ?: 0, summary?.currency ?: "IDR"), color = PocketText, fontSize = 25.sp, fontWeight = FontWeight.Bold)
                Text(summary?.month ?: "Current balance", color = PocketSubtle, fontSize = 12.sp)
            }
            IconButton(onClick = onRefresh, enabled = !state.isFinanceRefreshing) {
                if (state.isFinanceRefreshing) CircularProgressIndicator(modifier = Modifier.size(19.dp), strokeWidth = 2.dp, color = PocketPink)
                else Icon(Icons.Rounded.Refresh, contentDescription = "Refresh Finance", tint = PocketPink)
            }
        }
        summary?.accounts.orEmpty().forEach { item ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(item.label, color = PocketSubtle)
                Text(formatMoney(item.balance, item.currency), color = PocketText, fontWeight = FontWeight.SemiBold)
            }
        }
        state.financeError?.let { Text(it, color = Color(0xFFBE123C), fontSize = 12.sp) }
    }

    PanelCard(title = "New draft") {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            listOf("expense", "income", "transfer").forEach { option ->
                FloatingHudButton(
                    label = option.replaceFirstChar { it.uppercase() },
                    selected = direction == option,
                    compact = true,
                    onClick = { direction = option },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        OutlinedTextField(value = amount, onValueChange = { amount = it.filter(Char::isDigit).take(15) }, label = { Text("Amount") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = account, onValueChange = { account = it.take(40) }, label = { Text("Account") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        if (direction == "transfer") {
            OutlinedTextField(value = toAccount, onValueChange = { toAccount = it.take(40) }, label = { Text("To account") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        OutlinedTextField(value = category, onValueChange = { category = it.take(80) }, label = { Text("Category") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = merchant, onValueChange = { merchant = it.take(120) }, label = { Text("Merchant") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = note, onValueChange = { note = it.take(500) }, label = { Text("Note") }, modifier = Modifier.fillMaxWidth())
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onReceipt(account, note) },
                enabled = !state.isFinanceRefreshing,
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(8.dp),
            ) {
                Icon(Icons.Rounded.ReceiptLong, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Receipt")
            }
            Button(
                onClick = {
                    val parsedAmount = amount.toLongOrNull() ?: return@Button
                    onCreateDraft(
                        FinanceTransactionInput(
                            direction = direction,
                            amount = parsedAmount,
                            account = account.trim(),
                            toAccount = toAccount.trim().ifBlank { null },
                            category = category.trim().ifBlank { "uncategorized" },
                            merchant = merchant.trim().ifBlank { null },
                            note = note.trim(),
                        )
                    )
                },
                enabled = !state.isFinanceRefreshing && amount.toLongOrNull() != null && account.isNotBlank() && (direction != "transfer" || toAccount.isNotBlank()),
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(8.dp),
            ) {
                Text("Review")
            }
        }
    }

    PanelCard(title = "Recent transactions") {
        if (state.financeTransactions.isEmpty()) {
            EmptyPanelText("No transactions to show yet.")
        } else {
            state.financeTransactions.take(8).forEach { transaction ->
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(transaction.merchant ?: transaction.category, color = PocketText, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(transaction.account, color = PocketMuted, fontSize = 11.sp)
                    }
                    Text(
                        "${if (transaction.direction == "income") "+" else "-"}${formatMoney(transaction.amount, transaction.currency ?: summary?.currency ?: "IDR")}",
                        color = if (transaction.direction == "income") PocketOnline else PocketText,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }

}

private fun formatMoney(amount: Long, currency: String): String {
    val formatter = NumberFormat.getNumberInstance(Locale("id", "ID"))
    return "$currency ${formatter.format(amount)}"
}

@Composable
private fun WardrobeTab(state: PocketRealmUiState, viewModel: PocketRealmViewModel) {
    val activeModel = viewModel.modelOptions.firstOrNull { it.id == state.activeModelId }
        ?: viewModel.modelOptions.first()

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(390.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(StagePink.copy(alpha = 0.56f))
                .border(1.dp, PocketGlassBorder.copy(alpha = 0.72f), RoundedCornerShape(8.dp)),
        ) {
            Live2DStageHost(
                modifier = Modifier.fillMaxSize(),
                modelId = state.activeModelId,
                expression = state.currentExpression,
                lipSyncLevel = 0f,
                followEnabled = state.followEnabled,
                darkModeEnabled = state.darkModeEnabled,
                modelScaleMultiplier = 1.12f,
                modelOffsetX = 0f,
                modelOffsetY = 0.02f,
                topInsetPx = 54,
                bottomInsetPx = 34,
            )
            Column(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text("FITTING ROOM", color = PocketPinkDeep, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text(activeModel.label, color = PocketText, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(12.dp),
                color = PocketWhite.copy(alpha = 0.88f),
                shape = RoundedCornerShape(999.dp),
                border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.62f)),
            ) {
                Text(
                    "${activeModel.expressionCount} EXPRESSIONS",
                    color = PocketPinkDeep,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }

        Text("Outfits", fontWeight = FontWeight.SemiBold, color = PocketText)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            viewModel.modelOptions.forEachIndexed { index, model ->
                val selected = state.activeModelId == model.id
                Surface(
                    modifier = Modifier
                        .weight(1f)
                        .height(104.dp)
                        .clickable { viewModel.selectModel(model.id) },
                    color = if (selected) PocketBlush else PocketWhite.copy(alpha = 0.90f),
                    shape = RoundedCornerShape(8.dp),
                    border = BorderStroke(1.dp, if (selected) PocketPink else PocketBorder.copy(alpha = 0.65f)),
                    shadowElevation = if (selected) 5.dp else 1.dp,
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("LOOK ${index + 1}", color = PocketMuted, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                            if (selected) Icon(Icons.Rounded.Check, contentDescription = "Selected", tint = PocketPink, modifier = Modifier.size(18.dp))
                        }
                        Text(model.label, color = PocketText, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        Text(model.detail, color = PocketSubtle, fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }

        Text("Expression", fontWeight = FontWeight.SemiBold, color = PocketText)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            FloatingHudButton(
                label = "Default",
                icon = Icons.Rounded.Favorite,
                selected = state.activeMood == "talk",
                onClick = { viewModel.selectMood("talk") },
                modifier = Modifier.weight(1f),
            )
            FloatingHudButton(
                label = "Sweet",
                icon = Icons.Rounded.AutoAwesome,
                selected = state.activeMood == "heart",
                onClick = { viewModel.selectMood("heart") },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun LilyPreferencesTab(
    state: PocketRealmUiState,
    viewModel: PocketRealmViewModel,
    onStopVoice: () -> Unit,
) {
    var noteDraft by remember(state.presenceNote) { mutableStateOf(state.presenceNote) }
    var characterNameDraft by remember(state.characterName) { mutableStateOf(state.characterName) }
    PanelCard(title = state.characterName) {
        Text("Character behavior, text language, mood, and voice.", color = PocketSubtle)

        LanguagePracticeControls(state) { language, level ->
            onStopVoice()
            viewModel.selectPractice(language, level)
        }

        Text("Character identity", fontWeight = FontWeight.SemiBold, color = PocketText)
        OutlinedTextField(
            value = characterNameDraft,
            onValueChange = { characterNameDraft = it.take(24) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Character name") },
            supportingText = { Text("Shown in chat, voice status, notifications, and sent to Core.") },
            singleLine = true,
        )
        Button(
            onClick = { characterNameDraft = viewModel.updateCharacterName(characterNameDraft) },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PocketPink),
        ) {
            Text("Save character name")
        }

        Text("Text language", fontWeight = FontWeight.SemiBold, color = PocketText)
        LanguageSegmentControl(
            activeLanguage = state.activeLanguage,
            options = viewModel.languageOptions,
            onSelect = { viewModel.selectLanguage(it) },
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Controls ${state.characterName}'s chat bubbles. Voice can use a different language.", color = PocketSubtle, fontSize = 12.sp)

        Text("How ${state.characterName} calls you", fontWeight = FontWeight.SemiBold, color = PocketText)
        viewModel.addressTermOptions(state.activeLanguage).chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { option ->
                    FloatingHudButton(
                        label = option.label,
                        selected = state.addressTerm == option.id,
                        onClick = { viewModel.selectAddressTerm(option.id) },
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        Text(
            "Japanese: ダーリン is the natural TTS spelling (dārin); あなた sounds more spouse-like.",
            color = PocketSubtle,
            fontSize = 12.sp,
        )

        Text("Mood", fontWeight = FontWeight.SemiBold, color = PocketText)
        Text(
            "Live: ${state.ownerMood.replaceFirstChar { it.uppercase() }} · ${state.ownerMoodIntensity}/100 · ${state.currentExpression}",
            color = PocketSubtle,
            fontSize = 12.sp,
        )
        viewModel.moodOptions.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { option ->
                    FloatingHudButton(
                        label = option.label,
                        selected = state.activeMood == option.id,
                        onClick = { viewModel.selectMood(option.id) },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
                Text("Voice replies", fontWeight = FontWeight.SemiBold, color = PocketText)
                Text(if (state.voiceRepliesEnabled) "On" else "Off", color = PocketSubtle, fontSize = 12.sp)
            }
            Switch(checked = state.voiceRepliesEnabled, onCheckedChange = viewModel::setVoiceRepliesEnabled)
        }

        Text("Voice language", fontWeight = FontWeight.SemiBold, color = PocketText)
        LanguageSegmentControl(
            activeLanguage = state.voiceLanguage,
            options = viewModel.voiceLanguageOptions,
            onSelect = { viewModel.selectVoiceLanguage(it) },
            modifier = Modifier.fillMaxWidth(),
        )

        Text("Voice engine", fontWeight = FontWeight.SemiBold, color = PocketText)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            viewModel.voiceRouteOptions.forEach { option ->
                FloatingHudButton(
                    label = option.label,
                    selected = state.voiceRoute == option.id,
                    onClick = { viewModel.selectVoiceRoute(option.id) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        Text(
            if (state.voiceLanguage == "id") "Indonesian uses the Alibaba clone with SoVITS (auto) or Alibaba."
            else "SoVITS lokal, RVC lewat Stream Voice, atau Alibaba Qwen clone.",
            color = PocketSubtle,
            fontSize = 12.sp,
        )

        if (state.voiceLanguage == "en") {
            Text("English voice", fontWeight = FontWeight.SemiBold, color = PocketText)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                viewModel.englishVoiceOptions.forEach { option ->
                    FloatingHudButton(
                        label = option.label,
                        selected = state.englishVoiceProfile == option.id,
                        onClick = { viewModel.selectEnglishVoiceProfile(option.id) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        } else if (state.voiceLanguage == "ja") {
            Text("Japanese voice", fontWeight = FontWeight.SemiBold, color = PocketText)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                viewModel.japaneseVoiceOptions.forEach { option ->
                    FloatingHudButton(
                        label = option.label,
                        selected = state.japaneseVoiceProfile == option.id,
                        onClick = { viewModel.selectJapaneseVoiceProfile(option.id) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        if (state.pendingAudioUrl != null) {
            FloatingHudButton(
                label = "Stop voice",
                icon = Icons.Rounded.Headphones,
                selected = true,
                onClick = onStopVoice,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Text("Presence", fontWeight = FontWeight.SemiBold, color = PocketText)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Automatic presence", color = PocketText)
                Text(
                    if (state.presenceAutomatic) "Event-based; no background heartbeat" else "Manual status has priority",
                    fontSize = 12.sp,
                    color = PocketSubtle,
                )
            }
            Switch(
                checked = state.automaticPresenceEnabled,
                onCheckedChange = viewModel::setAutomaticPresenceEnabled,
            )
        }
        viewModel.presenceOptions.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { option ->
                    FloatingHudButton(
                        label = option.label,
                        selected = state.presenceStatus == option.id,
                        onClick = { viewModel.updatePresenceDraft(option.id, noteDraft) },
                        modifier = Modifier.weight(1f),
                        compact = true,
                    )
                }
            }
        }
        OutlinedTextField(
            value = noteDraft,
            onValueChange = {
                noteDraft = it
                viewModel.updatePresenceDraft(state.presenceStatus, it)
            },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Presence note") },
            supportingText = { Text("Example: Working, keep replies concise.") },
        )
        Button(onClick = { viewModel.submitPresence() }, colors = ButtonDefaults.buttonColors(containerColor = PocketPink)) {
            Text("Update presence")
        }

        HorizontalDivider(color = PocketSubtle.copy(alpha = 0.22f))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Daily rhythm", fontWeight = FontWeight.SemiBold, color = PocketText)
                Text("Sent through ${state.characterName}'s WhatsApp number.", fontSize = 12.sp, color = PocketSubtle)
            }
            Switch(checked = state.routinesEnabled, onCheckedChange = viewModel::setRoutinesEnabled)
        }
        state.routines.forEach { routine ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(routine.label, color = PocketText, fontWeight = FontWeight.Medium)
                    Text(routine.time, color = PocketSubtle, fontSize = 12.sp)
                }
                Switch(
                    checked = routine.enabled,
                    onCheckedChange = { enabled -> viewModel.setRoutineEnabled(routine.id, enabled) },
                    enabled = state.routinesEnabled,
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Stage follow", color = PocketText)
                Text("Simple model follow behavior for the native stage.", fontSize = 12.sp, color = PocketSubtle)
            }
            Switch(checked = state.followEnabled, onCheckedChange = viewModel::setFollowEnabled)
        }
    }
}

@Composable
private fun SettingsTab(state: PocketRealmUiState, viewModel: PocketRealmViewModel) {
    var baseUrlDraft by remember(state.coreBaseUrl) { mutableStateOf(state.coreBaseUrl) }
    var tunnelUrlDraft by remember(state.tunnelBaseUrl) { mutableStateOf(state.tunnelBaseUrl) }
    var connectionModeDraft by remember(state.connectionMode) { mutableStateOf(state.connectionMode) }
    var connectionInputError by remember { mutableStateOf<String?>(null) }
    var ownerTokenDraft by remember(state.ownerApiToken) { mutableStateOf(state.ownerApiToken) }
    var clearHistoryDialogVisible by remember { mutableStateOf(false) }

    if (clearHistoryDialogVisible) {
        AlertDialog(
            onDismissRequest = { if (!state.isClearingHistory) clearHistoryDialogVisible = false },
            title = { Text("Clear chat history?") },
            text = {
                Text(
                    "This clears this Lily Constellation conversation from the phone and Core. " +
                        "${state.characterName}'s long-term owner memory and other channels stay untouched.",
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        clearHistoryDialogVisible = false
                        viewModel.clearChatHistory()
                    },
                    enabled = !state.isClearingHistory,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDC3154)),
                ) {
                    Text("Clear history")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { clearHistoryDialogVisible = false },
                    enabled = !state.isClearingHistory,
                ) {
                    Text("Cancel")
                }
            },
        )
    }

    PanelCard(title = "Settings") {
        Text("Speech input", fontWeight = FontWeight.SemiBold, color = PocketText)
        Text("Speak, then pause or tap stop to send automatically. Your typed draft stays unchanged.", color = PocketSubtle, fontSize = 12.sp)
        val canChangeSpeech = !state.isVoiceRecording && !state.isTranscribingVoice
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("lily-core-host" to "STT lily-core-host", "android" to "Android / Google").forEach { (id, label) ->
                FilterChip(
                    selected = state.speechInputProvider == id,
                    onClick = { viewModel.selectSpeechInput(id, state.speechInputLanguage) },
                    enabled = canChangeSpeech,
                    label = { Text(label) },
                )
            }
        }
        Text("Android uses the phone's speech service (Google when configured). It may need internet. Lily's replies still use Core.", color = PocketSubtle, fontSize = 12.sp)
        Text("Spoken language", fontWeight = FontWeight.SemiBold, color = PocketText)
        // Two short rows also fit narrow phones without horizontal clipping.
        listOf("chat" to "Follow chat", "id" to "Indonesia", "en" to "English", "ja" to "日本語")
            .chunked(2).forEach { options ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    options.forEach { (id, label) ->
                        FilterChip(
                            selected = state.speechInputLanguage == id,
                            onClick = { viewModel.selectSpeechInput(state.speechInputProvider, id) },
                            enabled = canChangeSpeech,
                            label = { Text(label) },
                        )
                    }
                }
            }
        if (state.isVoiceRecording || state.isTranscribingVoice) {
            Text("Finish or cancel the current voice input before changing these settings.", color = PocketSubtle, fontSize = 12.sp)
        }
        HorizontalDivider(color = PocketSubtle.copy(alpha = 0.18f))
        SettingsStatusSummary(state)
        Text(
            "Main Core · ${state.coreConnectionState.replaceFirstChar { it.uppercase() }}" +
                (state.lastCoreSyncAt?.let { " · synced $it" } ?: ""),
            color = if (state.coreConnectionState == "online") PocketOnline else PocketMuted,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        RuntimeObservability(state)
        HorizontalDivider(color = PocketSubtle.copy(alpha = 0.18f))
        Text("Connection", fontWeight = FontWeight.SemiBold, color = PocketText)
        listOf("auto" to "Auto", "private" to "Tailscale / LAN", "tunnel" to "Tunnel").forEach { (mode, label) ->
            FilterChip(selected = connectionModeDraft == mode, onClick = { connectionModeDraft = mode }, label = { Text(label) })
        }
        Text("Auto tries Tailscale / LAN first, then HTTPS Tunnel. It does not start a VPN.", color = PocketSubtle, fontSize = 12.sp)
        Text("Active route: ${when (state.activeConnectionRoute) { "private" -> "Tailscale / LAN"; "tunnel" -> "Tunnel"; else -> "Checking" }} · ${state.routeConnectionStatus}",
            color = PocketSubtle, fontSize = 12.sp)
        OutlinedTextField(
            value = baseUrlDraft,
            onValueChange = { baseUrlDraft = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Tailscale / LAN URL") },
            supportingText = {
                Text(
                    if (com.lilyconstellation.mobile.BuildConfig.DEBUG)
                        "Development build: HTTP is allowed. Use a trusted LAN or Tailscale."
                    else
                        "HTTPS is required in release builds."
                )
            },
        )
        OutlinedTextField(
            value = tunnelUrlDraft,
            onValueChange = { tunnelUrlDraft = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Tunnel URL") },
            supportingText = { Text("HTTPS is required. Both addresses must reach the same Core.") },
            singleLine = true,
        )
        OutlinedTextField(
            value = ownerTokenDraft,
            onValueChange = { ownerTokenDraft = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Owner API token") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = {
                    runCatching { viewModel.updateConnectionSettings(baseUrlDraft, tunnelUrlDraft, connectionModeDraft, ownerTokenDraft) }
                        .onSuccess { config ->
                            connectionInputError = null
                            baseUrlDraft = config.privateUrl
                            tunnelUrlDraft = config.tunnelUrl
                            viewModel.refresh()
                        }.onFailure { connectionInputError = it.message ?: "Check the connection settings." }
                },
                colors = ButtonDefaults.buttonColors(containerColor = PocketPink),
            ) {
                Text("Save & test")
            }
            OutlinedButton(onClick = { viewModel.refresh() }) {
                Text("Refresh now")
            }
        }
        connectionInputError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        Text(
            "This app connects to Core with the owner API token. Device registration is not required.",
            color = PocketSubtle,
            fontSize = 12.sp,
        )
        HorizontalDivider(color = PocketSubtle.copy(alpha = 0.18f))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Dark mode", color = PocketText, fontWeight = FontWeight.SemiBold)
                Text("Use the darker pink and purple night palette.", color = PocketSubtle, fontSize = 11.sp)
            }
            Switch(checked = state.darkModeEnabled, onCheckedChange = viewModel::setDarkModeEnabled)
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Native notifications", color = PocketText, fontWeight = FontWeight.SemiBold)
                Text("Approvals and completed tasks; background checks are battery-aware.", color = PocketSubtle, fontSize = 11.sp)
            }
            Switch(checked = state.notificationsEnabled, onCheckedChange = viewModel::setNotificationsEnabled)
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Biometric app lock", color = PocketText, fontWeight = FontWeight.SemiBold)
                Text("Protects Lily Constellation the next time the app starts.", color = PocketSubtle, fontSize = 11.sp)
            }
            Switch(checked = state.biometricLockEnabled, onCheckedChange = viewModel::setBiometricLockEnabled)
        }
        Text("Delivery target: ${state.deviceTarget.ifBlank { "this device" }}", style = MaterialTheme.typography.bodySmall, color = PocketSubtle)
        OutlinedButton(
            onClick = { clearHistoryDialogVisible = true },
            enabled = !state.isClearingHistory && state.deviceTarget.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFB42342)),
        ) {
            Icon(Icons.Rounded.DeleteSweep, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text(if (state.isClearingHistory) "Clearing history..." else "Clear chat history")
        }
        Text("Technical connection and privacy options stay here. ${state.characterName}'s mood, language, and voice are in the ${state.characterName} tab.", fontSize = 12.sp, color = PocketSubtle)
    }
}

@Composable
private fun PanelCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = PocketWhite.copy(alpha = 0.94f)),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = PocketPinkDeep)
            content()
        }
    }
}

@Composable
private fun SettingsStatusSummary(state: PocketRealmUiState) {
    val core = state.health?.componentOrEmpty("core")?.status ?: "offline"
    val voiceStatus = state.health?.componentOrEmpty("voice")?.status ?: "offline"
    val voice = if (state.voiceRepliesEnabled) voiceStatus else "muted"
    val tools = state.health?.componentOrEmpty("openclaw")?.status ?: state.health?.componentOrEmpty("tool")?.status ?: "offline"
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        StatusSummaryChip("Core", core, Modifier.weight(1f))
        StatusSummaryChip("Voice", voice.voiceSummaryLabel(), Modifier.weight(1f))
        StatusSummaryChip("Tools", tools, Modifier.weight(1f))
    }
    Text(
        "Mobile delivery target: ${state.deviceTarget.ifBlank { "this device" }}",
        style = MaterialTheme.typography.bodySmall,
        color = PocketSubtle,
    )
}

@Composable
private fun RuntimeObservability(state: PocketRealmUiState) {
    val runtime = state.health?.ownerRuntime
    val personal = runtime?.waProfiles?.get("personal")
    val public = runtime?.waProfiles?.get("public")
    val routines = runtime?.routines
    val nextRoutine = routines?.items?.firstOrNull { it.id == routines.nextRoutineId }
    val lastDelivery = routines?.recentDeliveries?.firstOrNull()
    val activity = runtime?.ownerActivity

    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text("Runtime", fontWeight = FontWeight.SemiBold, color = PocketText)
        RuntimeStatusRow(
            label = "WhatsApp personal",
            value = if (personal?.online == true) "Online" else personal?.clientState?.titleCaseStatus() ?: "Unknown",
            healthy = personal?.online == true,
            detail = personal?.ageSeconds.runtimeAgeLabel(),
        )
        RuntimeStatusRow(
            label = "WhatsApp ${state.characterName}",
            value = if (public?.online == true) "Online" else public?.clientState?.titleCaseStatus() ?: "Unknown",
            healthy = public?.online == true,
            detail = public?.ageSeconds.runtimeAgeLabel(),
        )
        RuntimeStatusRow(
            label = "Presence signal",
            value = activity?.activity?.replace('_', ' ')?.titleCaseStatus() ?: "Unknown",
            healthy = (activity?.ageSeconds ?: Int.MAX_VALUE) <= 1_800,
            detail = listOfNotNull(
                activity?.confidence?.takeIf { it.isNotBlank() },
                activity?.ageSeconds.runtimeAgeLabel().takeIf { it.isNotBlank() },
            ).joinToString(" · "),
        )
        RuntimeStatusRow(
            label = "Next reminder",
            value = nextRoutine?.label ?: "None scheduled",
            healthy = routines?.enabled == true && nextRoutine != null,
            detail = nextRoutine?.time.orEmpty(),
        )
        RuntimeStatusRow(
            label = "Last delivery",
            value = lastDelivery?.status?.titleCaseStatus() ?: "No delivery yet",
            healthy = lastDelivery?.status == "sent",
            detail = listOfNotNull(
                lastDelivery?.routineId?.replace('_', ' '),
                lastDelivery?.attempts?.takeIf { it > 0 }?.let { "attempt $it" },
            ).joinToString(" · "),
            error = lastDelivery?.lLily-Voice-Hostror.orEmpty(),
        )
    }
}

@Composable
private fun RuntimeStatusRow(
    label: String,
    value: String,
    healthy: Boolean,
    detail: String = "",
    error: String = "",
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(label, color = PocketText, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            if (detail.isNotBlank()) Text(detail, color = PocketSubtle, fontSize = 11.sp)
            if (error.isNotBlank()) {
                Text(error, color = Color(0xFFB4235A), fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(
            value,
            color = if (healthy) PocketOnline else PocketMuted,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 12.dp),
        )
    }
}

private fun Int?.runtimeAgeLabel(): String = when {
    this == null -> ""
    this < 15 -> "just now"
    this < 60 -> "${this}s ago"
    this < 3_600 -> "${this / 60}m ago"
    else -> "${this / 3_600}h ago"
}

@Composable
private fun StatusSummaryChip(label: String, status: String, modifier: Modifier = Modifier) {
    val online = status.equals("online", ignoreCase = true) || status.equals("ok", ignoreCase = true)
    Surface(
        modifier = modifier,
        color = if (online) PocketBlush.copy(alpha = 0.86f) else PocketWhite,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.62f)),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label.uppercase(), color = PocketSubtle, fontWeight = FontWeight.Bold, fontSize = 10.sp)
            Text(status.titleCaseStatus(), color = if (online) PocketPink else PocketText, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        }
    }
}

@Composable
private fun EmptyPanelText(text: String) {
    Surface(color = PocketGlass, shape = RoundedCornerShape(16.dp)) {
        Text(text, color = PocketSubtle, modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp))
    }
}

@Composable
private fun TaskStatusSummary(tasks: List<ToolTask>) {
    val statuses = listOf("pending", "approved", "running", "completed", "failed", "denied", "cancelled", "expired")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        statuses.chunked(2).forEach { rowStatuses ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowStatuses.forEach { status ->
                    Surface(
                        modifier = Modifier.weight(1f),
                        color = if (tasks.any { it.status == status }) PocketBlush else PocketWhite.copy(alpha = 0.88f),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(status.titleCaseStatus(), color = PocketSubtle, fontSize = 11.sp)
                            Text(
                                tasks.count { it.status == status }.toString(),
                                color = PocketPinkDeep,
                                fontWeight = FontWeight.Bold,
                                fontSize = 11.sp,
                            )
                        }
                    }
                }
                if (rowStatuses.size == 1) Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun TaskCard(
    task: ToolTask,
    onOpenDetails: () -> Unit,
    onApprove: (() -> Unit)? = null,
    onDeny: (() -> Unit)? = null,
    onCancel: (() -> Unit)? = null,
    onRetryExecution: (() -> Unit)? = null,
    onRetryDelivery: (() -> Unit)? = null,
) {
    Surface(
        color = Color(0xFFFFF8FB),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, PocketGlassBorder.copy(alpha = 0.58f)),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Tool task", fontWeight = FontWeight.SemiBold, color = PocketPinkDeep)
                TaskStatusPill(task.status)
            }
            if (task.action.isNotBlank()) Text("Action: ${task.action}", color = PocketSubtle, fontSize = 11.sp)
            Text(task.task.ifBlank { task.resultText.ifBlank { "No task description." } }, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text("ID: ${task.id}", style = MaterialTheme.typography.bodySmall, color = PocketSubtle)
            if (task.status in setOf("approved", "running") && task.progressPercent > 0) {
                LinearProgressIndicator(
                    progress = (task.progressPercent.coerceIn(0, 100) / 100f),
                    modifier = Modifier.fillMaxWidth(),
                    color = PocketPink,
                )
                Text(
                    "${task.progressPercent}% · ${task.progressMessage.ifBlank { "Working" }} · ${taskDurationLabel(task)}",
                    color = PocketSubtle,
                    fontSize = 10.sp,
                )
            }
            if (task.deliveryStatus.isNotBlank()) {
                Text(
                    "Delivery: ${task.deliveryStatus.titleCaseStatus()}${task.deliveryChannel.takeIf { it.isNotBlank() }?.let { " via $it" } ?: ""}",
                    color = PocketSubtle,
                    fontSize = 11.sp,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onOpenDetails) {
                    Text("Details")
                }
                if (onCancel != null && task.status in setOf("pending", "approved", "running")) {
                    OutlinedButton(onClick = onCancel) { Text("Cancel") }
                }
                if (onRetryExecution != null && task.status == "failed") {
                    Button(onClick = onRetryExecution, colors = ButtonDefaults.buttonColors(containerColor = PocketPink)) { Text("Retry") }
                }
                if (onRetryDelivery != null && task.recoveryRequired) {
                    OutlinedButton(onClick = onRetryDelivery) { Text("Retry delivery") }
                }
                if (onApprove != null && onDeny != null && task.status == "pending") {
                    Button(onClick = onApprove, colors = ButtonDefaults.buttonColors(containerColor = PocketPink)) {
                        Icon(Icons.Rounded.Check, contentDescription = null)
                        Text("Approve", modifier = Modifier.padding(start = 8.dp))
                    }
                    OutlinedButton(onClick = onDeny) {
                        Icon(Icons.Rounded.Close, contentDescription = null)
                        Text("Deny", modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskDetailDialog(
    task: ToolTask,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onCancel: () -> Unit,
    onRetryExecution: () -> Unit,
    onRetryDelivery: () -> Unit,
    onDownloadArtifact: (ToolTask, ToolArtifact) -> Unit,
    onPreviewArtifact: (ToolTask, ToolArtifact) -> Unit,
    onRefresh: () -> Unit,
    downloadedArtifact: DownloadedArtifact?,
    isDownloadingArtifact: Boolean,
    artifactPreviewText: String?,
    onClearArtifactPreview: () -> Unit,
) {
    val context = LocalContext.current
    LaunchedEffect(task.id, task.status) {
        if (task.status in setOf("pending", "approved", "running")) {
            while (true) {
                delay(2_000)
                onRefresh()
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Task details") },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 540.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Tool task", color = PocketPinkDeep, fontWeight = FontWeight.Bold)
                TaskDetailRow("Action", task.action.ifBlank { "-" })
                TaskDetailRow("Status", task.status.titleCaseStatus())
                TaskDetailRow("Risk", task.risk.ifBlank { "unknown" }.titleCaseStatus())
                TaskDetailRow("Target", task.deliveryTarget.ifBlank { "owner" })
                TaskDetailRow("Created", task.createdAtIso.ifBlank { "-" })
                TaskDetailRow("Duration", taskDurationLabel(task))
                if (task.estimatedDurationSeconds > 0) TaskDetailRow("Estimated", "${task.estimatedDurationSeconds}s")
                if (task.progressMessage.isNotBlank()) TaskDetailRow("Progress", "${task.progressPercent}% · ${task.progressMessage}")
                TaskDetailRow("Updated", task.updatedAtIso.ifBlank { "-" })
                if (task.approvalExpiresAtIso.isNotBlank()) TaskDetailRow("Approval expires", task.approvalExpiresAtIso)
                TaskDetailRow("Provider", task.toolProvider.ifBlank { task.requestedProvider.ifBlank { "-" } })
                if (task.fallbackUsed) TaskDetailRow("Fallback", "Used")
                task.executionLatencyMs?.let { TaskDetailRow("Execution latency", "${it}ms") }
                TaskDetailRow(
                    "Delivery",
                    listOfNotNull(
                        task.deliveryStatus.ifBlank { null }?.titleCaseStatus(),
                        task.deliveryChannel.ifBlank { null },
                        task.deliveryProfile.ifBlank { null },
                    ).joinToString(" · ").ifBlank { "-" },
                )
                task.deliveryLatencyMs?.let { TaskDetailRow("Delivery latency", "${it}ms") }
                if (task.deliveryError.isNotBlank()) TaskDetailRow("Delivery recovery", task.deliveryError)
                Text(task.task.ifBlank { "No task description." }, color = PocketText)

                if (task.resultText.isNotBlank()) {
                    Text("Result", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold)
                    Text(task.resultText, color = PocketText, maxLines = 12, overflow = TextOverflow.Ellipsis)
                }
                if (task.error.isNotBlank()) {
                    Text("Error", color = Color(0xFFBE123C), fontWeight = FontWeight.SemiBold)
                    Text(task.error, color = Color(0xFFBE123C), maxLines = 8, overflow = TextOverflow.Ellipsis)
                }
                if (task.providerAttempts.isNotEmpty()) {
                    Text("Provider attempts", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold)
                    task.providerAttempts.forEach { attempt ->
                        Text(attempt.toString(), color = PocketSubtle, fontSize = 11.sp)
                    }
                }
                if (task.inputFiles.isNotEmpty()) {
                    Text("Inputs", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold)
                    task.inputFiles.forEach { input ->
                        Text("${input.name} · ${formatArtifactSize(input.sizeBytes)}", color = PocketSubtle, fontSize = 11.sp)
                    }
                }
                if (task.artifacts.isNotEmpty()) {
                    Text("Artifacts", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold)
                    task.artifacts.forEach { artifact ->
                        ArtifactRow(
                            task = task,
                            artifact = artifact,
                            onDownload = onDownloadArtifact,
                            downloadedArtifact = downloadedArtifact,
                            isDownloading = isDownloadingArtifact,
                            onPreview = { downloaded ->
                                if (downloaded == null) {
                                    onDownloadArtifact(task, artifact)
                                } else if (downloaded.mimeType.startsWith("text/")) {
                                    onPreviewArtifact(task, artifact)
                                } else {
                                    launchArtifactIntent(context, downloaded, share = false)
                                }
                            },
                            onOpen = { downloaded -> launchArtifactIntent(context, downloaded, share = false) },
                            onShare = { downloaded -> launchArtifactIntent(context, downloaded, share = true) },
                        )
                    }
                }
                artifactPreviewText?.let { preview ->
                    Text("Safe text preview", color = PocketPinkDeep, fontWeight = FontWeight.SemiBold)
                    Surface(color = PocketWhite.copy(alpha = 0.90f), shape = RoundedCornerShape(10.dp)) {
                        Text(preview, color = PocketText, fontSize = 11.sp, modifier = Modifier.padding(8.dp))
                    }
                    TextButton(onClick = onClearArtifactPreview) { Text("Close preview") }
                }
                if (task.status == "pending") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onApprove, colors = ButtonDefaults.buttonColors(containerColor = PocketPink)) {
                            Text("Approve")
                        }
                        OutlinedButton(onClick = onDeny) { Text("Deny") }
                    }
                }
                if (task.status in setOf("approved", "running")) {
                    OutlinedButton(onClick = onCancel) { Text("Cancel task") }
                }
                if (task.status == "failed") {
                    Button(onClick = onRetryExecution, colors = ButtonDefaults.buttonColors(containerColor = PocketPink)) { Text("Retry execution") }
                }
                if (task.recoveryRequired) {
                    OutlinedButton(onClick = onRetryDelivery) { Text("Retry delivery") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun TaskDetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = PocketSubtle, fontSize = 11.sp)
        Text(value, color = PocketText, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ArtifactRow(
    task: ToolTask,
    artifact: ToolArtifact,
    onDownload: (ToolTask, ToolArtifact) -> Unit,
    downloadedArtifact: DownloadedArtifact?,
    isDownloading: Boolean,
    onPreview: (DownloadedArtifact?) -> Unit,
    onOpen: (DownloadedArtifact) -> Unit,
    onShare: (DownloadedArtifact) -> Unit,
) {
    val downloaded = downloadedArtifact?.takeIf { it.taskId == task.id && it.artifactId == artifact.id }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(artifact.name.ifBlank { artifact.id }, color = PocketText, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            listOfNotNull(
                artifact.kind.ifBlank { null },
                artifact.mimeType.ifBlank { null },
                formatArtifactSize(artifact.sizeBytes),
                artifact.sha256.takeIf { it.isNotBlank() }?.let { "sha256 ${it.take(12)}…" },
            ).joinToString(" · "),
            color = PocketSubtle,
            fontSize = 10.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { onDownload(task, artifact) }, enabled = !isDownloading) {
                Text(if (downloaded != null) "Downloaded" else "Download")
            }
            TextButton(onClick = { onPreview(downloaded) }, enabled = downloaded != null || !isDownloading) { Text("Preview") }
            if (downloaded != null) {
                TextButton(onClick = { onOpen(downloaded) }) { Text("Open") }
                TextButton(onClick = { onShare(downloaded) }) { Text("Share") }
            }
        }
    }
}

private fun formatArtifactSize(sizeBytes: Long): String = when {
    sizeBytes >= 1024L * 1024L -> "${sizeBytes / (1024L * 1024L)} MB"
    sizeBytes >= 1024L -> "${sizeBytes / 1024L} KB"
    sizeBytes > 0 -> "$sizeBytes B"
    else -> "size unknown"
}

private fun taskDurationLabel(task: ToolTask): String {
    val startedAt = (task.executionStartedAtIso.ifBlank { task.createdAtIso }).takeIf { it.isNotBlank() }?.let { value ->
        runCatching { Instant.parse(value) }.getOrNull()
    } ?: return "-"
    val finishedAt = if (task.status in setOf("pending", "approved", "running")) {
        Instant.now()
    } else {
        listOf(task.executionCompletedAtIso, task.completedAtIso, task.updatedAtIso)
            .firstOrNull { it.isNotBlank() }
            ?.let { value -> runCatching { Instant.parse(value) }.getOrNull() }
            ?: return "-"
    }
    val seconds = Duration.between(startedAt, finishedAt).seconds.coerceAtLeast(0)
    return if (seconds < 60) {
        "${seconds}s"
    } else {
        "${seconds / 60}m ${seconds % 60}s"
    }
}

private fun launchArtifactIntent(context: Context, artifact: DownloadedArtifact, share: Boolean) {
    val intent = if (share) {
        Intent(Intent.ACTION_SEND).apply {
            type = artifact.mimeType
            putExtra(Intent.EXTRA_STREAM, artifact.uri)
        }
    } else {
        Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(artifact.uri, artifact.mimeType)
        }
    }.apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, if (share) "Share artifact" else "Open artifact"))
    }.onFailure { error ->
        if (error !is ActivityNotFoundException) throw error
    }
}

@Composable
private fun TaskStatusPill(status: String) {
    Surface(
        color = PocketBlush.copy(alpha = 0.82f),
        shape = RoundedCornerShape(999.dp),
    ) {
        Text(
            status.titleCaseStatus(),
            color = PocketPinkDeep,
            fontWeight = FontWeight.Bold,
            fontSize = 10.sp,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

internal class MobileVoiceRecorder(private val context: Context) {
    private companion object {
        const val VAD_POLL_MS = 100L
        const val VAD_SILENCE_MS = 1_100L
        const val VAD_START_TIMEOUT_MS = 6_000L
        const val VAD_AMPLITUDE_THRESHOLD = 1_100
    }

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private val vadHandler = Handler(Looper.getMainLooper())
    private var vadRunnable: Runnable? = null
    private var vadStartedAt = 0L
    private var vadLastSpeechAt = 0L
    private var vadHasSpeech = false
    private var vadStopRequested = false

    fun start(onSpeechDetected: () -> Unit = {}, onSilenceDetected: () -> Unit = {}) {
        cancel()
        val file = File.createTempFile("lily_mobile_voice_", ".m4a", context.cacheDir)
        val nextRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        nextRecorder.apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioEncodingBitRate(64_000)
            setAudioSamplingRate(44_100)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
        recorder = nextRecorder
        outputFile = file
        vadStartedAt = SystemClock.elapsedRealtime()
        vadLastSpeechAt = 0L
        vadHasSpeech = false
        vadStopRequested = false
        val monitor = object : Runnable {
            override fun run() {
                val activeRecorder = recorder ?: return
                if (vadStopRequested) return
                val now = SystemClock.elapsedRealtime()
                val amplitude = runCatching { activeRecorder.maxAmplitude }.getOrDefault(0)
                if (amplitude >= VAD_AMPLITUDE_THRESHOLD) {
                    if (!vadHasSpeech) onSpeechDetected()
                    vadHasSpeech = true
                    vadLastSpeechAt = now
                }
                val silenceDuration = if (vadHasSpeech) now - vadLastSpeechAt else 0L
                val startTimedOut = !vadHasSpeech && now - vadStartedAt >= VAD_START_TIMEOUT_MS
                if (!vadStopRequested && ((vadHasSpeech && silenceDuration >= VAD_SILENCE_MS) || startTimedOut)) {
                    vadStopRequested = true
                    onSilenceDetected()
                    return
                }
                vadHandler.postDelayed(this, VAD_POLL_MS)
            }
        }
        vadRunnable = monitor
        vadHandler.postDelayed(monitor, VAD_POLL_MS)
    }

    fun stop(): File? {
        stopVadMonitor()
        val activeRecorder = recorder ?: return null
        val file = outputFile
        recorder = null
        outputFile = null
        return runCatching {
            activeRecorder.stop()
            activeRecorder.release()
            file?.takeIf { it.exists() && it.length() > 0L }
        }.getOrElse {
            runCatching { activeRecorder.release() }
            file?.delete()
            null
        }
    }

    fun cancel() {
        stopVadMonitor()
        recorder?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        recorder = null
        outputFile?.delete()
        outputFile = null
    }

    private fun stopVadMonitor() {
        vadStopRequested = true
        vadRunnable?.let(vadHandler::removeCallbacks)
        vadRunnable = null
    }
}

private fun String.titleCaseStatus(): String =
    split("_", "-", " ")
        .filter { it.isNotBlank() }
        .joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }

private fun String.shortStageStatus(): String =
    when (lowercase()) {
        "online", "ready", "connected" -> "On"
        "degraded", "limited" -> "Warn"
        "standby", "idle" -> "Idle"
        else -> "Off"
    }

private fun String.voiceStageLabel(compact: Boolean): String =
    when (lowercase()) {
        "muted" -> if (compact) "Voice Off" else "Voice Muted"
        "online", "ready", "connected", "ok", "healthy" -> if (compact) "Voice On" else "Voice Online"
        "degraded", "limited", "busy" -> if (compact) "Voice Warn" else "Voice Limited"
        "standby", "idle" -> "Voice Idle"
        else -> "Voice Off"
    }

private fun String.voiceSummaryLabel(): String =
    when (lowercase()) {
        "muted" -> "Muted"
        "online", "ready", "connected", "ok", "healthy" -> "Online"
        "degraded", "limited", "busy" -> "Limited"
        "standby", "idle" -> "Idle"
        else -> "Off"
    }

private fun String.isOnlineStatus(): Boolean =
    lowercase() in setOf("online", "ready", "connected", "ok", "healthy")

private fun String.shortPresenceLabel(): String =
    when (lowercase()) {
        "available" -> "Available"
        "at_office" -> "Office"
        "sleeping" -> "Sleep"
        "gaming" -> "Gaming"
        "busy" -> "Busy"
        "away" -> "Away"
        else -> titleCaseStatus()
    }

@Preview(
    name = "Pocket Realm Chat",
    widthDp = 393,
    heightDp = 852,
    showBackground = false,
)
@Composable
private fun PocketRealmChatPreview() {
    LilyTheme {
        PocketRealmPreviewScene()
    }
}

@Composable
private fun PocketRealmPreviewScene() {
    val previewState = PocketRealmUiState(
        coreConnectionState = "online",
        health = HealthResponse(
            status = "online",
            components = mapOf(
                "core" to ComponentSnapshot(status = "online"),
                "voice" to ComponentSnapshot(status = "online"),
            ),
        ),
        messages = listOf(
            ChatBubble("preview-user", "user", "Lily", "15:06"),
            ChatBubble("preview-lily", "lily", "Lily's right here, always. Just hearing you say my name makes my whole day brighter.", "15:06"),
        ),
        modelScaleMultiplier = 1.0f,
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(MaterialTheme.colorScheme.background, StagePink, PocketBlush))),
    ) {
        MinimalChatScene(
            state = previewState,
            viewModel = null,
            inputValue = TextFieldValue(""),
            keyboardVisible = false,
            lipSyncLevel = 0f,
            voicePlaybackActive = false,
            voicePlaybackPositionMs = 0,
            voicePlaybackDurationMs = 0,
            onInputChange = {},
            onSend = {},
            onStopVoice = {},
            onHomeClick = {},
            onMenuClick = {},
            onVoiceInputClick = {},
            previewMode = true,
        )
        PocketBottomNav(
            activeTab = PocketTab.Chat,
            characterName = previewState.characterName,
            onTabSelected = {},
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 8.dp),
        )
    }
}
