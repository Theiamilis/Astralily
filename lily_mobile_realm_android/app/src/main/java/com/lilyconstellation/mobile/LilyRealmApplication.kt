package com.lilyconstellation.mobile

import android.app.Application
import com.lilyconstellation.mobile.data.SettingsStore
import com.lilyconstellation.mobile.data.CoreConnectionConfig
import com.lilyconstellation.mobile.data.CoreConnectionManager
import com.lilyconstellation.mobile.notifications.RealmNotificationScheduler

class LilyRealmApplication : Application() {
    val coreConnectionManager: CoreConnectionManager by lazy {
        val settings = SettingsStore(this).load()
        CoreConnectionManager(CoreConnectionConfig(settings.coreBaseUrl, settings.tunnelBaseUrl, settings.connectionMode), settings.ownerApiToken)
    }

    override fun onCreate() {
        super.onCreate()
        if (SettingsStore(this).load().notificationsEnabled) {
            RealmNotificationScheduler.enable(this)
        }
    }
}
