package me.oyobidashi.android.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit

class BillingTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build()
    private val token = "kd_test_token"

    // MockWebServer は RelayClient のテストだけが使う (fake のテストはソケット不要)
    private fun startServer() { server = MockWebServer().also { it.start() } }

    @After fun tearDown() { if (::server.isInitialized) runCatching { server.shutdown() } }

    private fun baseUrl() = server.url("/").toString().trimEnd('/')
    private fun officialClient(baseUrl: String = "https://api.oyobidashi.me"): RelayClient {
        val routedHttp = http.newBuilder().addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(request.newBuilder().url(server.url(request.url.encodedPath)).build())
        }.build()
        return RelayClient(routedHttp, baseUrl, token)
    }
    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json; charset=utf-8").setBody(body)

    private class FakeBillingApi(
        var status: BillingStatus,
        var syncedStatus: BillingStatus = status,
    ) : BillingApi {
        var statusCalls = 0
        var challengeCalls = 0
        val syncCalls = mutableListOf<Pair<String, String>>()

        override suspend fun billingStatus(): BillingStatus {
            statusCalls++
            return status
        }

        override suspend fun billingChallenge(): BillingChallenge {
            challengeCalls++
            return BillingChallenge("challenge-1", "2026-11-15T14:05:00.000Z")
        }

        override suspend fun syncGoogle(integrityToken: String, payload: String): BillingStatus {
            syncCalls += integrityToken to payload
            return syncedStatus
        }
    }

    private class FakeIntegrity(
        var tokenValue: String = "integrity-token",
        var failure: Throwable? = null,
    ) : IntegrityTokens {
        val hashes = mutableListOf<String>()

        override suspend fun token(requestHash: String): String {
            hashes += requestHash
            failure?.let { throw it }
            return tokenValue
        }
    }

    private fun enabledStatus(active: Boolean = false) = BillingStatus(
        enabled = true,
        active = active,
        google = BillingProducts(listOf("plan_monthly")),
    )

    private fun payloadJson(payload: String): JsonObject =
        OyobidashiJson.parseToJsonElement(payload) as JsonObject

    @Test
    fun `happy path syncs purchases and returns the server status`() = runBlocking {
        val api = FakeBillingApi(
            status = enabledStatus(),
            syncedStatus = enabledStatus(active = true).copy(expiresAt = "2026-12-15T14:00:00.000Z"),
        )
        val integrity = FakeIntegrity()
        val result = BillingSync(api, integrity).sync(
            listOf(PurchaseRef("plan_monthly", "token-1"), PurchaseRef("plan_monthly", "token-2"))
        )
        assertTrue(result.active)
        assertEquals("2026-12-15T14:00:00.000Z", result.expiresAt)
        assertEquals(1, api.statusCalls)
        assertEquals(1, api.challengeCalls)
        assertEquals(1, api.syncCalls.size)
        assertEquals("integrity-token", api.syncCalls.single().first)
        val payload = payloadJson(api.syncCalls.single().second)
        assertEquals(JsonPrimitive("challenge-1"), payload["challenge"])
        val purchases = payload["purchases"] as JsonArray
        assertEquals(2, purchases.size)
        assertEquals(
            JsonObject(mapOf("product_id" to JsonPrimitive("plan_monthly"), "purchase_token" to JsonPrimitive("token-1"))),
            purchases[0],
        )
        assertEquals(
            JsonObject(mapOf("product_id" to JsonPrimitive("plan_monthly"), "purchase_token" to JsonPrimitive("token-2"))),
            purchases[1],
        )
    }

    @Test
    fun `disabled server makes no further calls`() = runBlocking {
        val api = FakeBillingApi(status = BillingStatus.DISABLED)
        val integrity = FakeIntegrity()
        val result = BillingSync(api, integrity).sync(listOf(PurchaseRef("plan_monthly", "token-1")))
        assertFalse(result.enabled)
        assertEquals(1, api.statusCalls)
        assertEquals(0, api.challengeCalls)
        assertTrue(api.syncCalls.isEmpty())
        assertTrue(integrity.hashes.isEmpty())
    }

    @Test
    fun `the hashed string equals the string sent`() = runBlocking {
        val api = FakeBillingApi(status = enabledStatus())
        val integrity = FakeIntegrity()
        BillingSync(api, integrity).sync(listOf(PurchaseRef("plan_monthly", "token-1")))
        val sentPayload = api.syncCalls.single().second
        val expectedHash = Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(sentPayload.toByteArray(Charsets.UTF_8))
        )
        assertEquals(listOf(expectedHash), integrity.hashes)
        assertFalse(integrity.hashes.single().contains("="))
    }

    @Test
    fun `purchases are capped at 20`() = runBlocking {
        val api = FakeBillingApi(status = enabledStatus())
        val integrity = FakeIntegrity()
        val purchases = (1..25).map { PurchaseRef("plan_monthly", "token-$it") }
        BillingSync(api, integrity).sync(purchases)
        val sent = payloadJson(api.syncCalls.single().second)["purchases"] as JsonArray
        assertEquals(20, sent.size)
        assertEquals("token-1", (sent.first() as JsonObject)["purchase_token"]?.jsonPrimitive?.content)
        assertEquals("token-20", (sent.last() as JsonObject)["purchase_token"]?.jsonPrimitive?.content)
    }

    @Test
    fun `an integrity failure surfaces as an error without calling syncGoogle`() = runBlocking {
        val api = FakeBillingApi(status = enabledStatus())
        val failure = IllegalStateException("integrity unavailable")
        val integrity = FakeIntegrity(failure = failure)
        try {
            BillingSync(api, integrity).sync(listOf(PurchaseRef("plan_monthly", "token-1")))
            fail("expected the integrity failure to surface")
        } catch (e: IllegalStateException) {
            assertEquals(failure, e)
        }
        assertEquals(1, api.challengeCalls)
        assertTrue(api.syncCalls.isEmpty())
    }

    @Test
    fun `billingStatus maps 404 to disabled instead of an error`() = runBlocking {
        startServer()
        server.enqueue(json("""{"error":{"code":"not_found","message":"not found"}}""", 404))
        val status = officialClient().billingStatus()
        assertFalse(status.enabled)
        assertFalse(status.active)
        assertEquals(BillingStatus.DISABLED, status)
        val rec = server.takeRequest()
        assertEquals("GET", rec.method)
        assertEquals("/v1/billing", rec.path)
        assertEquals("Bearer $token", rec.getHeader("Authorization"))
    }

    @Test
    fun `billingChallenge and syncGoogle send the contract bodies`() = runBlocking {
        startServer()
        val client = officialClient()
        server.enqueue(json("""{"challenge":"abc123","expires_at":"2026-11-15T14:05:00.000Z"}"""))
        val challenge = client.billingChallenge()
        assertEquals("abc123", challenge.challenge)
        val challengeReq = server.takeRequest()
        assertEquals("POST", challengeReq.method)
        assertEquals("/v1/billing/challenge", challengeReq.path)
        assertEquals("Bearer $token", challengeReq.getHeader("Authorization"))
        assertEquals(JsonObject(emptyMap()), OyobidashiJson.parseToJsonElement(challengeReq.body.readUtf8()))

        val payload = """{"challenge":"abc123","purchases":[{"product_id":"plan_monthly","purchase_token":"token-1"}]}"""
        server.enqueue(json("""{"enabled":true,"active":true,"expires_at":"2026-12-15T14:00:00.000Z","google":{"product_ids":["plan_monthly"]}}"""))
        val status = client.syncGoogle("integrity-token", payload)
        assertTrue(status.active)
        assertEquals(listOf("plan_monthly"), status.google?.productIds)
        val syncReq = server.takeRequest()
        assertEquals("POST", syncReq.method)
        assertEquals("/v1/billing/google", syncReq.path)
        val body = OyobidashiJson.parseToJsonElement(syncReq.body.readUtf8()) as JsonObject
        assertEquals(JsonPrimitive("integrity-token"), body["integrity_token"])
        // payload は文字列としてそのまま送られる (再直列化で形が変わらない)
        assertEquals(JsonPrimitive(payload), body["payload"])
    }

    @Test
    fun `billingStatus parses the enabled response`() = runBlocking {
        startServer()
        server.enqueue(json("""{"enabled":true,"active":false,"purchase_account_id":"98765432-1234-5678-9abc-123456789abc","expires_at":null,"google":{"product_ids":["plan_monthly"]},"voice_training":{"free":true,"plus":false}}"""))
        val status = officialClient().billingStatus()
        assertTrue(status.enabled)
        assertFalse(status.active)
        assertEquals("98765432-1234-5678-9abc-123456789abc", status.purchaseAccountId)
        assertEquals(null, status.expiresAt)
        assertEquals(listOf("plan_monthly"), status.google?.productIds)
        assertEquals(null, status.apple)
        assertEquals(BillingVoiceTraining(free = true, plus = false), status.voiceTraining)
    }

    @Test
    fun `non-official origins cannot start or sync billing`() = runBlocking {
        startServer()
        server.enqueue(json("""{"enabled":true}"""))
        for (url in listOf(
            baseUrl(),
            "https://oyobidashi.up.railway.app",
            "https://api.oyobidashi.me.example",
            "http://api.oyobidashi.me",
            "https://api.oyobidashi.me:8443",
            "https://api.oyobidashi.me/custom",
        )) {
            val client = officialClient(url)
            assertEquals(url, BillingStatus.DISABLED, client.billingStatus())
            assertTrue(url, runCatching { client.billingChallenge() }.exceptionOrNull() is RelayException.Protocol)
            assertTrue(url, runCatching { client.syncGoogle("fixture", "{}") }.exceptionOrNull() is RelayException.Protocol)
        }
        assertEquals(0, server.requestCount)
        assertTrue(officialClient("https://API.OYOBIDASHI.ME:443/").isOfficialCloud)
    }

    @Test
    fun `billing does not follow redirects with a purchase payload`() = runBlocking {
        startServer()
        server.enqueue(json("{}", 307).setHeader("Location", server.url("/redirected")))
        server.enqueue(json("""{"enabled":true,"active":true}"""))
        val error = runCatching { officialClient().syncGoogle("fixture", "{}") }.exceptionOrNull()
        assertEquals(307, (error as? RelayException.Api)?.httpStatus)
        assertEquals(1, server.requestCount)
    }
}
