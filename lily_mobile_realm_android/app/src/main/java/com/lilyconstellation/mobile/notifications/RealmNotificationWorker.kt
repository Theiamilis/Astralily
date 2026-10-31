package com.lilyconstellation.mobile.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.lilyconstellation.mobile.MainActivity
import com.lilyconstellation.mobile.LilyRealmApplication
import com.lilyconstellation.mobile.R
import com.lilyconstellation.mobile.data.MobileRealmApi
import com.lilyconstellation.mobile.data.SettingsStore
import java.util.concurrent.TimeUnit

object RealmNotificationScheduler {
    private const val WORK_NAME = "lily_realm_notifications"

    fun enable(context: Context) {
        RealmNotificationCenter.ensureChannel(context)
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = PeriodicWorkRequestBuilder<RealmNotificationWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    fun disable(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }
}

object RealmNotificationCenter {
    private const val CHANNEL_ID = "lily_realm_owner"
    private const val PREFS_NAME = "lily_realm_notification_state"
    private const val KEY_SEEN_IDS = "seen_ids"

    fun ensureChannel(context: Context) {
        val characterName = SettingsStore(context.applicationContext).load().characterName
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Lily Constellation",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Owner alerts, approvals, and completed tasks from $characterName."
            }
        )
    }

    @Synchronized
    fun notifyOnce(context: Context, id: String, title: String, text: String, taskId: String? = null, inboxId: String? = null) {
        if (id.isBlank() || !hasPermission(context)) return
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seen = runCatching { org.json.JSONObject(prefs.getString("seen_at", "{}") ?: "{}") }.getOrDefault(org.json.JSONObject())
        if (seen.has(id) || prefs.getStringSet(KEY_SEEN_IDS, emptySet()).orEmpty().contains(id)) return
        val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(30)
        seen.keys().asSequence().toList().filter { seen.optLong(it) < cutoff }.forEach(seen::remove)
        seen.put(id, System.currentTimeMillis())
        if (seen.length() > 2000) seen.keys().asSequence().toList().sortedBy { seen.optLong(it) }.take(seen.length() - 2000).forEach(seen::remove)

        ensureChannel(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            taskId?.takeIf { it.isNotBlank() }?.let { putExtra("lily_task_id", it) }
            inboxId?.let { putExtra("lily_inbox_id", it.ifBlank { "inbox" }) }
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_lily_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
        prefs.edit().putString("seen_at", seen.toString()).apply()
    }

    suspend fun checkInbox(context: Context, api: MobileRealmApi, baseUrl: String, ownerApiToken: String) {
        api.getWaNotices(baseUrl).items.take(30).asReversed().forEach { notice ->
            val current = SettingsStore(context).load()
            if (!current.notificationsEnabled || current.coreBaseUrl != baseUrl || current.ownerApiToken != ownerApiToken) return
            notifyOnce(context, "wa:${notice.id}", notice.title, notice.text, inboxId = notice.itemId)
        }
    }

    private fun hasPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
}

class RealmNotificationWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val settings = SettingsStore(applicationContext).load()
        if (!settings.notificationsEnabled) return Result.success()
        val characterName = settings.characterName
        val manager = (applicationContext as LilyRealmApplication).coreConnectionManager
        val pinned = runCatching { manager.pin() }.getOrElse { return Result.retry() }
        val api = MobileRealmApi(connectionManager = manager, pinnedRoute = pinned).also { it.setOwnerApiToken(settings.ownerApiToken) }

        val tasksResult = runCatching {
            api.getOpenClawRequests(settings.coreBaseUrl).items.forEach { task ->
                if (task.status == "pending") {
                    RealmNotificationCenter.notifyOnce(
                        applicationContext,
                        "approval:${task.id}",
                        "$characterName needs your approval",
                        task.task.ifBlank { "An owner action is waiting in Lily Constellation." },
                        task.id,
                    )
                }
                if (task.status in setOf("completed", "failed", "cancelled", "expired")) {
                    RealmNotificationCenter.notifyOnce(
                        applicationContext,
                        "completion:${task.id}:${task.updatedAtIso}",
                        "$characterName task ${task.status}",
                        task.error.ifBlank { task.resultText.ifBlank { task.progressMessage.ifBlank { "Open Lily Constellation for task details." } } },
                        task.id,
                    )
                }
                if (task.recoveryRequired || task.deliveryError.isNotBlank()) {
                    RealmNotificationCenter.notifyOnce(
                        applicationContext,
                        "delivery:${task.id}:${task.deliveryAttemptCount}",
                        "$characterName artifact delivery needs attention",
                        task.deliveryError.ifBlank { "Open Lily Constellation to retry artifact delivery." },
                        task.id,
                    )
                }
            }
        }
        val inboxResult = runCatching { RealmNotificationCenter.checkInbox(applicationContext, api, settings.coreBaseUrl, settings.ownerApiToken) }
        return if (tasksResult.isSuccess && inboxResult.isSuccess) Result.success() else Result.retry()
    }
}
