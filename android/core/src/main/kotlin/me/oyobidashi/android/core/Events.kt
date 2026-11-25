package me.oyobidashi.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

@Serializable
data class HomeNotice(val type: String, val providers: Map<String, String> = emptyMap()) {
    val requiresVoicePlanConsent: Boolean get() = type == "voice_plan_consent_required"
}

/** `/v1/events` のサーバー→クライアントイベント。 */
sealed interface RelayEvent {
    data class Hello(val pending: List<Request>, val homeNotice: HomeNotice? = null) : RelayEvent
    data class HomeNoticeUpdated(val notice: HomeNotice?) : RelayEvent
    data class RequestCreated(val request: Request) : RelayEvent
    data class RequestUpdated(val request: Request) : RelayEvent
    data object Pong : RelayEvent

    companion object {
        const val PING_FRAME = """{"type":"ping"}"""

        /** 未知の type・壊れたJSON・必須フィールド欠落は null (無視する)。 */
        fun parse(text: String): RelayEvent? = try {
            val obj = OyobidashiJson.parseToJsonElement(text) as? JsonObject
            when ((obj?.get("type") as? JsonPrimitive)?.takeIf { it.isString }?.content) {
                "hello" -> {
                    val pending = obj["pending"]
                    Hello(
                        if (pending == null || pending is JsonNull) emptyList()
                        else OyobidashiJson.decodeFromJsonElement<List<Request>>(pending),
                        try { decodeNotice(obj["home_notice"]) } catch (_: SerializationException) { null }
                    )
                }
                "home_notice.updated" -> HomeNoticeUpdated(decodeNotice(obj["notice"]))
                "request.created" -> obj["request"]?.let { RequestCreated(OyobidashiJson.decodeFromJsonElement<Request>(it)) }
                "request.updated" -> obj["request"]?.let { RequestUpdated(OyobidashiJson.decodeFromJsonElement<Request>(it)) }
                "pong" -> Pong
                else -> null
            }
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }

        private fun decodeNotice(value: JsonElement?): HomeNotice? =
            value?.takeUnless { it is JsonNull }?.let { OyobidashiJson.decodeFromJsonElement<HomeNotice>(it) }
    }
}

// ---- ソケット抽象 (再接続ロジックを OkHttp なしでテストするため) ----

interface EventSocket {
    fun send(text: String): Boolean
    fun cancel()
}

interface EventSocketListener {
    fun onOpen()
    fun onText(text: String)

    /** 切断または接続失敗。upgrade が HTTP エラーで拒否された場合は [httpStatus] にそのコード。1接続につき1回以上呼ばれうる。 */
    fun onClosed(httpStatus: Int?, cause: Throwable?)
}

fun interface EventSocketConnector {
    fun connect(listener: EventSocketListener): EventSocket
}

/** OkHttp で `GET <base>/v1/events` に Authorization ヘッダー付きで接続する。 */
class OkHttpEventSocketConnector(
    private val http: OkHttpClient,
    private val baseUrl: String,
    private val deviceToken: String,
) : EventSocketConnector {
    override fun connect(listener: EventSocketListener): EventSocket {
        val request = okhttp3.Request.Builder()
            .url(eventsUrl(baseUrl)) // OkHttp は ws:// / wss:// を受け付ける
            .header("Authorization", "Bearer $deviceToken")
            .build()
        val ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onText(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                listener.onClosed(null, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(null, null)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                listener.onClosed(response?.code, t)
        })
        return object : EventSocket {
            override fun send(text: String): Boolean = ws.send(text)
            override fun cancel() = ws.cancel()
        }
    }
}

/** ベースURLのスキームから WebSocket URL を導く: `http://…` → `ws://…/v1/events`、`https://…` → `wss://…/v1/events`。 */
fun eventsUrl(baseUrl: String): String {
    val http = RelayClient.buildUrl(baseUrl, "events")
    val scheme = if (http.isHttps) "wss" else "ws"
    return scheme + http.toString().substring(http.scheme.length)
}

// ---- 再接続つきクライアント ----

fun interface Backoff {
    /** [attempt] 回目 (0 始まり) の再接続までの待ち時間 (ms)。 */
    fun delayMillis(attempt: Int): Long
}

/** 1s, 2s, 4s, … 最大 30s。 */
class ExponentialBackoff(
    private val baseMillis: Long = 1_000,
    private val maxMillis: Long = 30_000,
) : Backoff {
    override fun delayMillis(attempt: Int): Long {
        val shift = attempt.coerceIn(0, 30)
        return (baseMillis shl shift).coerceIn(baseMillis, maxMillis)
    }
}

enum class ConnectionState { STOPPED, CONNECTING, CONNECTED, WAITING_TO_RECONNECT, UNAUTHORIZED }

interface EventsListener {
    fun onEvent(event: RelayEvent)
    fun onStateChanged(state: ConnectionState) {}

    /** upgrade が 401 で拒否された。以後は再接続しない。 */
    fun onUnauthorized() {}
}

/**
 * `/v1/events` に繋ぎ続けるクライアント。
 *
 * - 切断・接続失敗時は [backoff] に従って再接続する (待ちは [scope] のディスパッチャ上の `delay` なので仮想時間でテスト可能)。
 * - 接続が開いたら再接続カウンタをリセットし、[pingIntervalMillis] ごとに `{"type":"ping"}` を送る。
 * - upgrade が 401 なら [EventsListener.onUnauthorized] を呼んで停止する。
 * - [stop] 後は再接続しない。リスナーは [scope] 上で呼ばれる。
 */
class EventsClient(
    private val connector: EventSocketConnector,
    private val scope: CoroutineScope,
    private val listener: EventsListener,
    private val backoff: Backoff = ExponentialBackoff(),
    private val pingIntervalMillis: Long = 30_000,
) {
    private sealed interface Signal {
        data object Open : Signal
        data class Text(val text: String) : Signal
        data class Closed(val httpStatus: Int?) : Signal
    }

    private val lock = Any()
    private var job: Job? = null

    @Volatile
    var state: ConnectionState = ConnectionState.STOPPED
        private set

    val isRunning: Boolean get() = synchronized(lock) { job?.isActive == true }

    fun start() {
        synchronized(lock) {
            if (job?.isActive == true) return
            job = scope.launch { run() }
        }
    }

    /** 接続が戻った/フォアグラウンド復帰時: バックオフ待ちを打ち切ってすぐ繋ぎ直す。接続済みなら何もしない。 */
    fun reconnectNow() {
        if (state == ConnectionState.CONNECTED) return
        val wasRunning = synchronized(lock) { job.also { job = null } }
        wasRunning?.cancel()
        start()
    }

    fun stop() {
        val toCancel = synchronized(lock) { job.also { job = null } }
        toCancel?.cancel()
        setState(ConnectionState.STOPPED, notify = toCancel != null)
    }

    private fun setState(newState: ConnectionState, notify: Boolean = true) {
        if (state == newState) return
        state = newState
        if (notify) listener.onStateChanged(newState)
    }

    private suspend fun run() {
        var attempt = 0
        while (scope.isActive) {
            val signals = Channel<Signal>(Channel.UNLIMITED)
            setState(ConnectionState.CONNECTING)
            val socket = connector.connect(object : EventSocketListener {
                override fun onOpen() { signals.trySend(Signal.Open) }
                override fun onText(text: String) { signals.trySend(Signal.Text(text)) }
                override fun onClosed(httpStatus: Int?, cause: Throwable?) { signals.trySend(Signal.Closed(httpStatus)) }
            })
            var pingJob: Job? = null
            try {
                for (signal in signals) {
                    when (signal) {
                        Signal.Open -> {
                            attempt = 0
                            setState(ConnectionState.CONNECTED)
                            pingJob?.cancel()
                            pingJob = scope.launch {
                                while (true) {
                                    delay(pingIntervalMillis)
                                    socket.send(RelayEvent.PING_FRAME)
                                }
                            }
                        }
                        is Signal.Text -> RelayEvent.parse(signal.text)?.let { listener.onEvent(it) }
                        is Signal.Closed -> {
                            if (signal.httpStatus == 401) {
                                synchronized(lock) { job = null }
                                setState(ConnectionState.UNAUTHORIZED)
                                listener.onUnauthorized()
                                return
                            }
                            break
                        }
                    }
                }
            } finally {
                pingJob?.cancel()
                socket.cancel()
                signals.close()
            }
            setState(ConnectionState.WAITING_TO_RECONNECT)
            delay(backoff.delayMillis(attempt++))
        }
    }
}
