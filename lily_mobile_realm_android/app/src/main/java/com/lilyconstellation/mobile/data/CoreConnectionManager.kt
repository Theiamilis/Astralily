package com.lilyconstellation.mobile.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.FileNotFoundException
import java.io.IOException
import java.net.HttpURLConnection
import java.net.ProtocolException
import java.net.URI
import java.net.URL
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.SSLException
import kotlin.concurrent.withLock

const val DEFAULT_TUNNEL_BASE_URL = "https://example.com"

data class CoreConnectionConfig(
    val privateUrl: String,
    val tunnelUrl: String = DEFAULT_TUNNEL_BASE_URL,
    val mode: String = "auto",
) {
    companion object {
        fun restored(legacyUrl: String?, privateUrl: String?, tunnelUrl: String?, mode: String?): CoreConnectionConfig =
            CoreConnectionConfig(MobileRealmApi.normalizeBaseUrl(privateUrl ?: legacyUrl.orEmpty()),
                tunnelUrl?.takeIf { it.isNotBlank() } ?: DEFAULT_TUNNEL_BASE_URL,
                mode?.takeIf { it in setOf("auto", "private", "tunnel") } ?: "auto")

        fun validated(privateUrl: String, tunnelUrl: String, mode: String, allowPrivateHttp: Boolean = true): CoreConnectionConfig {
            require(mode in setOf("auto", "private", "tunnel")) { "Choose Auto, Tailscale / LAN, or Tunnel." }
            fun endpoint(value: String, public: Boolean): String {
                val normalized = MobileRealmApi.normalizeBaseUrl(value)
                val uri = runCatching { URI(normalized) }.getOrElse { throw IllegalArgumentException("Enter a valid Core URL.") }
                require(uri.scheme in setOf("http", "https") && uri.host != null && uri.rawUserInfo == null
                    && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.orEmpty() in setOf("", "/")
                    && (uri.port == -1 || uri.port in 1..65535)) { "Use a Core hostname and port without a path or credentials." }
                require(uri.scheme == "https" || (!public && allowPrivateHttp)) {
                    if (public) "Tunnel URL must use HTTPS." else "This build requires an HTTPS private URL."
                }
                return normalized.trimEnd('/')
            }
            return CoreConnectionConfig(endpoint(privateUrl, false), endpoint(tunnelUrl, true), mode)
        }
    }
}

data class CoreConnectionStatus(val route: String? = null, val baseUrl: String? = null, val status: String = "checking")
class CoreHttpException(val status: Int, message: String) : RuntimeException(message)
class CorePinnedRoute internal constructor(val route: String, val baseUrl: String, internal val token: String, internal val generation: Long)

class CoreConnectionManager(
    initialConfig: CoreConnectionConfig,
    initialToken: String = "",
    private val probe: (String, String, Int) -> Unit = ::probeOwnerConnection,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val stateLock = Any()
    private val probeLock = ReentrantLock()
    private var config = initialConfig
    private var token = initialToken.trim()
    private var generation = 0L
    private var cached: CorePinnedRoute? = null
    private var validUntil = 0L
    private val mutableStatus = MutableStateFlow(CoreConnectionStatus())
    val status = mutableStatus.asStateFlow()

    private class Snapshot(val config: CoreConnectionConfig, val token: String, val generation: Long)
    private fun snapshot() = synchronized(stateLock) { Snapshot(config, token, generation) }

    fun configure(next: CoreConnectionConfig, ownerToken: String) = synchronized(stateLock) {
        val cleanToken = ownerToken.trim()
        if (next == config && token == cleanToken) return@synchronized
        if (next.privateUrl != config.privateUrl || next.tunnelUrl != config.tunnelUrl || token != cleanToken) generation++
        config = next
        token = cleanToken
        cached = null
        validUntil = 0L
        mutableStatus.value = CoreConnectionStatus()
    }

    fun setOwnerToken(value: String) = synchronized(stateLock) { configure(config, value) }

    fun invalidate() = synchronized(stateLock) { validUntil = 0L }

    fun pin(): CorePinnedRoute = probeLock.withLock {
        while (true) {
            val current = snapshot()
            synchronized(stateLock) {
                cached?.takeIf { it.generation == generation && clock() < validUntil }?.let { return it }
            }
            val candidates = when (current.config.mode) {
                "private" -> listOf("private")
                "tunnel" -> listOf("tunnel")
                else -> listOf("private", "tunnel")
            }
            var failure: Throwable? = null
            var lastAttempt: CorePinnedRoute? = null
            for (kind in candidates) {
                val selected = route(current, kind)
                lastAttempt = selected
                try {
                    probe(selected.baseUrl, selected.token, if (kind == "private") 1500 else 3000)
                    if (publish(current, selected)) return selected
                    break
                } catch (error: Exception) {
                    failure = error
                    if (!isNetworkFailure(error)) {
                        mutableStatus.value = CoreConnectionStatus(kind, selected.baseUrl, "error")
                        throw error
                    }
                }
            }
            if (snapshot().generation != current.generation || snapshot().config != current.config) continue
            mutableStatus.value = CoreConnectionStatus(lastAttempt?.route, lastAttempt?.baseUrl, "offline")
            throw failure ?: IOException("Core is unavailable.")
        }
        @Suppress("UNREACHABLE_CODE")
        error("Core route selection ended unexpectedly.")
    }

    fun <T> get(logicalUrl: String, operation: (String, String) -> T): T {
        val first = pin()
        try {
            return operation(resolveUrl(logicalUrl, first), first.token)
        } catch (error: Exception) {
            val current = snapshot()
            if (!isNetworkFailure(error) || current.config.mode != "auto" || current.generation != first.generation) throw error
            val other = route(current, if (first.route == "private") "tunnel" else "private")
            invalidate()
            try {
                probe(other.baseUrl, other.token, if (other.route == "private") 1500 else 3000)
            } catch (probeError: Exception) {
                mutableStatus.value = CoreConnectionStatus(other.route, other.baseUrl, if (isNetworkFailure(probeError)) "offline" else "error")
                throw probeError
            }
            if (!publish(current, other)) throw error
            return operation(resolveUrl(logicalUrl, other), other.token)
        }
    }

    fun resolveUrl(logicalUrl: String, pinned: CorePinnedRoute): String {
        val current = snapshot()
        require(current.generation == pinned.generation) { "Connection settings changed. Try again." }
        val uri = URI(logicalUrl)
        require(uri.rawUserInfo == null && uri.rawFragment == null && listOf(current.config.privateUrl, current.config.tunnelUrl).any {
            sameOrigin(uri, URI(it))
        }) { "Core requests must use a configured endpoint." }
        return pinned.baseUrl + uri.rawPath.orEmpty().ifEmpty { "/" } + (uri.rawQuery?.let { "?$it" } ?: "")
    }

    fun mediaUrl(value: String): String {
        val current = snapshot()
        val uri = URI(value)
        require(uri.rawFragment == null && uri.rawUserInfo == null) { "Invalid audio URL." }
        if (uri.isAbsolute) {
            require(listOf(current.config.privateUrl, current.config.tunnelUrl).any { sameOrigin(uri, URI(it)) }
                || uri.host in setOf("localhost", "127.0.0.1", "::1")) { "Audio must come from the configured Core." }
        }
        require(Regex("/static/audio/[A-Za-z0-9_-]+\\.(wav|ogg|mp3)").matches(uri.rawPath.orEmpty())) { "Invalid Core audio path." }
        val base = status.value.baseUrl ?: if (current.config.mode == "tunnel") current.config.tunnelUrl else current.config.privateUrl
        return base + uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "")
    }

    private fun route(current: Snapshot, kind: String) = CorePinnedRoute(kind,
        if (kind == "private") current.config.privateUrl else current.config.tunnelUrl, current.token, current.generation)

    private fun publish(current: Snapshot, selected: CorePinnedRoute): Boolean = synchronized(stateLock) {
        if (current.generation != generation || current.config != config) return@synchronized false
        cached = selected
        validUntil = clock() + 30_000
        mutableStatus.value = CoreConnectionStatus(selected.route, selected.baseUrl, "online")
        true
    }

    companion object {
        fun isNetworkFailure(error: Throwable): Boolean = error is IOException
            && error !is SSLException && error !is FileNotFoundException
            && (error !is ProtocolException || error.message.orEmpty().contains("unexpected end", ignoreCase = true))

        private fun sameOrigin(a: URI, b: URI): Boolean {
            fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
            return a.scheme.equals(b.scheme, true) && a.host.equals(b.host, true) && port(a) == port(b)
        }
    }
}

private fun probeOwnerConnection(baseUrl: String, token: String, timeoutMillis: Int) {
    val started = System.nanoTime()
    val connection = (URL("$baseUrl/api/owner/presence").openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = timeoutMillis
        readTimeout = timeoutMillis
        setRequestProperty("Accept", "application/json")
        if (token.isNotBlank()) setRequestProperty("Authorization", "Bearer $token")
    }
    try {
        connection.connect()
        val elapsed = (System.nanoTime() - started) / 1_000_000
        if (elapsed >= timeoutMillis) throw java.net.SocketTimeoutException("Core connection check timed out.")
        connection.readTimeout = (timeoutMillis - elapsed).toInt().coerceAtLeast(1)
        val status = connection.responseCode
        if (status !in 200..299) throw CoreHttpException(status, "Core connection check failed (HTTP $status).")
        require(connection.contentType.orEmpty().contains("application/json")) { "Core returned an unexpected connection response." }
    } finally {
        connection.disconnect()
    }
}
