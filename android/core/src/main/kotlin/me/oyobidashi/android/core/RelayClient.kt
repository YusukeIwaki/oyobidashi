package me.oyobidashi.android.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 認証済みデバイスが使う API。テストでは fake に差し替える。 */
interface RelayApi {
    suspend fun updateDevice(update: DeviceUpdate): Device
    suspend fun deleteDevice()
    suspend fun listRequests(status: RequestStatus? = null, limit: Int? = null): List<Request>
    suspend fun getRequest(id: String): Request
    suspend fun answer(id: String, body: AnswerBody): Request
    /** PUT /v1/presence。ボディの形は契約どおり。レスポンスボディは無視する。 */
    suspend fun updatePresence(update: PresenceUpdate)
    /** POST /v1/requests/{id}/call。 */
    suspend fun postCall(id: String, body: CallEventBody): CallResponse
    /** 再接続後も発話を再送せず、確定済みターンの結果を取得する。 */
    suspend fun awaitCallTurn(id: String, turnId: String): CallResponse =
        throw RelayException.Protocol("asynchronous voice turns are not available")
}

/**
 * relay の Device API クライアント。すべての失敗は [RelayException] として投げる。
 *
 * @param baseUrl 公開ベースURL (末尾スラッシュ有無・パスプレフィックス付きのどちらも可)
 * @param deviceToken ペアリング前 ([pair] のみ使う場合) は null
 */
class RelayClient(
    private val http: OkHttpClient,
    private val baseUrl: String,
    private val deviceToken: String? = null,
    private val voiceTurnOptions: VoiceTurnOptions = VoiceTurnOptions(),
    private val voiceTokenProvider: VoiceTokenProvider? = null,
) : RelayApi, BillingApi {
    private val safeHttp = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    val isOfficialCloud: Boolean = baseUrl.trim().toHttpUrlOrNull()?.let {
        it.isHttps && it.host == "api.oyobidashi.me" && it.port == 443 &&
            it.encodedPath == "/" && it.username.isEmpty() && it.password.isEmpty()
    } == true
    @Volatile private var idempotentTurns: Boolean? = null

    /** POST /v1/pair (認証不要) */
    suspend fun pair(body: PairRequest): PairResponse {
        val request = newRequest(url("pair"), authenticated = false)
            .post(jsonBody(OyobidashiJson.encodeToString(PairRequest.serializer(), body)))
            .build()
        return decode(PairResponse.serializer(), execute(request))
    }

    override suspend fun updateDevice(update: DeviceUpdate): Device {
        val json = buildJsonObject {
            when (val token = update.pushToken) {
                PushTokenUpdate.Keep -> Unit
                PushTokenUpdate.Clear -> put("push_token", JsonNull)
                is PushTokenUpdate.Set -> put("push_token", JsonPrimitive(token.token))
            }
            when (val voip = update.voipToken) {
                VoipTokenUpdate.Keep -> Unit
                VoipTokenUpdate.Clear -> put("voip_token", JsonNull)
                is VoipTokenUpdate.Set -> put("voip_token", JsonPrimitive(voip.token))
            }
            update.deviceName?.let { put("device_name", JsonPrimitive(it)) }
            update.pushClientId?.let { put("push_client_id", JsonPrimitive(it)) }
        }
        val request = newRequest(url("devices", "me")).put(jsonBody(json.toString())).build()
        return decode(DeviceEnvelope.serializer(), execute(request)).device
    }

    override suspend fun updatePresence(update: PresenceUpdate) {
        val json = buildJsonObject {
            put("availability", JsonPrimitive(update.availability.name.lowercase()))
            when (val until = update.until) {
                PresenceUntil.Keep -> Unit
                PresenceUntil.Clear -> put("until", JsonNull)
                is PresenceUntil.Set -> put("until", JsonPrimitive(until.iso8601))
            }
            when (val note = update.note) {
                PresenceNote.Keep -> Unit
                PresenceNote.Clear -> put("note", JsonNull)
                is PresenceNote.Set -> put("note", JsonPrimitive(note.note))
            }
        }
        execute(newRequest(url("presence")).put(jsonBody(json.toString())).build())
    }

    override suspend fun postCall(id: String, body: CallEventBody): CallResponse {
        if (body.event == CallEvent.TURN) {
            return VoiceTurnRunner(voiceTurnOptions).submit(
                id, body, post = { postCallExchange(id, it) }, get = { getTurnExchange(id, it) },
                supportsIdempotency = { supportsIdempotentTurns() },
            )
        }
        return postCallExchange(id, body).body
    }

    override suspend fun awaitCallTurn(id: String, turnId: String): CallResponse =
        VoiceTurnRunner(voiceTurnOptions).resume(id, turnId) { getTurnExchange(id, it) }

    private suspend fun postCallExchange(id: String, body: CallEventBody): CallExchange {
        val builder = newRequest(url("requests", id, "call"))
        if (body.event == CallEvent.ANSWER || body.event == CallEvent.TURN) {
            voiceTokenProvider?.token()?.let { builder.header("X-Oyobidashi-Voice-Token", it) }
        }
        val request = builder.post(jsonBody(OyobidashiJson.encodeToString(CallEventBody.serializer(), body))).build()
        val exchange = executeExchange(request)
        return decodeCallExchange(exchange.status, exchange.body)
    }

    private suspend fun getTurnExchange(id: String, turnId: String): CallExchange {
        val exchange = executeExchange(newRequest(url("requests", id, "turns", turnId)).get().build())
        if (exchange.status != 200) throw RelayException.Protocol("unexpected voice turn result status")
        return decodeCallExchange(exchange.status, exchange.body)
    }

    private fun decodeCallExchange(status: Int, body: String): CallExchange {
        try {
            OyobidashiJson.parseToJsonElement(body)
        } catch (_: SerializationException) {
            // Some proxies close a 202 response after headers. Recover the durable result
            // instead of submitting a new utterance or accepting incomplete JSON.
            throw RelayException.Network(false, IOException("incomplete voice response"))
        } catch (_: IllegalArgumentException) {
            throw RelayException.Network(false, IOException("incomplete voice response"))
        }
        return CallExchange(status, decode(CallResponse.serializer(), body))
    }

    private suspend fun supportsIdempotentTurns(): Boolean {
        idempotentTurns?.let { return it }
        val health = baseUrl.trim().toHttpUrlOrNull()?.newBuilder()?.query(null)?.fragment(null)
            ?.addPathSegment("healthz")?.build() ?: return false
        val supported = try {
            val body = OyobidashiJson.parseToJsonElement(execute(newRequest(health, authenticated = false).get().build())) as? JsonObject
            val capabilities = body?.get("capabilities") as? JsonObject
            (capabilities?.get("async_turns") as? JsonPrimitive)?.booleanOrNull == true &&
                (capabilities?.get("turn_idempotency") as? JsonPrimitive)?.booleanOrNull == true
        } catch (_: RelayException) { return false
        } catch (_: IllegalArgumentException) { return false }
        idempotentTurns = supported
        return supported
    }

    override suspend fun deleteDevice() {
        execute(newRequest(url("devices", "me")).delete().build())
    }

    suspend fun voiceStatus(): VoiceStatus? = try {
        decode(VoiceStatus.serializer(), execute(newRequest(url("voice")).get().build()))
    } catch (e: RelayException.Api) {
        if (e.httpStatus == 404) null else throw e
    }

    suspend fun voiceChallenge(purpose: String): VoiceChallenge =
        decode(VoiceChallenge.serializer(), execute(newRequest(url("voice", "challenge"))
            .post(jsonBody(OyobidashiJson.encodeToString(VoiceChallengeRequest.serializer(), VoiceChallengeRequest(purpose)))).build()))

    suspend fun voiceAndroidEnroll(challenge: String, publicKey: String, integrityToken: String) {
        execute(newRequest(url("voice", "android", "enroll"))
            .post(jsonBody(OyobidashiJson.encodeToString(VoiceAndroidEnroll.serializer(), VoiceAndroidEnroll(challenge, publicKey, integrityToken)))).build())
    }

    suspend fun voiceAccess(challenge: String, keyId: String, signature: String): VoiceAccess =
        decode(VoiceAccess.serializer(), execute(newRequest(url("voice", "token"))
            .post(jsonBody(OyobidashiJson.encodeToString(VoiceTokenRequest.serializer(), VoiceTokenRequest(challenge, keyId, signature)))).build()))

    /** 公式 API の GET /v1/billing。404 は課金無効として扱う。 */
    override suspend fun billingStatus(): BillingStatus {
        if (!isOfficialCloud) return BillingStatus.DISABLED
        return try {
            decode(BillingStatus.serializer(), execute(newRequest(url("billing")).get().build()))
        } catch (e: RelayException.Api) {
            if (e.httpStatus == 404) BillingStatus.DISABLED else throw e
        }
    }

    /** POST /v1/billing/challenge。ボディは空オブジェクト。 */
    override suspend fun billingChallenge(): BillingChallenge {
        if (!isOfficialCloud) throw RelayException.Protocol("Billing requires the official API")
        val request = newRequest(url("billing", "challenge")).post(jsonBody("{}")).build()
        return decode(BillingChallenge.serializer(), execute(request))
    }

    /** POST /v1/billing/google。[payload] はハッシュ済みの文字列をそのまま送る。 */
    override suspend fun syncGoogle(integrityToken: String, payload: String): BillingStatus {
        if (!isOfficialCloud) throw RelayException.Protocol("Billing requires the official API")
        val json = buildJsonObject {
            put("integrity_token", JsonPrimitive(integrityToken))
            put("payload", JsonPrimitive(payload))
        }
        val request = newRequest(url("billing", "google")).post(jsonBody(json.toString())).build()
        return decode(BillingStatus.serializer(), execute(request))
    }

    override suspend fun listRequests(status: RequestStatus?, limit: Int?): List<Request> {
        val url = url("requests").newBuilder().apply {
            if (status != null) addQueryParameter("status", status.wireName)
            if (limit != null) addQueryParameter("limit", limit.toString())
        }.build()
        val request = newRequest(url).header("X-Oyobidashi-Request-Items", "1").get().build()
        return decode(RequestsEnvelope.serializer(), execute(request)).requests
    }

    override suspend fun getRequest(id: String): Request =
        decode(RequestEnvelope.serializer(), execute(newRequest(url("requests", id)).get().build())).request

    override suspend fun answer(id: String, body: AnswerBody): Request {
        val request = newRequest(url("requests", id, "answer"))
            .post(jsonBody(OyobidashiJson.encodeToString(AnswerBody.serializer(), body)))
            .build()
        return decode(RequestEnvelope.serializer(), execute(request)).request
    }

    // ---- internals ----

    private fun url(vararg segments: String): HttpUrl = buildUrl(baseUrl, *segments)

    private fun newRequest(url: HttpUrl, authenticated: Boolean = true): okhttp3.Request.Builder {
        val builder = okhttp3.Request.Builder().url(url).header("Accept", "application/json")
        if (authenticated && deviceToken != null) builder.header("Authorization", "Bearer $deviceToken")
        return builder
    }

    private fun jsonBody(json: String): RequestBody {
        val delegate = json.toRequestBody(JSON_MEDIA_TYPE)
        return object : RequestBody() {
            override fun contentType() = delegate.contentType()
            override fun contentLength() = delegate.contentLength()
            override fun writeTo(sink: BufferedSink) = delegate.writeTo(sink)
            // Let OkHttp try alternative addresses before sending, but never replay a mutating
            // body after an uncertain disconnect. Voice retries are controlled by turn_id above.
            override fun isOneShot() = true
        }
    }

    private fun <T> decode(strategy: DeserializationStrategy<T>, body: String): T = try {
        OyobidashiJson.decodeFromString(strategy, body)
    } catch (e: SerializationException) {
        throw RelayException.Protocol("unexpected response body", e)
    } catch (e: IllegalArgumentException) {
        throw RelayException.Protocol("unexpected response body", e)
    }

    /** 2xx ならボディ文字列を返す。それ以外は [RelayException]。 */
    private data class HttpExchange(val status: Int, val body: String)

    private suspend fun execute(request: okhttp3.Request): String = executeExchange(request).body

    private suspend fun executeExchange(request: okhttp3.Request): HttpExchange = suspendCancellableCoroutine { cont ->
        val transport = if (request.url.pathSegments.lastOrNull() == "call") safeHttp.newBuilder().readTimeout(100, TimeUnit.SECONDS).callTimeout(100, TimeUnit.SECONDS).build() else safeHttp
        val call = transport.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e.toNetworkError())
            }

            override fun onResponse(call: Call, response: Response) {
                val result = try {
                    response.use {
                        val text = it.body?.string().orEmpty()
                        if (it.isSuccessful) Result.success(HttpExchange(it.code, text)) else Result.failure(apiError(it.code, text))
                    }
                } catch (e: IOException) {
                    Result.failure(e.toNetworkError())
                }
                if (!cont.isActive) return
                result.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }
        })
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /** `<base>/v1/<segments…>`。ベースURLの末尾スラッシュ・パスプレフィックスを保つ。ID はパスセグメントとしてエスケープされる。 */
        fun buildUrl(baseUrl: String, vararg segments: String): HttpUrl {
            val base = baseUrl.trim().toHttpUrlOrNull() ?: throw RelayException.InvalidBaseUrl(baseUrl)
            val builder = base.newBuilder().query(null).fragment(null).addPathSegment("v1")
            segments.forEach { builder.addPathSegment(it) }
            return builder.build()
        }

        internal fun apiError(status: Int, body: String): RelayException.Api {
            val error = try {
                OyobidashiJson.decodeFromString(ErrorEnvelope.serializer(), body).error
            } catch (e: SerializationException) {
                null
            } catch (e: IllegalArgumentException) {
                null
            }
            val code = ErrorCode.fromWire(error?.code) ?: ErrorCode.fromHttpStatus(status)
            return RelayException.Api(status, code, error?.code, error?.message)
        }

        internal fun IOException.toNetworkError(): RelayException.Network {
            val timeout = this is SocketTimeoutException ||
                (this is InterruptedIOException && message?.contains("timeout", ignoreCase = true) == true)
            return RelayException.Network(timeout, this)
        }
    }
}
