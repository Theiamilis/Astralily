package com.lilyconstellation.mobile.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLHandshakeException
import kotlin.concurrent.thread

class CoreConnectionManagerTest {
    private val config = CoreConnectionConfig("http://private:8000")

    @Test fun migrationKeepsExistingPrivateEndpoint() {
        val migrated = CoreConnectionConfig.restored("http://198.51.100.2:8000", null, null, null)
        assertEquals("http://198.51.100.2:8000", migrated.privateUrl)
        assertEquals(DEFAULT_TUNNEL_BASE_URL, migrated.tunnelUrl)
        assertEquals("auto", migrated.mode)
        assertEquals("https://lan.example", CoreConnectionConfig.restored("http://old", "https://lan.example", null, "private").privateUrl)
    }

    @Test fun autoCachesAndReturnsToPrivateAfterThirtySeconds() {
        var now = 0L
        var privateOnline = false
        val attempts = mutableListOf<Pair<String, Int>>()
        val manager = CoreConnectionManager(config, "owner", probe = { url, token, timeout ->
            assertEquals("owner", token)
            attempts.add(url to timeout)
            if (url == config.privateUrl && !privateOnline) throw UnknownHostException()
        }, clock = { now })
        assertEquals("tunnel", manager.pin().route)
        assertEquals(listOf(config.privateUrl to 1500, config.tunnelUrl to 3000), attempts)
        privateOnline = true
        now = 29_999
        assertEquals("tunnel", manager.pin().route)
        assertEquals(2, attempts.size)
        now = 30_000
        assertEquals("private", manager.pin().route)
        assertEquals(3, attempts.size)
    }

    @Test fun manualModesNeverTryTheOtherRoute() {
        for (mode in listOf("private", "tunnel")) {
            val attempted = mutableListOf<String>()
            val manager = CoreConnectionManager(config.copy(mode = mode), probe = { url, _, _ ->
                attempted.add(url); throw SocketTimeoutException()
            })
            assertThrows(IOException::class.java) { manager.pin() }
            assertEquals(listOf(if (mode == "private") config.privateUrl else config.tunnelUrl), attempted)
            assertEquals(mode, manager.status.value.route)
            assertEquals("offline", manager.status.value.status)
        }
    }

    @Test fun authorizationValidationRateLimitsAndCertificateFailuresStopSelection() {
        for (error in listOf(CoreHttpException(401, "auth"), CoreHttpException(422, "validation"),
            CoreHttpException(429, "rate"), SSLHandshakeException("certificate"))) {
            var attempts = 0
            val manager = CoreConnectionManager(config, probe = { _, _, _ -> attempts++; throw error })
            assertThrows(error.javaClass) { manager.pin() }
            assertEquals(1, attempts)
        }
    }

    @Test fun getRetriesOnceOnAlternativeAndDoesNotRetryHttpErrors() {
        val manager = CoreConnectionManager(config, "owner", probe = { _, _, _ -> })
        val attempts = mutableListOf<String>()
        val result = manager.get(config.privateUrl + "/api/history?user_id=mobile%3A1&limit=5") { url, token ->
            attempts.add(url); assertEquals("owner", token)
            if (attempts.size == 1) throw IOException("connection lost")
            "complete download"
        }
        assertEquals("complete download", result)
        assertEquals(listOf(config.privateUrl, config.tunnelUrl).map { it + "/api/history?user_id=mobile%3A1&limit=5" }, attempts)
        var count = 0
        assertThrows(CoreHttpException::class.java) {
            manager.get(config.privateUrl + "/api/history") { _, _ -> count++; throw CoreHttpException(401, "auth") }
        }
        assertEquals(1, count)
        count = 0
        assertThrows(IOException::class.java) { manager.get(config.privateUrl + "/health") { _, _ -> count++; throw IOException() } }
        assertEquals(2, count)
    }

    @Test fun modeChangesKeepPinnedMutationAndSignedAudioIdentity() {
        val manager = CoreConnectionManager(config, "owner", probe = { _, _, _ -> })
        val started = manager.pin()
        manager.configure(config.copy(mode = "tunnel"), "owner")
        assertEquals(config.privateUrl + "/api/core/ingest", manager.resolveUrl(config.privateUrl + "/api/core/ingest", started))
        manager.pin()
        val audio = "/static/audio/cached_123.ogg?expires=1792000000&signature=" + "a".repeat(64)
        assertEquals(config.tunnelUrl + audio, manager.mediaUrl(audio))
        assertEquals(config.tunnelUrl + audio, manager.mediaUrl(config.privateUrl + audio))
        assertThrows(IllegalArgumentException::class.java) { manager.mediaUrl("https://foreign.example" + audio) }
    }

    @Test fun tunnelRequiresHttpsAndRejectsCredentialedOrPathUrls() {
        for (tunnel in listOf("http://public.example", "https://user:pass@public.example", "https://public.example/api", "https://public.example?token=x")) {
            assertThrows(IllegalArgumentException::class.java) { CoreConnectionConfig.validated(config.privateUrl, tunnel, "auto") }
        }
        assertThrows(IllegalArgumentException::class.java) { CoreConnectionConfig.validated(config.privateUrl, config.tunnelUrl, "auto", false) }
    }

    @Test fun acceptedPostAndDeleteAreNotReplayedWhenResponseConnectionDrops() {
        for (delete in listOf(false, true)) {
            val accepted = AtomicInteger()
            val probes = AtomicInteger()
            ServerSocket(0, 5, InetAddress.getByName("127.0.0.1")).use { server ->
                server.soTimeout = 800
                val handler = thread(name = "mutation-drop-test") {
                    while (!server.isClosed) {
                        val socket = try { server.accept() } catch (_: SocketTimeoutException) { break }
                        socket.use {
                            val input = it.getInputStream()
                            val header = StringBuilder()
                            while (!header.endsWith("\r\n\r\n")) {
                                val next = input.read(); if (next == -1) break
                                header.append(next.toChar())
                            }
                            val length = Regex("(?im)^Content-Length: (\\d+)").find(header)?.groupValues?.get(1)?.toInt() ?: 0
                            repeat(length) { input.read() }
                            accepted.incrementAndGet()
                            // The server has accepted the mutation; no response is returned.
                        }
                    }
                }
                val base = "http://127.0.0.1:${server.localPort}"
                val manager = CoreConnectionManager(config.copy(privateUrl = base), "owner", probe = { _, _, _ -> probes.incrementAndGet() })
                val api = MobileRealmApi(connectionManager = manager).also { it.setOwnerApiToken("owner") }
                assertThrows(Exception::class.java) { runBlocking {
                    if (delete) api.cancelFinanceDraft(base, "fixture") else api.createFamilyInvitation(base)
                } }
                handler.join(3000)
                assertEquals(1, accepted.get())
                assertEquals(1, probes.get())
            }
        }
    }

    @Test fun partialArtifactDownloadRestartsOnAlternativeWithoutCombiningBytes() {
        val accepted = AtomicInteger()
        fun server(partial: Boolean): Pair<ServerSocket, Thread> {
            val socket = ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))
            socket.soTimeout = 3000
            val handler = thread(name = "artifact-fixture") {
                socket.accept().use { client ->
                    accepted.incrementAndGet()
                    val input = client.getInputStream().bufferedReader()
                    val request = input.readLine()
                    assertTrue(request.startsWith("GET /api/tools/openclaw/task/artifacts/file "))
                    var header = input.readLine()
                    while (!header.isNullOrEmpty()) { assertFalse(header.startsWith("Range:", true)); header = input.readLine() }
                    client.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n" +
                        if (partial) "abc" else "complete").toByteArray())
                }
            }
            return socket to handler
        }
        val (first, firstHandler) = server(true)
        val (second, secondHandler) = server(false)
        first.use { second.use {
            val base = "http://127.0.0.1:${first.localPort}"
            val manager = CoreConnectionManager(CoreConnectionConfig(base, "http://127.0.0.1:${second.localPort}"), "owner", probe = { _, _, _ -> })
            val api = MobileRealmApi(connectionManager = manager)
            assertEquals("complete", runBlocking { api.downloadArtifact(base, "task", "file") }.toString(Charsets.UTF_8))
            firstHandler.join(4000); secondHandler.join(4000)
            assertEquals(2, accepted.get())
        } }
    }
}
