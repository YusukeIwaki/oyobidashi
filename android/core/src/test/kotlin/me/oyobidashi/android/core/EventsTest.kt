package me.oyobidashi.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class RelayEventParseTest {
    @Test
    fun `hello with empty, missing or null pending`() {
        assertEquals(RelayEvent.Hello(emptyList()), RelayEvent.parse("""{"type":"hello","pending":[]}"""))
        assertEquals(RelayEvent.Hello(emptyList()), RelayEvent.parse("""{"type":"hello"}"""))
        assertEquals(RelayEvent.Hello(emptyList()), RelayEvent.parse("""{"type":"hello","pending":null}"""))
    }

    @Test
    fun `created, updated and pong`() {
        val body = Fixtures.text("request_pending.json")
        assertEquals(RelayEvent.RequestCreated(Fixtures.request("request_pending.json")), RelayEvent.parse("""{"type":"request.created","request":$body}"""))
        assertEquals(RelayEvent.RequestUpdated(Fixtures.request("request_pending.json")), RelayEvent.parse("""{"type":"request.updated","request":$body,"extra":1}"""))
        assertEquals(RelayEvent.Pong, RelayEvent.parse("""{"type":"pong"}"""))
    }

    @Test
    fun `unknown types and malformed frames are ignored`() {
        for (frame in listOf(
            """{"type":"request.deleted","request":{"id":"r"}}""", """{"type":"ping"}""", """{"type":42}""", """{"type":null}""",
            """{}""", """[]""", "null", "", "not json", """{"type":"hello","pending":"x"}""", """{"type":"hello","pending":[{"status":"pending"}]}""",
            """{"type":"request.created"}""", """{"type":"request.created","request":null}""", """{"type":"request.updated","request":{"status":"answered"}}""",
            """{"type":"request.created","request":[]}""",
        )) {
            assertNull(frame, RelayEvent.parse(frame))
        }
    }
}

class EventsUrlTest {
    @Test
    fun `http base url becomes ws and https becomes wss`() {
        assertEquals("ws://192.168.1.10:8787/v1/events", eventsUrl("http://192.168.1.10:8787"))
        assertEquals("ws://192.168.1.10:8787/v1/events", eventsUrl("http://192.168.1.10:8787/"))
        assertEquals("ws://192.168.1.10/v1/events", eventsUrl("http://192.168.1.10"))
        assertEquals("wss://relay.example/v1/events", eventsUrl("https://relay.example"))
        assertEquals("wss://relay.example:8443/prefix/v1/events", eventsUrl("https://relay.example:8443/prefix/"))
        assertEquals("ws://[::1]:8787/v1/events", eventsUrl("http://[::1]:8787"))
        assertEquals("ws://my-mac.local:8787/v1/events", eventsUrl("HTTP://my-mac.local:8787"))
    }

    @Test(expected = RelayException.InvalidBaseUrl::class)
    fun `invalid base url is rejected`() {
        eventsUrl("ftp://x")
    }
}

/** OkHttp 実装を MockWebServer の実ソケットで検証する。 */
class OkHttpEventSocketConnectorTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    @Before fun setUp() { server = MockWebServer().also { it.start() } }
    @After fun tearDown() {
        runCatching { server.shutdown() }
        http.dispatcher.executorService.shutdown()
    }

    private class Recorder : EventSocketListener {
        val events = LinkedBlockingQueue<String>()
        override fun onOpen() { events += "open" }
        override fun onText(text: String) { events += "text:$text" }
        override fun onClosed(httpStatus: Int?, cause: Throwable?) { events += "closed:$httpStatus" }
        fun next(): String = events.poll(5, TimeUnit.SECONDS) ?: error("timed out waiting for socket event")
    }

    private fun connector(token: String = "kd_tok") = OkHttpEventSocketConnector(http, server.url("/").toString(), token)

    @Test
    fun `sends Authorization header to v1 events and delivers text frames`() {
        val fromClient = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(Fixtures.text("event_hello.json"))
            }
            override fun onMessage(webSocket: WebSocket, text: String) { fromClient += text }
        }))
        val rec = Recorder()
        val socket = connector().connect(rec)
        assertEquals("open", rec.next())
        assertTrue(rec.next().startsWith("text:"))
        val upgrade = server.takeRequest()
        assertEquals("/v1/events", upgrade.path)
        assertEquals("Bearer kd_tok", upgrade.getHeader("Authorization"))
        assertEquals("websocket", upgrade.getHeader("Upgrade"))
        assertFalse(upgrade.requestUrl.toString().contains("kd_tok"))

        assertTrue(socket.send(RelayEvent.PING_FRAME))
        assertEquals("""{"type":"ping"}""", fromClient.poll(5, TimeUnit.SECONDS))
        socket.cancel()
    }

    @Test
    fun `401 on upgrade is reported with the http status`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody(Fixtures.text("error_unauthorized.json")))
        val rec = Recorder()
        connector().connect(rec)
        assertEquals("closed:401", rec.next())
    }

    @Test
    fun `non-websocket 200 and 403 are reported as failures`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html>"))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"forbidden","message":"x"}}"""))
        val a = Recorder(); connector().connect(a)
        assertEquals("closed:200", a.next())
        val b = Recorder(); connector().connect(b)
        assertEquals("closed:403", b.next())
    }

    @Test
    fun `server close and connection refused are reported without a status`() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.close(1001, "bye") }
        }))
        val rec = Recorder()
        connector().connect(rec)
        assertEquals("open", rec.next())
        assertEquals("closed:null", rec.next())

        val dead = OkHttpEventSocketConnector(http, server.url("/").toString(), "t")
        server.shutdown()
        val rec2 = Recorder()
        dead.connect(rec2)
        assertEquals("closed:null", rec2.next())
    }

    @Test
    fun `end to end - EventsClient reconnects after the server drops, and stops on 401`() {
        val helloAndClose = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"hello","pending":[]}""")
                webSocket.close(1000, null)
            }
        }
        server.enqueue(MockResponse().withWebSocketUpgrade(helloAndClose))
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().withWebSocketUpgrade(helloAndClose))
        server.enqueue(MockResponse().setResponseCode(401))

        val log = LinkedBlockingQueue<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
        val client = EventsClient(connector(), scope, object : EventsListener {
            override fun onEvent(event: RelayEvent) { log += "event:${event::class.simpleName}" }
            override fun onUnauthorized() { log += "unauthorized" }
        }, backoff = { 20 })
        client.start()
        try {
            assertEquals("event:Hello", log.poll(5, TimeUnit.SECONDS))
            assertEquals("event:Hello", log.poll(5, TimeUnit.SECONDS))
            assertEquals("unauthorized", log.poll(5, TimeUnit.SECONDS))
            assertEquals(4, server.requestCount)
            Thread.sleep(150)
            assertEquals("no reconnect after 401", 4, server.requestCount)
            assertEquals(ConnectionState.UNAUTHORIZED, client.state)
        } finally {
            client.stop()
            scope.cancel()
        }
    }
}

/** 再接続ロジックを fake ソケット + 仮想時間で検証する。 */
@OptIn(ExperimentalCoroutinesApi::class)
class EventsClientTest {
    private class FakeSocket(val listener: EventSocketListener) : EventSocket {
        val sent = mutableListOf<String>()
        var cancelled = false
        override fun send(text: String): Boolean { sent += text; return true }
        override fun cancel() { cancelled = true }
    }

    private class FakeConnector : EventSocketConnector {
        val sockets = mutableListOf<FakeSocket>()
        val connectTimes = mutableListOf<Long>()
        var now: () -> Long = { 0 }
        override fun connect(listener: EventSocketListener): EventSocket {
            connectTimes += now()
            return FakeSocket(listener).also { sockets += it }
        }
        val last get() = sockets.last()
    }

    private class Recorder : EventsListener {
        val events = CopyOnWriteArrayList<RelayEvent>()
        val states = CopyOnWriteArrayList<ConnectionState>()
        var unauthorized = 0
        override fun onEvent(event: RelayEvent) { events += event }
        override fun onStateChanged(state: ConnectionState) { states += state }
        override fun onUnauthorized() { unauthorized++ }
    }

    private fun TestScope.fixture(backoff: Backoff = ExponentialBackoff(), ping: Long = 30_000): Triple<EventsClient, FakeConnector, Recorder> {
        val connector = FakeConnector().apply { now = { testScheduler.currentTime } }
        val recorder = Recorder()
        val client = EventsClient(connector, CoroutineScope(StandardTestDispatcher(testScheduler)), recorder, backoff, ping)
        return Triple(client, connector, recorder)
    }

    @Test
    fun `default backoff schedule is 1s 2s 4s 8s 16s 30s 30s`() {
        val b = ExponentialBackoff()
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), (0..6).map { b.delayMillis(it) })
        assertEquals(30000L, b.delayMillis(1000))
        assertEquals(1000L, b.delayMillis(-1))
    }

    @Test
    fun `start connects once and is idempotent`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); client.start()
        runCurrent()
        assertEquals(1, connector.sockets.size)
        assertEquals(listOf(ConnectionState.CONNECTING), rec.states)
        connector.last.listener.onOpen()
        runCurrent()
        assertEquals(ConnectionState.CONNECTED, client.state)
        client.stop()
    }

    @Test
    fun `events are decoded and unknown ones are dropped`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        val l = connector.last.listener
        l.onOpen()
        l.onText(Fixtures.text("event_hello.json"))
        l.onText("""{"type":"mystery"}""")
        l.onText("garbage")
        l.onText(Fixtures.text("event_request_updated.json"))
        l.onText("""{"type":"pong"}""")
        runCurrent()
        assertEquals(3, rec.events.size)
        assertTrue(rec.events[0] is RelayEvent.Hello)
        assertTrue(rec.events[1] is RelayEvent.RequestUpdated)
        assertEquals(RelayEvent.Pong, rec.events[2])
        client.stop()
    }

    @Test
    fun `repeated failures follow the backoff schedule`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        repeat(7) {
            connector.last.listener.onClosed(null, java.io.IOException("refused"))
            runCurrent()
            assertEquals(ConnectionState.WAITING_TO_RECONNECT, client.state)
            advanceTimeBy(30_001)
            runCurrent()
        }
        val gaps = connector.connectTimes.zipWithNext { a, b -> b - a }
        // 待ち時間ちょうどで再接続する (advanceTimeBy の切り上げ分を引いて検証)
        assertEquals(8, connector.connectTimes.size)
        assertEquals(1000L, connector.connectTimes[1])
        assertTrue(gaps.toString(), connector.sockets.dropLast(1).all { it.cancelled })
        assertEquals(0, rec.unauthorized)
        client.stop()
    }

    @Test
    fun `reconnect happens exactly when the backoff elapses`() = runTest {
        val (client, connector, _) = fixture()
        client.start(); runCurrent()
        val expected = listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L)
        for (delayMs in expected) {
            val before = connector.sockets.size
            connector.last.listener.onClosed(503, null)
            runCurrent()
            advanceTimeBy(delayMs - 1); runCurrent()
            assertEquals("should still be waiting at ${delayMs - 1}ms", before, connector.sockets.size)
            advanceTimeBy(1); runCurrent()
            assertEquals("should reconnect at ${delayMs}ms", before + 1, connector.sockets.size)
        }
        client.stop()
    }

    @Test
    fun `backoff resets after a successful open`() = runTest {
        val (client, connector, _) = fixture()
        client.start(); runCurrent()
        repeat(3) { // 1s, 2s, 4s
            connector.last.listener.onClosed(null, null); runCurrent()
            advanceTimeBy(4000); runCurrent()
        }
        assertEquals(4, connector.sockets.size)
        connector.last.listener.onOpen(); runCurrent()
        connector.last.listener.onClosed(null, null); runCurrent()
        advanceTimeBy(999); runCurrent()
        assertEquals(4, connector.sockets.size)
        advanceTimeBy(1); runCurrent()
        assertEquals(5, connector.sockets.size)
        client.stop()
    }

    @Test
    fun `401 on upgrade stops reconnecting and reports unauthorized once`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        connector.last.listener.onClosed(401, null)
        runCurrent()
        advanceTimeBy(120_000); runCurrent()
        assertEquals(1, connector.sockets.size)
        assertEquals(1, rec.unauthorized)
        assertEquals(ConnectionState.UNAUTHORIZED, client.state)
        assertFalse(client.isRunning)
        assertTrue(connector.last.cancelled)
    }

    @Test
    fun `other http failures like 403 and 500 keep retrying`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        connector.last.listener.onClosed(403, null); runCurrent()
        advanceTimeBy(1000); runCurrent()
        connector.last.listener.onClosed(500, null); runCurrent()
        advanceTimeBy(2000); runCurrent()
        assertEquals(3, connector.sockets.size)
        assertEquals(0, rec.unauthorized)
        client.stop()
    }

    @Test
    fun `no reconnect after explicit stop while connected`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        connector.last.listener.onOpen(); runCurrent()
        client.stop()
        runCurrent()
        assertTrue(connector.last.cancelled)
        connector.last.listener.onClosed(null, null) // cancel による切断通知が遅れて届いても無視
        advanceTimeBy(120_000); runCurrent()
        assertEquals(1, connector.sockets.size)
        assertEquals(ConnectionState.STOPPED, client.state)
        assertEquals(ConnectionState.STOPPED, rec.states.last())
        assertFalse(client.isRunning)
    }

    @Test
    fun `no reconnect after stop during backoff wait, and events after stop are not delivered`() = runTest {
        val (client, connector, rec) = fixture()
        client.start(); runCurrent()
        val first = connector.last
        first.listener.onClosed(null, null); runCurrent()
        client.stop()
        first.listener.onText("""{"type":"pong"}""")
        advanceTimeBy(120_000); runCurrent()
        assertEquals(1, connector.sockets.size)
        assertTrue(rec.events.isEmpty())
    }

    @Test
    fun `can be restarted after stop`() = runTest {
        val (client, connector, _) = fixture()
        client.start(); runCurrent()
        client.stop(); runCurrent()
        client.start(); runCurrent()
        assertEquals(2, connector.sockets.size)
        assertTrue(client.isRunning)
        client.stop()
    }

    @Test
    fun `reconnectNow cuts the backoff wait short and is a no-op while connected`() = runTest {
        val (client, connector, _) = fixture()
        client.start(); runCurrent()
        repeat(5) {
            connector.last.listener.onClosed(null, null); runCurrent()
            advanceTimeBy(16_000); runCurrent()
        }
        connector.last.listener.onClosed(null, null); runCurrent() // 次は 30s 待ち
        val before = connector.sockets.size
        client.reconnectNow(); runCurrent()
        assertEquals(before + 1, connector.sockets.size)
        connector.last.listener.onOpen(); runCurrent()
        client.reconnectNow(); runCurrent()
        assertEquals(before + 1, connector.sockets.size)
        advanceTimeBy(60_000); runCurrent()
        assertEquals("the cancelled wait must not reconnect later", before + 1, connector.sockets.size)
        client.stop()
    }

    @Test
    fun `sends ping frames periodically only while open`() = runTest {
        val (client, connector, _) = fixture(ping = 30_000)
        client.start(); runCurrent()
        val socket = connector.last
        advanceTimeBy(60_000); runCurrent()
        assertTrue("no ping before open", socket.sent.isEmpty())
        socket.listener.onOpen(); runCurrent()
        advanceTimeBy(90_000); runCurrent()
        assertEquals(List(3) { """{"type":"ping"}""" }, socket.sent)
        socket.listener.onClosed(null, null); runCurrent()
        advanceTimeBy(1000); runCurrent()
        advanceTimeBy(90_000); runCurrent()
        assertEquals("old socket gets no more pings", 3, socket.sent.size)
        client.stop()
    }

    @Test
    fun `duplicate close notifications cause a single reconnect`() = runTest {
        val (client, connector, _) = fixture()
        client.start(); runCurrent()
        val l = connector.last.listener
        l.onOpen(); l.onClosed(null, null); l.onClosed(null, null); l.onClosed(null, java.io.IOException())
        runCurrent()
        advanceTimeBy(1000); runCurrent()
        assertEquals(2, connector.sockets.size)
        client.stop()
    }
}
