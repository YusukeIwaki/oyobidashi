package me.oyobidashi.android.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import java.time.Instant

/**
 * 契約 (docs/PROTOCOL.md) 用の Json 設定。
 *
 * - 未知フィールドは無視 (`ignoreUnknownKeys`)
 * - `null` とフィールド欠落は同義: デコード時は `coerceInputValues` で既定値に寄せ、
 *   エンコード時は `explicitNulls = false` で null を出力しない
 * - 未知の enum 値は各 enum の `UNKNOWN` にフォールバックする ([WireEnumSerializer])。クラッシュしない。
 */
val OyobidashiJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

/** 小文字の wire 名 <-> enum。未知の値は [fallback] になる。 */
open class WireEnumSerializer<E : Enum<E>>(
    serialName: String,
    private val values: Array<E>,
    private val fallback: E,
) : KSerializer<E> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: E) = encoder.encodeString(value.name.lowercase())

    override fun deserialize(decoder: Decoder): E {
        val wire = decoder.decodeString()
        return values.firstOrNull { it != fallback && it.name.lowercase() == wire } ?: fallback
    }
}

@Serializable(with = RequestKind.Serializer::class)
enum class RequestKind {
    QUESTION, NOTIFICATION, UNKNOWN;

    object Serializer : WireEnumSerializer<RequestKind>("RequestKind", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = Urgency.Serializer::class)
enum class Urgency {
    NORMAL, HIGH, UNKNOWN;

    object Serializer : WireEnumSerializer<Urgency>("Urgency", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = RequestStatus.Serializer::class)
enum class RequestStatus {
    PENDING, ANSWERED, CANCELLED, EXPIRED, NOTIFIED,

    /** 未知の status、または「解決済みだが詳細不明」。回答不可として扱う。 */
    UNKNOWN;

    val wireName: String get() = name.lowercase()

    object Serializer : WireEnumSerializer<RequestStatus>("RequestStatus", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = InputMethod.Serializer::class)
enum class InputMethod {
    TEXT, VOICE, CHOICE, UNKNOWN;

    object Serializer : WireEnumSerializer<InputMethod>("InputMethod", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = Priority.Serializer::class)
enum class Priority {
    LOW, NORMAL, HIGH, URGENT, UNKNOWN;

    object Serializer : WireEnumSerializer<Priority>("Priority", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = DeliveryMode.Serializer::class)
enum class DeliveryMode {
    ACTIONS, TEXT, CALL, UNKNOWN;

    object Serializer : WireEnumSerializer<DeliveryMode>("DeliveryMode", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = RequestedMode.Serializer::class)
enum class RequestedMode {
    AUTO, ACTIONS, TEXT, CALL, UNKNOWN;

    object Serializer : WireEnumSerializer<RequestedMode>("RequestedMode", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = CallState.Serializer::class)
enum class CallState {
    RINGING, ACTIVE, ENDED, UNKNOWN;

    object Serializer : WireEnumSerializer<CallState>("CallState", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = CallOutcome.Serializer::class)
enum class CallOutcome {
    RESOLVED, DECLINED, HANGUP, MISSED, CANCELLED, EXPIRED, FAILED, UNKNOWN;

    object Serializer : WireEnumSerializer<CallOutcome>("CallOutcome", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = CallRole.Serializer::class)
enum class CallRole {
    USER, ASSISTANT, UNKNOWN;

    object Serializer : WireEnumSerializer<CallRole>("CallRole", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = CallEvent.Serializer::class)
enum class CallEvent {
    ANSWER, DECLINE, HANGUP, TURN, FAILED, UNKNOWN;

    object Serializer : WireEnumSerializer<CallEvent>("CallEvent", entries.toTypedArray(), UNKNOWN)
}

@Serializable(with = Availability.Serializer::class)
enum class Availability {
    AVAILABLE, BUSY, AWAY, UNKNOWN;

    object Serializer : WireEnumSerializer<Availability>("Availability", entries.toTypedArray(), UNKNOWN)
}

@Serializable
data class Agent(
    val name: String? = null,
    val cwd: String? = null,
)

@Serializable
data class Answer(
    val text: String = "",
    @SerialName("choice_index") val choiceIndex: Int? = null,
    @SerialName("input_method") val inputMethod: InputMethod = InputMethod.UNKNOWN,
    @SerialName("device_id") val deviceId: String? = null,
    @SerialName("answered_at") val answeredAt: String? = null,
)

/** Call の1発話。role 不明・text 欠落でも落ちない。 */
@Serializable
data class CallTranscriptEntry(
    val role: CallRole = CallRole.UNKNOWN,
    val text: String = "",
)

/**
 * VoIP 通話。`id` 欠落でも Request 全体を壊さないよう既定値を持つ。
 * 不正な id (空) は呼び出し側で無効として扱う。
 */
@Serializable
data class Call(
    val id: String = "",
    @SerialName("request_id") val requestId: String = "",
    val state: CallState = CallState.UNKNOWN,
    val outcome: CallOutcome? = null,
    @SerialName("device_id") val deviceId: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val transcript: List<CallTranscriptEntry> = emptyList(),
    /** クラウドの最新ターン。LAN relay はこのフィールドを返さない。 */
    val turn: CallTurn? = null,
) {
    val isValid: Boolean get() = id.isNotEmpty()
    val isRinging: Boolean get() = state == CallState.RINGING
    val isActive: Boolean get() = state == CallState.ACTIVE
    val isLive: Boolean get() = state == CallState.RINGING || state == CallState.ACTIVE
    val isEnded: Boolean get() = state == CallState.ENDED || (!isLive && state != CallState.UNKNOWN)
    val startedInstant: Instant? get() = parseTimestamp(startedAt)
    val updatedInstant: Instant? get() = parseTimestamp(updatedAt)
}

/** Request オブジェクト。`id` だけが必須で、他は欠落/null でも落ちない。 */
@Serializable
data class Request(
    val id: String,
    val kind: RequestKind = RequestKind.QUESTION,
    val question: String = "",
    val context: String? = null,
    val choices: List<String>? = null,
    val urgency: Urgency = Urgency.NORMAL,
    val status: RequestStatus = RequestStatus.UNKNOWN,
    val answer: Answer? = null,
    val agent: Agent? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    // v0.2 拡張。旧フィクスチャには無いので既定値で読める。
    val priority: Priority = Priority.NORMAL,
    @SerialName("delivery_mode") val deliveryMode: DeliveryMode = DeliveryMode.UNKNOWN,
    @SerialName("requested_mode") val requestedMode: RequestedMode = RequestedMode.AUTO,
    val call: Call? = null,
    val subject: String? = null,
) {
    val isPending: Boolean get() = status == RequestStatus.PENDING

    /** アプリから回答できるか (pending の question のみ)。 */
    val isAnswerable: Boolean get() = isPending && kind == RequestKind.QUESTION

    val createdInstant: Instant? get() = parseTimestamp(createdAt)
    val updatedInstant: Instant? get() = parseTimestamp(updatedAt)
    val expiresInstant: Instant? get() = parseTimestamp(expiresAt)

    /** ネイティブ通話 UI で扱うべき生きた call か。 */
    val isLiveCall: Boolean get() =
        isPending && kind == RequestKind.QUESTION &&
            deliveryMode == DeliveryMode.CALL &&
            call != null && call.isValid && call.isLive

    /** 通話が終わってテキストにフォールバックした pending か (call ended + pending)。 */
    val isCallFallback: Boolean get() =
        isPending && call != null && call.isValid && !call.isLive
}

@Serializable
data class Device(
    val id: String,
    val name: String = "",
    val platform: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/** ISO 8601 (ミリ秒あり/なし両対応)。不正・null は null。 */
fun parseTimestamp(value: String?): Instant? {
    if (value.isNullOrBlank()) return null
    return try {
        Instant.parse(value)
    } catch (e: java.time.format.DateTimeParseException) {
        null
    }
}

// ---- リクエスト/レスポンスボディ ----

@Serializable
data class PairRequest(
    val code: String,
    @SerialName("device_name") val deviceName: String,
    val platform: String,
    @SerialName("push_token") val pushToken: String? = null,
    @SerialName("push_environment") val pushEnvironment: String? = null,
)

@Serializable
data class PairResponse(
    val device: Device,
    @SerialName("device_token") val deviceToken: String,
)

@Serializable
data class AnswerBody(
    val text: String,
    @SerialName("choice_index") val choiceIndex: Int? = null,
    @SerialName("input_method") val inputMethod: InputMethod,
)

/** PUT /v1/devices/me の push_token: 触らない / 解除 (null を送る) / 設定。 */
sealed interface PushTokenUpdate {
    data object Keep : PushTokenUpdate
    data object Clear : PushTokenUpdate
    data class Set(val token: String) : PushTokenUpdate
}

/** PUT /v1/devices/me の voip_token (iOS PushKit 用。Android は未使用だが契約上独立に更新できる)。 */
sealed interface VoipTokenUpdate {
    data object Keep : VoipTokenUpdate
    data object Clear : VoipTokenUpdate
    data class Set(val token: String) : VoipTokenUpdate
}

data class DeviceUpdate(
    val pushToken: PushTokenUpdate = PushTokenUpdate.Keep,
    val voipToken: VoipTokenUpdate = VoipTokenUpdate.Keep,
    val deviceName: String? = null,
)

/** PUT /v1/presence の until/note: 触らない / 解除 (null を送る) / 設定。availability は常に送る。 */
sealed interface PresenceUntil {
    data object Keep : PresenceUntil
    data object Clear : PresenceUntil
    data class Set(val iso8601: String) : PresenceUntil
}

sealed interface PresenceNote {
    data object Keep : PresenceNote
    data object Clear : PresenceNote
    data class Set(val note: String) : PresenceNote
}

data class PresenceUpdate(
    val availability: Availability,
    val until: PresenceUntil = PresenceUntil.Keep,
    val note: PresenceNote = PresenceNote.Keep,
)

/**
 * 端末側で保持する在席状態。until 期限切れの busy/away は available として扱う。
 */
@Serializable
data class DevicePresence(
    val availability: Availability = Availability.AVAILABLE,
    val until: String? = null,
    val note: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
) {
    val untilInstant: Instant? get() = parseTimestamp(until)

    fun isExpired(now: Instant = Instant.now()): Boolean {
        val end = untilInstant ?: return false
        return !now.isBefore(end)
    }

    /** 期限切れを available に寄せた実効値。 */
    fun effective(now: Instant = Instant.now()): DevicePresence =
        if ((availability == Availability.BUSY || availability == Availability.AWAY) && isExpired(now)) {
            DevicePresence(Availability.AVAILABLE, null, null, updatedAt)
        } else this

    val effectiveAvailability: Availability get() = effective().availability
}

/** POST /v1/requests/{id}/call のボディ。 */
@Serializable
data class CallEventBody(
    val event: CallEvent,
    val text: String? = null,
    @SerialName("turn_id") val turnId: String? = null,
    @SerialName("async") val async: Boolean? = null,
    /** 端末内の復旧ヒント。ネットワークには送信しない。 */
    @kotlinx.serialization.Transient val resumeTurn: Boolean = false,
)

/** 未知・欠落の状態は成功へ丸めず、ターン待機側で拒否する。 */
@Serializable
data class CallTurn(
    val id: String = "",
    val state: String = "",
    val reply: String? = null,
    val resolved: Boolean? = null,
    val error: CallTurnError? = null,
) {
    val isPending: Boolean get() = state == "queued" || state == "running"
}

@Serializable
data class CallTurnError(val code: String = "", val message: String = "")

/** POST /v1/requests/{id}/call のレスポンス。 */
@Serializable
data class CallResponse(
    val request: Request,
    val call: Call? = null,
    val reply: String? = null,
    val resolved: Boolean? = null,
    val turn: CallTurn? = null,
) {
    val isResolved: Boolean get() = resolved == true
}

@Serializable
internal data class RequestEnvelope(val request: Request)

@Serializable
internal data class RequestsEnvelope(val requests: List<Request> = emptyList())

@Serializable
internal data class DeviceEnvelope(val device: Device)

@Serializable
internal data class ErrorEnvelope(val error: ErrorBody? = null)

@Serializable
internal data class ErrorBody(val code: String? = null, val message: String? = null)
