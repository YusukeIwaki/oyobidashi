package io.github.yusukeiwaki.oyobidashi.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.concurrent.TimeUnit

class ExtensionsModelsTest {
    private fun decodeRequest(json: String) = OyobidashiJson.decodeFromString(Request.serializer(), json)

    @Test
    fun `fixtures decode with explicit v0_2 fields`() {
        val pending = Fixtures.request("request_pending.json")
        assertEquals(Priority.NORMAL, pending.priority)
        assertEquals(DeliveryMode.ACTIONS, pending.deliveryMode)
        assertEquals(RequestedMode.AUTO, pending.requestedMode)
        assertNull(pending.call)
        assertFalse(pending.isLiveCall)

        val answered = Fixtures.request("request_answered.json")
        assertEquals(DeliveryMode.ACTIONS, answered.deliveryMode)
        assertNull(answered.call)

        // 選択肢なし → text。
        assertEquals(DeliveryMode.TEXT, Fixtures.request("request_notification.json").deliveryMode)
        assertEquals(DeliveryMode.TEXT, Fixtures.request("request_minimal_voice_answered.json").deliveryMode)
    }

    @Test
    fun `missing extension fields fall back to defaults`() {
        val r = decodeRequest("""{"id":"r1"}""")
        assertEquals(Priority.NORMAL, r.priority)
        assertEquals(DeliveryMode.UNKNOWN, r.deliveryMode)
        assertEquals(RequestedMode.AUTO, r.requestedMode)
        assertNull(r.call)
    }

    @Test
    fun `explicit nulls are treated like missing fields`() {
        val r = decodeRequest("""{"id":"r1","priority":null,"delivery_mode":null,"requested_mode":null,"call":null}""")
        assertEquals(Priority.NORMAL, r.priority)
        assertEquals(DeliveryMode.UNKNOWN, r.deliveryMode)
        assertEquals(RequestedMode.AUTO, r.requestedMode)
        assertNull(r.call)
    }

    @Test
    fun `unknown enum values do not crash`() {
        val r = decodeRequest("""{"id":"r1","priority":"critical","delivery_mode":"video","requested_mode":"sometimes"}""")
        assertEquals(Priority.UNKNOWN, r.priority)
        assertEquals(DeliveryMode.UNKNOWN, r.deliveryMode)
        assertEquals(RequestedMode.UNKNOWN, r.requestedMode)
    }

    @Test
    fun `call decodes with transcript and helpers`() {
        val r = decodeRequest(
            """{"id":"req1","status":"pending","kind":"question","priority":"high","delivery_mode":"call",
               "requested_mode":"call","call":{"id":"call1","request_id":"req1","state":"ringing",
               "outcome":null,"device_id":null,"started_at":"2026-11-15T14:00:00.000Z",
               "updated_at":"2026-11-15T14:00:05.000Z",
               "transcript":[{"role":"assistant","text":"hello"},{"role":"user","text":"hi"}]}}"""
        )
        assertEquals(Priority.HIGH, r.priority)
        assertEquals(DeliveryMode.CALL, r.deliveryMode)
        assertEquals(RequestedMode.CALL, r.requestedMode)
        val call = r.call!!
        assertEquals("call1", call.id)
        assertEquals(CallState.RINGING, call.state)
        assertNull(call.outcome)
        assertNull(call.deviceId)
        assertTrue(call.isValid)
        assertTrue(call.isLive)
        assertTrue(r.isLiveCall)
        assertFalse(r.isCallFallback)
        assertEquals(
            listOf(CallTranscriptEntry(CallRole.ASSISTANT, "hello"), CallTranscriptEntry(CallRole.USER, "hi")),
            call.transcript,
        )
        assertEquals(Instant.parse("2026-11-15T14:00:00Z"), call.startedInstant)
    }

    @Test
    fun `call with missing id is invalid and falls back`() {
        val r = decodeRequest("""{"id":"req1","status":"pending","delivery_mode":"call","call":{"state":"ringing"}}""")
        val call = r.call!!
        assertFalse(call.isValid)
        assertFalse(r.isLiveCall)
        // isValid=false の call は live 扱いしない
        assertFalse(r.isCallFallback)
    }

    @Test
    fun `ended call with pending request is fallback`() {
        val r = decodeRequest(
            """{"id":"req1","status":"pending","delivery_mode":"text",
               "call":{"id":"c1","request_id":"req1","state":"ended","outcome":"declined"}}"""
        )
        assertEquals(CallState.ENDED, r.call!!.state)
        assertEquals(CallOutcome.DECLINED, r.call!!.outcome)
        assertFalse(r.isLiveCall)
        assertTrue(r.isCallFallback)
    }

    @Test
    fun `unknown call enums do not crash`() {
        val r = decodeRequest(
            """{"id":"req1","call":{"id":"c1","state":"dialing","outcome":"vanished",
               "transcript":[{"role":"system","text":"x"}]}}"""
        )
        assertEquals(CallState.UNKNOWN, r.call!!.state)
        assertEquals(CallOutcome.UNKNOWN, r.call!!.outcome)
        assertEquals(CallRole.UNKNOWN, r.call!!.transcript.single().role)
        assertFalse(r.isLiveCall)
    }

    @Test
    fun `call outcome null stays null, not UNKNOWN`() {
        val r = decodeRequest("""{"id":"req1","call":{"id":"c1","state":"ringing","outcome":null}}""")
        assertNull(r.call!!.outcome)
    }

    @Test
    fun `presence expiry becomes available`() {
        val now = Instant.parse("2026-11-15T14:00:00Z")
        val busy = DevicePresence(Availability.BUSY, "2026-11-15T14:30:00Z", null, null)
        assertFalse(busy.isExpired(now))
        assertEquals(Availability.BUSY, busy.effective(now).availability)
        assertTrue(busy.isExpired(Instant.parse("2026-11-15T14:30:00Z")))
        assertEquals(Availability.AVAILABLE, busy.effective(Instant.parse("2026-11-15T14:31:00Z")).availability)
        val awayIndefinite = DevicePresence(Availability.AWAY, null, "out", null)
        assertFalse(awayIndefinite.isExpired(now))
        assertEquals(Availability.AWAY, awayIndefinite.effective(now).availability)
        val available = DevicePresence()
        assertEquals(Availability.AVAILABLE, available.effectiveAvailability)
    }

    @Test
    fun `call event body omits text when absent`() {
        val answer = OyobidashiJson.encodeToString(CallEventBody.serializer(), CallEventBody(CallEvent.ANSWER))
        assertEquals("""{"event":"answer"}""", answer)
        val turn = OyobidashiJson.encodeToString(CallEventBody.serializer(), CallEventBody(CallEvent.TURN, "hello"))
        assertEquals("""{"event":"turn","text":"hello"}""", turn)
    }

    @Test
    fun `presence and call urls`() {
        assertEquals("http://x/v1/presence", RelayClient.buildUrl("http://x", "presence").toString())
        assertEquals("http://x/v1/presence", RelayClient.buildUrl("http://x/", "presence").toString())
        assertEquals("http://x/p/v1/presence", RelayClient.buildUrl("http://x/p", "presence").toString())
        assertEquals(
            "http://x/v1/requests/r1/call",
            RelayClient.buildUrl("http://x", "requests", "r1", "call").toString(),
        )
        assertEquals(
            "http://x/v1/requests/a%2Fb/call",
            RelayClient.buildUrl("http://x", "requests", "a/b", "call").toString(),
        )
    }

    @Test
    fun `call response decodes with optional reply and resolved`() {
        val body = Fixtures.text("request_pending.json")
        val full = OyobidashiJson.decodeFromString(
            CallResponse.serializer(),
            """{"request":$body,"call":{"id":"c1","request_id":"req_01JCXYZ","state":"active"},"reply":"question?","resolved":false}""",
        )
        assertEquals("req_01JCXYZ", full.request.id)
        assertEquals("c1", full.call!!.id)
        assertEquals("question?", full.reply)
        assertFalse(full.isResolved)
        val minimal = OyobidashiJson.decodeFromString(CallResponse.serializer(), """{"request":$body}""")
        assertNull(minimal.call)
        assertNull(minimal.reply)
        assertFalse(minimal.isResolved)
    }
}

class ExtensionsRelayClientTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build()
    private val token = "kd_test_token"

    @Before fun setUp() { server = MockWebServer().also { it.start() } }
    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun baseUrl() = server.url("/").toString().trimEnd('/')
    private fun client() = RelayClient(http, baseUrl(), token)
    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json; charset=utf-8").setBody(body)

    @Test
    fun `updatePresence puts availability until and note`() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"ok":true}"""))
        client().updatePresence(PresenceUpdate(Availability.BUSY, PresenceUntil.Set("2026-11-15T14:30:00.000Z"), PresenceNote.Set("lunch")))
        val rec = server.takeRequest()
        assertEquals("PUT", rec.method)
        assertEquals("/v1/presence", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
        assertEquals(
            OyobidashiJson.parseToJsonElement("""{"availability":"busy","until":"2026-11-15T14:30:00.000Z","note":"lunch"}"""),
            OyobidashiJson.parseToJsonElement(rec.body.readUtf8()),
        )
        client().updatePresence(PresenceUpdate(Availability.AVAILABLE, PresenceUntil.Clear, PresenceNote.Clear))
        assertEquals(
            JsonObject(mapOf("availability" to JsonPrimitive("available"), "until" to JsonNull, "note" to JsonNull)),
            OyobidashiJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject,
        )
    }

    @Test
    fun `updatePresence omits kept fields`() = runBlocking {
        server.enqueue(json("""{}"""))
        client().updatePresence(PresenceUpdate(Availability.AWAY))
        assertEquals(
            JsonObject(mapOf("availability" to JsonPrimitive("away"))),
            OyobidashiJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject,
        )
    }

    @Test
    fun `postCall posts event and decodes response`() = runBlocking {
        val req = Fixtures.text("request_pending.json")
        server.enqueue(json("""{"request":$req,"call":{"id":"c1","request_id":"req_01JCXYZ","state":"active"},"reply":"hi?","resolved":false}"""))
        val res = client().postCall("req_01JCXYZ", CallEventBody(CallEvent.ANSWER))
        assertEquals("req_01JCXYZ", res.request.id)
        assertEquals("c1", res.call!!.id)
        assertEquals("hi?", res.reply)
        val rec = server.takeRequest()
        assertEquals("POST", rec.method)
        assertEquals("/v1/requests/req_01JCXYZ/call", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
        assertEquals(
            OyobidashiJson.parseToJsonElement("""{"event":"answer"}"""),
            OyobidashiJson.parseToJsonElement(rec.body.readUtf8()),
        )
    }

    @Test
    fun `postCall turn includes text`() = runBlocking {
        val req = Fixtures.text("request_pending.json")
        server.enqueue(json("""{"request":$req,"resolved":true,"reply":"done"}"""))
        val res = client().postCall("r1", CallEventBody(CallEvent.TURN, "my answer"))
        assertTrue(res.isResolved)
        assertEquals(
            OyobidashiJson.parseToJsonElement("""{"event":"turn","text":"my answer"}"""),
            OyobidashiJson.parseToJsonElement(server.takeRequest().body.readUtf8()),
        )
    }

    @Test
    fun `updateDevice supports voip_token independently`() = runBlocking {
        server.enqueue(json("""{"device":{"id":"dev_01"}}"""))
        client().updateDevice(DeviceUpdate(voipToken = VoipTokenUpdate.Set("voip123")))
        assertEquals(
            JsonObject(mapOf("voip_token" to JsonPrimitive("voip123"))),
            OyobidashiJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject,
        )
    }
}

class ExtensionsNotificationsTest {
    @Test
    fun `fcm v0_2 fields parse`() {
        val c = FcmPayloadParser.parse(
            mapOf(
                "request_id" to "r1", "priority" to "urgent", "delivery_mode" to "call",
                "call_id" to "c1", "body" to "hello",
            ),
        )!!
        assertEquals(Priority.URGENT, c.priority)
        assertEquals(DeliveryMode.CALL, c.deliveryMode)
        assertEquals("c1", c.callId)
        assertTrue(c.isCall)
        assertFalse(c.isTerminalPush)
    }

    @Test
    fun `fcm missing v0_2 fields default to legacy`() {
        val c = FcmPayloadParser.parse(mapOf("request_id" to "r1"))!!
        assertEquals(Priority.NORMAL, c.priority)
        assertEquals(DeliveryMode.UNKNOWN, c.deliveryMode)
        assertNull(c.callId)
        assertFalse(c.silent)
        assertFalse(c.isCall)
        assertFalse(c.isTerminalPush)
    }

    @Test
    fun `fcm unknown priority and delivery fall back`() {
        val c = FcmPayloadParser.parse(mapOf("request_id" to "r1", "priority" to "critical", "delivery_mode" to "video"))!!
        assertEquals(Priority.NORMAL, c.priority)
        assertEquals(DeliveryMode.UNKNOWN, c.deliveryMode)
    }

    @Test
    fun `fcm question fallback for body`() {
        val c = FcmPayloadParser.parse(mapOf("request_id" to "r1", "call_id" to "c1", "question" to "q?"))!!
        assertEquals("q?", c.body)
        assertTrue(c.isCall)
    }

    @Test
    fun `fcm call json string carries the call id`() {
        // フィクスチャ同様、call 無しは "null" 文字列。
        assertNull(FcmPayloadParser.parseCallIdFromJsonString("null"))
        assertNull(FcmPayloadParser.parseCallIdFromJsonString(null))
        assertNull(FcmPayloadParser.parseCallIdFromJsonString(""))
        assertNull(FcmPayloadParser.parseCallIdFromJsonString("not json"))
        assertNull(FcmPayloadParser.parseCallIdFromJsonString("""{"state":"ringing"}"""))
        assertNull(FcmPayloadParser.parseCallIdFromJsonString("""{"id":""}"""))
        assertEquals("c9", FcmPayloadParser.parseCallIdFromJsonString("""{"id":"c9","state":"ringing"}"""))
        val c = FcmPayloadParser.parse(mapOf("request_id" to "r1", "call" to """{"id":"c9"}"""))!!
        assertEquals("c9", c.callId)
        assertTrue(c.isCall)
        // 明示の call_id が優先。
        val explicit = FcmPayloadParser.parse(mapOf("request_id" to "r1", "call_id" to "c1", "call" to """{"id":"c9"}"""))!!
        assertEquals("c1", explicit.callId)
    }

    @Test
    fun `fcm silent and terminal pushes`() {
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "silent" to "true"))!!.isTerminalPush)
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "silent" to "1"))!!.isTerminalPush)
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "type" to "cancel"))!!.isTerminalPush)
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "type" to "request.updated"))!!.isTerminalPush)
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "status" to "cancelled"))!!.isTerminalPush)
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "status" to "answered"))!!.isTerminalPush)
        assertFalse(FcmPayloadParser.parse(mapOf("request_id" to "r", "status" to "pending"))!!.isTerminalPush)
        // 未知の status は解決済み扱い (将来の終端値で stale 通知を出さない)。
        assertTrue(FcmPayloadParser.parse(mapOf("request_id" to "r", "status" to "bogus"))!!.isTerminalPush)
        assertFalse(FcmPayloadParser.parse(mapOf("request_id" to "r", "status" to ""))!!.isTerminalPush)
    }

    @Test
    fun `actions plan respects delivery mode`() {
        fun content(mode: DeliveryMode, n: Int) = NotificationContent(
            "r", RequestKind.QUESTION, "t", "b", choices = List(n) { "c$it" }, deliveryMode = mode,
        )
        // text/call はボタン無し
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(content(DeliveryMode.TEXT, 2)))
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(content(DeliveryMode.CALL, 2)))
        // actions は旧来どおり
        assertEquals(NotificationActions(listOf(0, 1), false), NotificationActions.plan(content(DeliveryMode.ACTIONS, 2)))
        assertEquals(NotificationActions(listOf(0, 1, 2), false), NotificationActions.plan(content(DeliveryMode.ACTIONS, 3)))
        // silent/terminal はボタン無し
        val silent = content(DeliveryMode.ACTIONS, 2).copy(silent = true)
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(silent))
    }

    @Test
    fun `content from live call request carries call id`() {
        val req = request("r1", deliveryMode = DeliveryMode.CALL, call = ringingCall("c9", "r1"))
        val c = NotificationContent.fromRequest(req)
        assertEquals("c9", c.callId)
        assertTrue(c.isCall)
        assertEquals(RequestStatus.PENDING, c.status)
    }
}

class ExtensionsRepositoryTest {
    @Test
    fun `live call created does not post a regular notification`() {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val repo = RequestsRepository(api, notifier)
        val callReq = request("r1", deliveryMode = DeliveryMode.CALL, call = ringingCall("c1", "r1"))
        repo.onEvent(RelayEvent.RequestCreated(callReq))
        assertEquals(callReq, repo.state.value.find("r1"))
        assertTrue(notifier.shown.isEmpty())
        // 通常リクエストは従来どおり通知する
        repo.onEvent(RelayEvent.RequestCreated(request("r2", choices = listOf("a"))))
        assertEquals(1, notifier.shown.size)
    }

    @Test
    fun `terminal push adds no placeholder`() {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val repo = RequestsRepository(api, notifier)
        repo.onPushReceived(NotificationContent("r1", RequestKind.QUESTION, "t", "b", silent = true))
        repo.onPushReceived(NotificationContent("r2", RequestKind.QUESTION, "t", "b", status = RequestStatus.CANCELLED))
        assertTrue(repo.state.value.requests.isEmpty())
    }

    @Test
    fun `push placeholder keeps priority and delivery mode`() {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val repo = RequestsRepository(api, notifier)
        repo.onPushReceived(
            NotificationContent("r1", RequestKind.QUESTION, "t", "b", priority = Priority.HIGH, deliveryMode = DeliveryMode.TEXT),
        )
        val placeholder = repo.state.value.find("r1")!!
        assertEquals(Priority.HIGH, placeholder.priority)
        assertEquals(DeliveryMode.TEXT, placeholder.deliveryMode)
    }

    @Test
    fun `fake api records presence and call`() = runTest {
        val api = FakeApi()
        api.updatePresence(PresenceUpdate(Availability.BUSY, PresenceUntil.Set("2026-11-15T14:30:00.000Z")))
        api.postCall("r1", CallEventBody(CallEvent.ANSWER))
        assertEquals(Availability.BUSY, api.presenceCalls.single().availability)
        assertEquals("r1" to CallEventBody(CallEvent.ANSWER), api.callCalls.single())
    }
}
