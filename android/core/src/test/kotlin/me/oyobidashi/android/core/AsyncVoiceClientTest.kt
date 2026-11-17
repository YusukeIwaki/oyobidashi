package me.oyobidashi.android.core

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class AsyncVoiceClientTest {
    private lateinit var server: MockWebServer
    private val turnId = "123e4567-e89b-12d3-a456-426614174000"
    private val requestId = "req_01JCXYZ"
    private val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build()
    private fun client() = RelayClient(http, server.url("/prefix/").toString(), "kd_test", VoiceTurnOptions(
        firstPollMs = 1, maxPollMs = 2, newId = { turnId },
    ))

    @Before fun setup() { server = MockWebServer().also { it.start() } }
    @After fun teardown() { server.shutdown() }

    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status)
        .setHeader("Content-Type", "application/json").setBody(body)

    private fun response(state: String = "queued", resolved: Boolean = false): String {
        val turn = CallTurn(turnId, state, if (state == "completed") "承知しました" else null, resolved)
        val call = ringingCall(requestId = requestId).copy(
            state = if (resolved) CallState.ENDED else CallState.ACTIVE,
            outcome = if (resolved) CallOutcome.RESOLVED else null, turn = turn,
        )
        val request = request(requestId, if (resolved) RequestStatus.ANSWERED else RequestStatus.PENDING, call = call)
        return OyobidashiJson.encodeToString(CallResponse.serializer(), CallResponse(request, call, turn = turn))
    }

    @Test fun `202 async turn uses authenticated result URL and returns spoken final reply`() = runBlocking {
        server.enqueue(json(response(), 202))
        server.enqueue(json(response("running")))
        server.enqueue(json(response("completed", true)))
        val result = client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
        assertTrue(result.isResolved)
        assertEquals("承知しました", result.reply)
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/prefix/v1/requests/$requestId/call", post.path)
        assertEquals("Bearer kd_test", post.getHeader("Authorization"))
        assertEquals(
            OyobidashiJson.parseToJsonElement("""{"event":"turn","text":"はい","turn_id":"$turnId","async":true}"""),
            OyobidashiJson.parseToJsonElement(post.body.readUtf8()),
        )
        repeat(2) {
            val get = server.takeRequest()
            assertEquals("GET", get.method)
            assertEquals("/prefix/v1/requests/$requestId/turns/$turnId", get.path)
            assertEquals("Bearer kd_test", get.getHeader("Authorization"))
        }
    }

    @Test fun `connection forcibly closed after POST is recovered with GET without duplicate POST`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(json(response("completed", true)))
        val result = client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
        assertTrue(result.isResolved)
        assertEquals("POST", server.takeRequest().method)
        assertEquals("GET", server.takeRequest().method)
        assertEquals(2, server.requestCount)
    }

    @Test fun `503 before commit checks capabilities and retries identical body on prefix base URL`() = runBlocking {
        server.enqueue(json("""{"error":{"code":"unavailable"}}""", 503))
        server.enqueue(json("""{"error":{"code":"not_found"}}""", 404))
        server.enqueue(json("""{"capabilities":{"async_turns":true,"turn_idempotency":true}}"""))
        server.enqueue(json(response("completed", true)))
        assertTrue(client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい")).isResolved)
        val post = server.takeRequest()
        val get = server.takeRequest()
        val health = server.takeRequest()
        val retried = server.takeRequest()
        assertEquals(post.body.readUtf8(), retried.body.readUtf8())
        assertEquals("GET", get.method)
        assertEquals("/prefix/healthz", health.path)
        assertNull(health.getHeader("Authorization"))
        assertEquals("POST", retried.method)
    }

    @Test fun `legacy health response cannot authorize an unsafe POST retry`() = runBlocking {
        server.enqueue(json("""{"error":{"code":"unavailable"}}""", 503))
        server.enqueue(json("""{"error":{"code":"not_found"}}""", 404))
        server.enqueue(json("""{"ok":true,"version":"0.2.0"}"""))
        try {
            client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
            fail("must preserve uncertain result")
        } catch (failure: RelayException.Api) {
            assertEquals(503, failure.httpStatus)
        }
        assertEquals(3, server.requestCount)
    }

    @Test fun `result endpoint 401 surfaces unpair and never repeats utterance`() = runBlocking {
        server.enqueue(json(response(), 202))
        server.enqueue(json("""{"error":{"code":"unauthorized"}}""", 401))
        try {
            client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
            fail("must sign out")
        } catch (failure: RelayException) {
            assertTrue(failure.isUnauthorized)
        }
        assertEquals(2, server.requestCount)
    }

    @Test fun `voice state conflicts are distinct from already resolved`() = runBlocking {
        for (code in listOf("turn_in_progress", "idempotency_conflict", "call_ended", "call_claimed", "future_conflict")) {
            server.enqueue(json("""{"error":{"code":"$code"}}""", 409))
            try {
                client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
                fail("must surface conflict")
            } catch (failure: RelayException) {
                assertFalse("$code is not a human answer", failure.isAlreadyResolved)
            }
        }
    }

    @Test fun `redirect cannot move an authenticated voice POST to another destination`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/elsewhere")))
        try {
            client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
            fail("redirect must be rejected")
        } catch (failure: RelayException.Api) {
            assertEquals(307, failure.httpStatus)
        }
        assertEquals(1, server.requestCount)
    }

    @Test fun `reconnect polls existing turn without submitting it`() = runBlocking {
        server.enqueue(json(response("completed", true)))
        val result = client().awaitCallTurn(requestId, turnId)
        assertTrue(result.isResolved)
        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/prefix/v1/requests/$requestId/turns/$turnId", recorded.path)
    }

    @Test fun `truncated JSON after acceptance recovers durable result without repeating POST`() = runBlocking {
        server.enqueue(json("""{"request":{"id":"$requestId"},"turn":{"id":"$turnId","state":"que""", 202))
        server.enqueue(json(response("completed", true)))
        val result = client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
        assertTrue(result.isResolved)
        assertEquals("POST", server.takeRequest().method)
        assertEquals("GET", server.takeRequest().method)
        assertEquals(2, server.requestCount)
    }

    @Test fun `well formed JSON with invalid contract is rejected without pretending a transport retry`() = runBlocking {
        server.enqueue(json("""{"request":{"id":"$requestId"},"turn":{"id":"$turnId","state":"unexpected","resolved":false}}""", 202))
        try {
            client().postCall(requestId, CallEventBody(CallEvent.TURN, "はい"))
            fail("must reject unknown state")
        } catch (_: RelayException.Protocol) { }
        assertEquals(1, server.requestCount)
    }
}
