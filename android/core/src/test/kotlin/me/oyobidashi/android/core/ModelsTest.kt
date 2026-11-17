package me.oyobidashi.android.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ModelsTest {
    private fun decodeRequest(json: String) = OyobidashiJson.decodeFromString(Request.serializer(), json)

    @Test
    fun `call subjects survive snapshots while old and null subjects remain optional`() {
        val request = decodeRequest("""{"id":"r","subject":"本番デプロイの承認","question":"実行しますか？"}""")
        assertEquals("本番デプロイの承認", request.subject)
        val restored = decodeRequest(OyobidashiJson.encodeToString(Request.serializer(), request))
        assertEquals(request, restored)
        assertNull(decodeRequest("""{"id":"r"}""").subject)
        assertNull(decodeRequest("""{"id":"r","subject":null}""").subject)
    }

    @Test
    fun `request_pending fixture`() {
        val r = Fixtures.request("request_pending.json")
        assertEquals("req_01JCXYZ", r.id)
        assertEquals(RequestKind.QUESTION, r.kind)
        assertEquals("本番DBのマイグレーションを実行してよいですか?", r.question)
        assertEquals("users テーブルに列を追加します", r.context)
        assertEquals(listOf("はい", "いいえ"), r.choices)
        assertEquals(Urgency.NORMAL, r.urgency)
        assertEquals(RequestStatus.PENDING, r.status)
        assertNull(r.answer)
        assertEquals(Agent("claude-code", "/path/to/project"), r.agent)
        assertEquals(Instant.parse("2026-11-15T14:00:00Z"), r.createdInstant)
        assertEquals(Instant.parse("2026-11-15T15:00:00Z"), r.expiresInstant)
        assertTrue(r.isPending)
        assertTrue(r.isAnswerable)
    }

    @Test
    fun `request_answered fixture`() {
        val r = Fixtures.request("request_answered.json")
        assertEquals(RequestStatus.ANSWERED, r.status)
        assertEquals(Answer("はい", 0, InputMethod.CHOICE, "dev_01", "2026-11-15T14:01:00.000Z"), r.answer)
        assertFalse(r.isAnswerable)
    }

    @Test
    fun `request_minimal_voice_answered fixture has nulls and millisecond timestamps`() {
        val r = Fixtures.request("request_minimal_voice_answered.json")
        assertNull(r.context)
        assertNull(r.choices)
        assertNull(r.agent)
        assertEquals(Urgency.HIGH, r.urgency)
        assertEquals(InputMethod.VOICE, r.answer?.inputMethod)
        assertNull(r.answer?.choiceIndex)
        assertEquals(Instant.parse("2026-11-15T14:05:30.250Z"), r.updatedInstant)
        assertEquals(250_000_000, r.updatedInstant!!.nano)
    }

    @Test
    fun `request_notification fixture`() {
        val r = Fixtures.request("request_notification.json")
        assertEquals(RequestKind.NOTIFICATION, r.kind)
        assertEquals(RequestStatus.NOTIFIED, r.status)
        assertEquals(Agent("codex", null), r.agent)
        assertFalse(r.isPending)
        assertFalse(r.isAnswerable)
    }

    @Test
    fun `create_request_response fixture decodes the request and ignores delivery`() {
        val env = OyobidashiJson.decodeFromString(RequestEnvelope.serializer(), Fixtures.text("create_request_response.json"))
        assertEquals(Fixtures.request("request_pending.json"), env.request)
    }

    @Test
    fun `pair_response fixture`() {
        val r = OyobidashiJson.decodeFromString(PairResponse.serializer(), Fixtures.text("pair_response.json"))
        assertEquals(Device("dev_01", "iPhone 16", "ios", "2026-11-15T13:59:00.000Z"), r.device)
        assertEquals("test-device-token", r.deviceToken)
    }

    @Test
    fun `error fixtures`() {
        val a = RelayClient.apiError(409, Fixtures.text("error_already_resolved.json"))
        assertEquals(ErrorCode.ALREADY_RESOLVED, a.code)
        assertEquals("request is already answered", a.serverMessage)
        val u = RelayClient.apiError(401, Fixtures.text("error_unauthorized.json"))
        assertEquals(ErrorCode.UNAUTHORIZED, u.code)
        assertEquals("unauthorized", u.rawCode)
    }

    @Test
    fun `event fixtures`() {
        val hello = RelayEvent.parse(Fixtures.text("event_hello.json"))
        assertEquals(RelayEvent.Hello(listOf(Fixtures.request("request_pending.json"))), hello)
        val updated = RelayEvent.parse(Fixtures.text("event_request_updated.json")) as RelayEvent.RequestUpdated
        assertEquals(RequestStatus.CANCELLED, updated.request.status)
        assertEquals("2026-11-15T14:02:00.000Z", updated.request.updatedAt)
    }

    @Test
    fun `fcm_data fixture`() {
        val data = Fixtures.json("fcm_data.json").jsonObject.mapValues { (_, v) -> (v as kotlinx.serialization.json.JsonPrimitive).content }
        val c = FcmPayloadParser.parse(data)
        assertEquals(
            NotificationContent("req_01JCXYZ", RequestKind.QUESTION, "claude-code からの質問",
                "本番DBのマイグレーションを実行してよいですか?", Urgency.NORMAL, listOf("はい", "いいえ"),
                deliveryMode = DeliveryMode.ACTIONS, status = RequestStatus.PENDING),
            c,
        )
    }

    @Test
    fun `apns_payload fixture is not used on Android but is valid JSON with a request_id`() {
        assertNotNull((Fixtures.json("apns_payload.json") as JsonObject)["request_id"])
    }

    @Test
    fun `pair body encodes structurally equal to pair_request fixture`() {
        val body = PairRequest(
            code = "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21", deviceName = "iPhone 16", platform = "ios",
            pushToken = "0000000000000000000000000000000000000000000000000000000000000000", pushEnvironment = "development",
        )
        assertEquals(Fixtures.json("pair_request.json"), OyobidashiJson.encodeToJsonElement(PairRequest.serializer(), body))
    }

    @Test
    fun `android pair body omits push_token and push_environment when absent`() {
        val json = OyobidashiJson.encodeToJsonElement(PairRequest.serializer(), PairRequest("c", "Pixel 9", "android")).jsonObject
        assertEquals(setOf("code", "device_name", "platform"), json.keys)
    }

    @Test
    fun `answer body encodes structurally equal to answer_request fixture`() {
        val body = AnswerBody("はい", 0, InputMethod.CHOICE)
        assertEquals(Fixtures.json("answer_request.json"), OyobidashiJson.encodeToJsonElement(AnswerBody.serializer(), body))
    }

    @Test
    fun `text and voice answer bodies omit choice_index`() {
        val text = OyobidashiJson.encodeToString(AnswerBody.serializer(), AnswerBody("ok", null, InputMethod.TEXT))
        assertEquals("""{"text":"ok","input_method":"text"}""", text)
        val voice = OyobidashiJson.encodeToString(AnswerBody.serializer(), AnswerBody("ok", null, InputMethod.VOICE))
        assertEquals("""{"text":"ok","input_method":"voice"}""", voice)
    }

    @Test
    fun `unknown fields are ignored at every level`() {
        val r = decodeRequest(
            """{"id":"r1","status":"answered","future":{"a":[1,2]},"agent":{"name":"x","pid":1},
               "answer":{"text":"t","input_method":"text","extra":true}}"""
        )
        assertEquals("r1", r.id)
        assertEquals("x", r.agent?.name)
        assertEquals("t", r.answer?.text)
    }

    @Test
    fun `missing optionals fall back to defaults`() {
        val r = decodeRequest("""{"id":"r1"}""")
        assertEquals(RequestKind.QUESTION, r.kind)
        assertEquals("", r.question)
        assertEquals(Urgency.NORMAL, r.urgency)
        assertEquals(RequestStatus.UNKNOWN, r.status)
        assertNull(r.choices)
        assertNull(r.createdInstant)
        assertFalse(r.isAnswerable)
    }

    @Test
    fun `explicit nulls are treated like missing fields`() {
        val r = decodeRequest(
            """{"id":"r1","kind":null,"question":null,"context":null,"choices":null,"urgency":null,
               "status":"pending","answer":null,"agent":null,"created_at":null,"updated_at":null,"expires_at":null}"""
        )
        assertEquals(RequestKind.QUESTION, r.kind)
        assertEquals("", r.question)
        assertEquals(Urgency.NORMAL, r.urgency)
        assertTrue(r.isPending)
    }

    @Test
    fun `unknown enum values do not crash`() {
        val r = decodeRequest(
            """{"id":"r1","kind":"poll","urgency":"critical","status":"snoozed",
               "answer":{"text":"t","input_method":"telepathy"}}"""
        )
        assertEquals(RequestKind.UNKNOWN, r.kind)
        assertEquals(Urgency.UNKNOWN, r.urgency)
        assertEquals(RequestStatus.UNKNOWN, r.status)
        assertEquals(InputMethod.UNKNOWN, r.answer?.inputMethod)
        assertFalse(r.isPending)
        assertFalse(r.isAnswerable)
    }

    @Test
    fun `enum wire names are case sensitive`() {
        assertEquals(RequestStatus.UNKNOWN, decodeRequest("""{"id":"r","status":"PENDING"}""").status)
        assertEquals(RequestStatus.UNKNOWN, decodeRequest("""{"id":"r","status":"unknown"}""").status)
    }

    @Test
    fun `pending request of unknown kind is not answerable`() {
        assertFalse(decodeRequest("""{"id":"r","kind":"poll","status":"pending"}""").isAnswerable)
    }

    @Test
    fun `missing id is a decode error, not a crash elsewhere`() {
        assertThrows(SerializationException::class.java) { decodeRequest("""{"status":"pending"}""") }
    }

    @Test
    fun `wrong json types are decode errors`() {
        assertThrows(SerializationException::class.java) { decodeRequest("""{"id":"r","choices":"はい"}""") }
        assertThrows(SerializationException::class.java) { decodeRequest("""[1,2]""") }
        assertThrows(SerializationException::class.java) { decodeRequest("""{"id":""") }
    }

    @Test
    fun `timestamps with and without milliseconds, and malformed ones`() {
        assertEquals(Instant.parse("2026-11-15T14:00:00Z"), parseTimestamp("2026-11-15T14:00:00.000Z"))
        assertEquals(Instant.parse("2026-11-15T14:00:00Z"), parseTimestamp("2026-11-15T14:00:00Z"))
        assertEquals(123_000_000, parseTimestamp("2026-11-15T14:00:00.123Z")!!.nano)
        assertNull(parseTimestamp(null))
        assertNull(parseTimestamp(""))
        assertNull(parseTimestamp("yesterday"))
        assertNull(parseTimestamp("2026-13-45T99:00:00Z"))
        assertNull(decodeRequest("""{"id":"r","created_at":"garbage"}""").createdInstant)
    }

    @Test
    fun `credentials toString never leaks the device token`() {
        assertFalse(Credentials("https://x", "kd_secret", "dev_1").toString().contains("kd_secret"))
    }

    @Test
    fun `in-memory credential store`() {
        val store = InMemoryCredentialStore()
        assertNull(store.load())
        val c = Credentials("https://x", "kd_1", "dev_1", "Pixel")
        store.save(c)
        assertEquals(c, store.load())
        store.clear()
        assertNull(store.load())
    }
}
