package com.lilyconstellation.mobile.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class OwnerApiAuthorizationTest {
    @Test
    fun coreRequestsUseTheConfiguredOwnerToken() {
        val authorizationHeaders = CopyOnWriteArrayList<String>()
        ServerSocket(0, 2, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 3000
            val handler = thread(start = true, name = "owner-auth-test-server") {
                server.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                    reader.readLine()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Authorization:", ignoreCase = true)) {
                            authorizationHeaders.add(line.substringAfter(':').trim())
                        }
                    }
                    val body = "{\"status\":\"ok\"}".toByteArray(Charsets.UTF_8)
                    val response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                    socket.getOutputStream().use { output ->
                        output.write(response.toByteArray(Charsets.US_ASCII))
                        output.write(body)
                    }
                }
            }
            val api = MobileRealmApi().also { it.setOwnerApiToken("owner-token-test") }
            runBlocking { api.getHealth("http://127.0.0.1:${server.localPort}") }
            handler.join(5000)
            assertEquals(listOf("Bearer owner-token-test"), authorizationHeaders.toList())
        }
    }
}
