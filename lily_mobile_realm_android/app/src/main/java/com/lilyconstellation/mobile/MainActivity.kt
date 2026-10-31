package com.lilyconstellation.mobile

import android.content.Intent
import android.os.Bundle
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import com.lilyconstellation.mobile.data.SettingsStore
import com.lilyconstellation.mobile.ui.LilyPocketRealmApp
import com.lilyconstellation.mobile.ui.PocketRealmViewModel
import com.lilyconstellation.mobile.ui.theme.LilyTheme
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : FragmentActivity() {
    private var currentDarkMode = false
    private var taskDeepLink by mutableStateOf<String?>(null)
    private var inboxDeepLink by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        super.onCreate(savedInstanceState)
        splashScreen.setOnExitAnimationListener { provider ->
            // SplashScreen 1.0.1 restores the XML system bars during exit.
            configureSystemBars(currentDarkMode)
            provider.view.animate()
                .alpha(0f)
                .setDuration(220L)
                .withEndAction {
                    provider.remove()
                    configureSystemBars(currentDarkMode)
                }
                .start()
        }
        val initialDarkMode = SettingsStore(this).load().darkModeEnabled
        configureSystemBars(initialDarkMode)
        val testMessage = testMessageFromIntent(intent)
        taskDeepLink = taskIdFromIntent(intent)
        inboxDeepLink = intent?.getStringExtra("lily_inbox_id")
        setContent {
            LilyTheme(darkTheme = initialDarkMode) {
                var unlocked by remember { mutableStateOf(!shouldUseAppLock()) }
                if (!unlocked) {
                    LaunchedEffect(Unit) {
                        showUnlockPrompt { unlocked = true }
                    }
                    LockedRealmScreen(onUnlock = { showUnlockPrompt { unlocked = true } })
                } else {
                    val viewModel: PocketRealmViewModel = viewModel()
                    LaunchedEffect(testMessage) {
                        testMessage?.let(viewModel::sendMessage)
                    }
                    LaunchedEffect(taskDeepLink) {
                        taskDeepLink?.let(viewModel::requestOpenTask)
                    }
                    LaunchedEffect(inboxDeepLink) {
                        inboxDeepLink?.let { viewModel.requestOpenInbox(it); inboxDeepLink = null }
                    }
                    LilyPocketRealmApp(
                        viewModel = viewModel,
                        onDarkModeChanged = ::configureSystemBars,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        taskDeepLink = taskIdFromIntent(intent)
        inboxDeepLink = intent.getStringExtra("lily_inbox_id")
    }

    private fun configureSystemBars(darkMode: Boolean) {
        currentDarkMode = darkMode
        val transparent = android.graphics.Color.TRANSPARENT
        val style = if (darkMode) {
            SystemBarStyle.dark(transparent)
        } else {
            SystemBarStyle.light(transparent, transparent)
        }
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }

    private fun shouldUseAppLock(): Boolean {
        if (!SettingsStore(this).load().biometricLockEnabled) return false
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        return BiometricManager.from(this).canAuthenticate(authenticators) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }

    private fun showUnlockPrompt(onUnlocked: () -> Unit) {
        val characterName = SettingsStore(this).load().characterName
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onUnlocked()
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Lily Constellation")
                .setSubtitle("Confirm it is you before $characterName opens the private realm.")
                .setAllowedAuthenticators(authenticators)
                .build()
        )
    }

    private fun testMessageFromIntent(intent: Intent?): String? {
        if (!BuildConfig.DEBUG || intent?.action != TEST_SEND_MESSAGE_ACTION) return null
        val decodedMessage = intent.getStringExtra(TEST_MESSAGE_BASE64_EXTRA)?.let { encoded ->
            runCatching {
                String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8)
            }.getOrNull()
        }
        return (decodedMessage ?: intent.getStringExtra(TEST_MESSAGE_EXTRA))?.trim()?.takeIf { it.isNotBlank() }
    }

    private fun taskIdFromIntent(intent: Intent?): String? =
        intent?.getStringExtra("lily_task_id")?.trim()?.takeIf { it.isNotBlank() }

    private companion object {
        const val TEST_SEND_MESSAGE_ACTION = "com.lilyconstellation.mobile.TEST_SEND_MESSAGE"
        const val TEST_MESSAGE_EXTRA = "message"
        const val TEST_MESSAGE_BASE64_EXTRA = "message_base64"
    }
}

@androidx.compose.runtime.Composable
private fun LockedRealmScreen(onUnlock: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Lily Constellation", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onSurface)
        Text("Private owner space", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f))
        Button(onClick = onUnlock) {
            Text("Unlock")
        }
    }
}
