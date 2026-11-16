package io.github.yusukeiwaki.oyobidashi.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class RelayClientTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(500, TimeUnit.MILLISECONDS).build()
    private val token = "kd_test_token"

    @Before fun setUp() { server = MockWebServer().also { it.start() } }
    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun baseUrl() = server.url("/").toString().trimEnd('/')
    private fun client(base: String = baseUrl(), deviceToken: String? = token) = RelayClient(http, base, deviceToken)
    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json; charset=utf-8").setBody(body)

    private fun requestEnvelope(fixture: String) = """{"request":${Fixtures.text(fixture)}}"""
    private fun bodyJson(recorded: okhttp3.mockwebserver.RecordedRequest) =
        OyobidashiJson.parseToJsonElement(recorded.body.readUtf8()) as JsonObject

    private inline fun <reified T : RelayException> expect(block: () -> Unit): T {
        try {
            block()
        } catch (e: RelayException) {
            if (e is T) return e
            throw AssertionError("expected ${T::class.simpleName} but was $e", e)
        }
        fail("expected ${T::class.simpleName} but nothing was thrown")
        throw IllegalStateException()
    }

    // ---- 正常系: method / path / headers / body ----

    @Test
    fun `pair posts the contract body without Authorization`() = runBlocking {
        server.enqueue(json(Fixtures.text("pair_response.json"), 201))
        val res = client().pair(PairRequest("code1", "Pixel 9", "android", pushToken = "fcm-token"))
        assertEquals("dev_01", res.device.id)
        assertEquals("test-device-token", res.deviceToken)
        val rec = server.takeRequest()
        assertEquals("POST", rec.method)
        assertEquals("/v1/pair", rec.path)
        assertNull(rec.getHeader("Authorization"))
        assertEquals("application/json; charset=utf-8", rec.getHeader("Content-Type"))
        assertEquals(
            OyobidashiJson.parseToJsonElement("""{"code":"code1","device_name":"Pixel 9","platform":"android","push_token":"fcm-token"}"""),
            bodyJson(rec),
        )
    }

    @Test
    fun `updateDevice sets the push token`() = runBlocking {
        server.enqueue(json("""{"device":{"id":"dev_01","name":"Pixel","platform":"android","created_at":"2026-11-15T13:59:00.000Z"}}"""))
        val device = client().updateDevice(DeviceUpdate(PushTokenUpdate.Set("tok")))
        assertEquals("dev_01", device.id)
        val rec = server.takeRequest()
        assertEquals("PUT", rec.method)
        assertEquals("/v1/devices/me", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
        assertEquals(JsonObject(mapOf("push_token" to JsonPrimitive("tok"))), bodyJson(rec))
    }

    @Test
    fun `updateDevice clears the push token with an explicit null, and Keep omits it`() = runBlocking {
        server.enqueue(json("""{"device":{"id":"dev_01"}}"""))
        server.enqueue(json("""{"device":{"id":"dev_01"}}"""))
        client().updateDevice(DeviceUpdate(PushTokenUpdate.Clear))
        assertEquals(JsonObject(mapOf("push_token" to JsonNull)), bodyJson(server.takeRequest()))
        client().updateDevice(DeviceUpdate(deviceName = "新しい名前"))
        assertEquals(JsonObject(mapOf("device_name" to JsonPrimitive("新しい名前"))), bodyJson(server.takeRequest()))
    }

    @Test
    fun `deleteDevice accepts 204 with an empty body`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        client().deleteDevice()
        val rec = server.takeRequest()
        assertEquals("DELETE", rec.method)
        assertEquals("/v1/devices/me", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
    }

    @Test
    fun `listRequests without filters has no query, and the token is never in the url`() = runBlocking {
        server.enqueue(json("""{"requests":[${Fixtures.text("request_pending.json")},${Fixtures.text("request_notification.json")}]}"""))
        val list = client().listRequests()
        assertEquals(listOf("req_01JCXYZ", "req_01JCNTF"), list.map { it.id })
        val rec = server.takeRequest()
        assertEquals("GET", rec.method)
        assertEquals("/v1/requests", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
        assertFalse(rec.requestUrl.toString().contains(token))
    }

    @Test
    fun `listRequests with status and limit`() = runBlocking {
        server.enqueue(json("""{"requests":[]}"""))
        assertEquals(emptyList<Request>(), client().listRequests(RequestStatus.PENDING, 50))
        val url = server.takeRequest().requestUrl!!
        assertEquals("/v1/requests", url.encodedPath)
        assertEquals("pending", url.queryParameter("status"))
        assertEquals("50", url.queryParameter("limit"))
    }

    @Test
    fun `listRequests tolerates a missing or null requests array`() = runBlocking {
        server.enqueue(json("""{}"""))
        server.enqueue(json("""{"requests":null}"""))
        assertEquals(emptyList<Request>(), client().listRequests())
        assertEquals(emptyList<Request>(), client().listRequests())
    }

    @Test
    fun `getRequest escapes the opaque id as a single path segment`() = runBlocking {
        server.enqueue(json(requestEnvelope("request_answered.json")))
        server.enqueue(json(requestEnvelope("request_answered.json")))
        assertEquals(RequestStatus.ANSWERED, client().getRequest("req_01JCXYZ").status)
        assertEquals("/v1/requests/req_01JCXYZ", server.takeRequest().path)
        client().getRequest("a/b?c d")
        assertEquals("/v1/requests/a%2Fb%3Fc%20d", server.takeRequest().path)
    }

    @Test
    fun `answer posts the body from the fixture`() = runBlocking {
        server.enqueue(json(requestEnvelope("request_answered.json")))
        val r = client().answer("req_01JCXYZ", AnswerBody("はい", 0, InputMethod.CHOICE))
        assertEquals(RequestStatus.ANSWERED, r.status)
        assertEquals("はい", r.answer?.text)
        val rec = server.takeRequest()
        assertEquals("POST", rec.method)
        assertEquals("/v1/requests/req_01JCXYZ/answer", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
        assertEquals(Fixtures.json("answer_request.json"), bodyJson(rec))
    }

    // ---- ベースURL ----

    @Test
    fun `base url with and without trailing slash, and with a path prefix`() = runBlocking {
        val root = baseUrl()
        for ((base, expectedPath) in listOf(
            root to "/v1/requests/r1",
            "$root/" to "/v1/requests/r1",
            "$root/prefix" to "/prefix/v1/requests/r1",
            "$root/prefix/" to "/prefix/v1/requests/r1",
            "  $root/  " to "/v1/requests/r1",
        )) {
            server.enqueue(json(requestEnvelope("request_pending.json")))
            client(base).getRequest("r1")
            assertEquals(base, expectedPath, server.takeRequest().path)
        }
    }

    @Test
    fun `invalid base url is a typed error and sends nothing`() = runBlocking {
        for (bad in listOf("", "not a url", "ftp://example.com", "oyobidashi://pair")) {
            val e = expect<RelayException.InvalidBaseUrl> { client(bad).getRequest("r1") }
            assertEquals(bad, e.baseUrl)
        }
        assertEquals(0, server.requestCount)
    }

    // ---- エラー: ステータスとコード ----

    @Test
    fun `contract error codes are mapped`() = runBlocking {
        val cases = listOf(
            400 to "invalid_request" to ErrorCode.INVALID_REQUEST,
            401 to "unauthorized" to ErrorCode.UNAUTHORIZED,
            401 to "pairing_code_invalid" to ErrorCode.PAIRING_CODE_INVALID,
            403 to "forbidden" to ErrorCode.FORBIDDEN,
            404 to "not_found" to ErrorCode.NOT_FOUND,
            409 to "already_resolved" to ErrorCode.ALREADY_RESOLVED,
            413 to "payload_too_large" to ErrorCode.PAYLOAD_TOO_LARGE,
            429 to "rate_limited" to ErrorCode.RATE_LIMITED,
            500 to "internal" to ErrorCode.INTERNAL,
        )
        for ((statusAndWire, expected) in cases) {
            val (status, wire) = statusAndWire
            server.enqueue(json("""{"error":{"code":"$wire","message":"m-$wire"}}""", status))
            val e = expect<RelayException.Api> { client().answer("r1", AnswerBody("x", null, InputMethod.TEXT)) }
            assertEquals(wire, status, e.httpStatus)
            assertEquals(wire, expected, e.code)
            assertEquals(wire, e.rawCode)
            assertEquals("m-$wire", e.serverMessage)
        }
    }

    @Test
    fun `401 unauthorized vs pairing_code_invalid are distinguished`() = runBlocking {
        server.enqueue(json(Fixtures.text("error_unauthorized.json"), 401))
        val unauthorized = expect<RelayException.Api> { client().listRequests() }
        assertTrue(unauthorized.isUnauthorized)

        server.enqueue(json("""{"error":{"code":"pairing_code_invalid","message":"expired"}}""", 401))
        val pairing = expect<RelayException.Api> { client(deviceToken = null).pair(PairRequest("bad", "Pixel", "android")) }
        assertEquals(ErrorCode.PAIRING_CODE_INVALID, pairing.code)
        assertFalse(pairing.isUnauthorized)
    }

    @Test
    fun `409 fixture maps to already_resolved`() = runBlocking {
        server.enqueue(json(Fixtures.text("error_already_resolved.json"), 409))
        val e = expect<RelayException.Api> { client().answer("r1", AnswerBody("x", null, InputMethod.TEXT)) }
        assertTrue(e.isAlreadyResolved)
        assertEquals("request is already answered", e.serverMessage)
    }

    @Test
    fun `html and empty error bodies fall back to the http status`() = runBlocking {
        val html = "<!DOCTYPE html><html><body>Tunnel not found</body></html>"
        val cases = listOf(
            400 to ErrorCode.INVALID_REQUEST, 401 to ErrorCode.UNAUTHORIZED, 403 to ErrorCode.FORBIDDEN,
            404 to ErrorCode.NOT_FOUND, 409 to ErrorCode.ALREADY_RESOLVED, 413 to ErrorCode.PAYLOAD_TOO_LARGE,
            429 to ErrorCode.RATE_LIMITED, 500 to ErrorCode.INTERNAL, 502 to ErrorCode.INTERNAL, 503 to ErrorCode.INTERNAL,
            418 to ErrorCode.UNKNOWN,
        )
        for ((status, expected) in cases) {
            for (body in listOf(html, "", "null", "[]", "\"oops\"", """{"error":"string"}""", """{"error":null}""", """{"message":"x"}""")) {
                server.enqueue(MockResponse().setResponseCode(status).setHeader("Content-Type", "text/html").setBody(body))
                val e = expect<RelayException.Api> { client().getRequest("r1") }
                assertEquals("$status / $body", expected, e.code)
                assertEquals(status, e.httpStatus)
                assertNull(e.rawCode)
            }
        }
    }

    @Test
    fun `unknown error code falls back to the http status but keeps the raw code`() = runBlocking {
        server.enqueue(json("""{"error":{"code":"quota_exceeded","message":"m"}}""", 429))
        val e = expect<RelayException.Api> { client().getRequest("r1") }
        assertEquals(ErrorCode.RATE_LIMITED, e.code)
        assertEquals("quota_exceeded", e.rawCode)
    }

    @Test
    fun `redirects that are not followed and other non-2xx are api errors`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(304))
        val e = expect<RelayException.Api> { client().getRequest("r1") }
        assertEquals(ErrorCode.UNKNOWN, e.code)
    }

    // ---- 2xx だが壊れたボディ ----

    @Test
    fun `2xx with html, empty, or wrong-shaped body is a protocol error`() = runBlocking {
        for (body in listOf("<html>ngrok</html>", "", "{}", """{"request":null}""", """{"request":{"status":"pending"}}""", "[]")) {
            server.enqueue(MockResponse().setResponseCode(200).setBody(body))
            expect<RelayException.Protocol> { client().getRequest("r1") }
        }
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"device":{"id":"d"}}""")) // device_token なし
        expect<RelayException.Protocol> { client().pair(PairRequest("c", "n", "android")) }
        Unit
    }

    // ---- 通信失敗 ----

    @Test
    fun `connection refused is a network error`() = runBlocking {
        val base = baseUrl()
        server.shutdown()
        val e = expect<RelayException.Network> { client(base).listRequests() }
        assertFalse(e.isTimeout)
    }

    @Test
    fun `read timeout is a network error flagged as timeout`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val e = expect<RelayException.Network> { client().answer("r1", AnswerBody("x", null, InputMethod.TEXT)) }
        assertTrue(e.isTimeout)
    }

    @Test
    fun `connection dropped mid-response is a network error`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"request":""").setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        expect<RelayException.Network> { client().getRequest("r1") }
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        expect<RelayException.Network> { client().getRequest("r1") }
        Unit
    }

    @Test
    fun `unknown host is a network error`() = runBlocking {
        val e = expect<RelayException.Network> { client("http://oyobidashi-does-not-exist.invalid").listRequests() }
        assertFalse(e.isTimeout)
    }
}
