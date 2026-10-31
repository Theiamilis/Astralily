package com.lilyconstellation.mobile.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class WaInboxApiTest {
    @Test
    fun ownerInboxAndReminderUseProtectedEndpointsWithoutSendingAReply() {
        val requests = CopyOnWriteArrayList<String>()
        ServerSocket(0, 3, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 10_000
            val worker = thread {
                repeat(3) { index -> server.accept().use { socket ->
                    socket.soTimeout = 10_000
                    val reader = socket.getInputStream().bufferedReader()
                    val start = reader.readLine()
                    val headers = mutableListOf<String>()
                    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; headers.add(line) }
                    val length = headers.find { it.startsWith("Content-Length:", true) }?.substringAfter(':')?.trim()?.toInt() ?: 0
                    val body = CharArray(length)
                    var offset = 0
                    while (offset < length) { val count = reader.read(body, offset, length - offset); if (count < 0) break; offset += count }
                    requests.add(start + "\n" + headers.joinToString("\n") + "\n" + body.concatToString())
                    val result = when (index) {
                        0 -> """{"items":[{"id":"one","name":"Contact","summary":"Latest recap","message":"Original","reminder":{"dueAt":1791000000000,"note":"Read file","status":"scheduled"},"notificationStatus":{"wa":"uncertain"},"future_field":true}]}"""
                        1 -> """{"result":{"status":"scheduled"}}"""
                        else -> """{"items":[{"id":"event","itemId":"one","text":"Contact: Latest recap","channels":{"mobile":"ready"}}]}"""
                    }.toByteArray()
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${result.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(result); flush()
                    }
                } }
            }
            val api = MobileRealmApi().also { it.setOwnerApiToken("test-owner") }
            val base = "http://127.0.0.1:${server.localPort}"
            runBlocking {
                val inbox = api.getWaInbox(base).items.single()
                assertEquals("Latest recap", inbox.summary)
                assertEquals(1791000000000L, inbox.reminder?.dueAt)
                assertEquals("uncertain", inbox.notificationStatus["wa"])
                api.updateWaInbox(base, "remind", WaInboxAction("one", "2026-10-01T03:00:00Z", "Read file"))
                assertEquals("one", api.getWaNotices(base).items.single().itemId)
            }
            worker.join(10_000)
            assertEquals(3, requests.size)
            requests.forEach { assertTrue(it.contains("Authorization: Bearer test-owner", true)); assertFalse(it.contains("/approve")) }
            assertTrue(requests[1].startsWith("POST /api/wa/review/remind"))
            assertTrue(requests[1].contains("\"due_at\":\"2026-10-01T03:00:00Z\""))
        }
    }
}
