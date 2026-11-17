package me.oyobidashi.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** 通知1件を組み立てるのに必要な情報 (FCM data / WebSocket イベントの両方から作る)。 */
@Serializable
data class NotificationContent(
    val requestId: String,
    val kind: RequestKind,
    val title: String,
    val body: String,
    val urgency: Urgency = Urgency.NORMAL,
    val choices: List<String> = emptyList(),
    // v0.2 拡張。旧ペイロードには無いので既定値で読める。
    val priority: Priority = Priority.NORMAL,
    val deliveryMode: DeliveryMode = DeliveryMode.UNKNOWN,
    val callId: String? = null,
    /** 終端を知らせるサイレント push (通知を出さず取り消し・再取得する)。 */
    val silent: Boolean = false,
    /** FCM に status が付いている場合のみ (終端なら取り消し対象)。 */
    val status: RequestStatus? = null,
    /** クラウドが指定する配送先。LAN の既存ペイロードにはない。 */
    val recipientDeviceId: String? = null,
) {
    fun isForDevice(currentDeviceId: String?): Boolean = recipientDeviceId == null ||
        (!currentDeviceId.isNullOrBlank() && recipientDeviceId == currentDeviceId)
    /** 通知から回答できるのは question のみ (未知の kind は一方向通知として扱う)。 */
    val isQuestion: Boolean get() = kind == RequestKind.QUESTION

    /** ネイティブ通話として扱うべきか (call_id 付き / call モード)。 */
    val isCall: Boolean get() = !callId.isNullOrEmpty() || deliveryMode == DeliveryMode.CALL

    /** 終端 push か (silent / 終端 status。未知の status も解決済み扱いで取り消す)。 */
    val isTerminalPush: Boolean get() =
        silent || (status != null && status != RequestStatus.PENDING && status != RequestStatus.NOTIFIED)

    companion object {
        const val MAX_BODY_LENGTH = 1000

        fun defaultTitle(kind: RequestKind, agentName: String?): String {
            val suffix = if (kind == RequestKind.QUESTION) "質問" else "お知らせ"
            val name = agentName?.trim().orEmpty()
            return if (name.isNotEmpty()) "$name からの$suffix" else "エージェントからの$suffix"
        }

        /** WebSocket で受けた Request から、relay が Push で送るのと同じ文面を作る。 */
        fun fromRequest(request: Request): NotificationContent = NotificationContent(
            requestId = request.id,
            kind = request.kind,
            title = defaultTitle(request.kind, request.agent?.name),
            body = request.question.take(MAX_BODY_LENGTH),
            urgency = request.urgency,
            choices = request.choices.orEmpty(),
            priority = request.priority,
            deliveryMode = request.deliveryMode,
            callId = request.call?.takeIf { it.isLive }?.id,
            silent = false,
            status = request.status,
        )
    }
}

/** FCM data メッセージ (値はすべて文字列) のパーサ。 */
object FcmPayloadParser {
    /** 古いアカウント向けの配送中 Push は、副作用を起こす前に捨てる。 */
    fun parseForDevice(data: Map<String, String?>, currentDeviceId: String?): NotificationContent? {
        if (data.containsKey("recipient_device_id") && data["recipient_device_id"] == null) return null
        return parse(data)?.takeIf { it.isForDevice(currentDeviceId) }
    }
    /**
     * `request_id` が無い/空なら null (通知しない)。それ以外の欠落・不正は既定値で埋める:
     * kind 欠落→question / 未知→UNKNOWN (一方向通知扱い)、title 欠落→既定文言、body 欠落→空、
     * urgency 欠落・未知→normal、choices 欠落・不正JSON・配列でない→空 (文字列以外の要素は捨てる)。
     * v0.2: priority 欠落・未知→normal、delivery_mode 欠落・未知→UNKNOWN (旧来の選択肢数ベース)、
     * call_id 空→null (無ければ call の JSON 文字列から id を拾う)、silent/type/status から終端 push を判定、
     * body 無ければ question を使う。
     */
    fun parse(data: Map<String, String?>): NotificationContent? {
        val requestId = data["request_id"]?.trim().orEmpty()
        if (requestId.isEmpty()) return null
        val kind = when (data["kind"]) {
            null, "", "question" -> RequestKind.QUESTION
            "notification" -> RequestKind.NOTIFICATION
            else -> RequestKind.UNKNOWN
        }
        val urgency = if (data["urgency"] == "high") Urgency.HIGH else Urgency.NORMAL
        val priority = when (data["priority"]) {
            "low" -> Priority.LOW
            "high" -> Priority.HIGH
            "urgent" -> Priority.URGENT
            else -> Priority.NORMAL
        }
        val deliveryMode = when (data["delivery_mode"]) {
            "actions" -> DeliveryMode.ACTIONS
            "text" -> DeliveryMode.TEXT
            "call" -> DeliveryMode.CALL
            else -> DeliveryMode.UNKNOWN
        }
        val callId = data["call_id"]?.trim()?.takeIf { it.isNotEmpty() }
            ?: parseCallIdFromJsonString(data["call"])
        val status = when (val raw = data["status"]) {
            null -> null
            "pending" -> RequestStatus.PENDING
            "answered" -> RequestStatus.ANSWERED
            "cancelled" -> RequestStatus.CANCELLED
            "expired" -> RequestStatus.EXPIRED
            "notified" -> RequestStatus.NOTIFIED
            else -> if (raw.isEmpty()) null else RequestStatus.UNKNOWN
        }
        val type = data["type"]?.trim().orEmpty()
        val silent = data["silent"] == "true" || data["silent"] == "1" ||
            type == "cancel" || type == "reconcile" || type == "silent" ||
            type == "request.updated"
        val body = data["body"] ?: data["question"] ?: ""
        return NotificationContent(
            requestId = requestId,
            kind = kind,
            title = data["title"]?.takeIf { it.isNotBlank() } ?: NotificationContent.defaultTitle(kind, null),
            body = body,
            urgency = urgency,
            choices = parseChoices(data["choices"]),
            priority = priority,
            deliveryMode = deliveryMode,
            callId = callId,
            silent = silent,
            status = status,
            recipientDeviceId = data["recipient_device_id"],
        )
    }

    /**
     * FCM data の `call` (JSON 文字列) から call id を拾う。
     * `"null"`・空・壊れたJSON・id 無しは null。明示の `call_id` があればそちらを優先する。
     */
    internal fun parseCallIdFromJsonString(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val trimmed = raw.trim()
        if (trimmed == "null") return null
        return try {
            val obj = OyobidashiJson.parseToJsonElement(trimmed) as? JsonObject ?: return null
            if ((obj["state"] as? JsonPrimitive)?.content == "ended") return null
            (obj["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    internal fun parseChoices(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        val array = try {
            OyobidashiJson.parseToJsonElement(raw) as? JsonArray
        } catch (e: SerializationException) {
            null
        } ?: return emptyList()
        return array.mapNotNull { el -> (el as? JsonPrimitive)?.takeIf { it.isString }?.content }
            .filter { it.isNotEmpty() }
    }
}

/**
 * 通知に載せるアクションの方針。Android の通知はアクションを最大3つしか表示しないため:
 * - 選択肢 0〜2個: 選択肢ボタン + 直接返信
 * - 選択肢 ちょうど3個: 選択肢ボタン3つ (自由入力は通知タップでアプリを開く)
 * - 選択肢 4個以上: 直接返信のみ (一部だけ見せると全選択肢に見えてしまうため。選択肢はアプリで表示)
 * v0.2: delivery_mode が text/call ならボタン無し (text は詳細を開く、call はネイティブ通話)。
 * actions/UNKNOWN (旧来) は上記の選択肢数ベース。
 */
data class NotificationActions(val choiceIndices: List<Int>, val directReply: Boolean) {
    companion object {
        const val MAX_ACTIONS = 3

        fun plan(content: NotificationContent): NotificationActions {
            if (!content.isQuestion) return NotificationActions(emptyList(), false)
            if (content.silent || content.isTerminalPush) return NotificationActions(emptyList(), false)
            when (content.deliveryMode) {
                DeliveryMode.TEXT, DeliveryMode.CALL -> return NotificationActions(emptyList(), false)
                DeliveryMode.ACTIONS -> return NotificationActions(if (content.choices.size in 1..MAX_ACTIONS) content.choices.indices.toList() else emptyList(), false)
                DeliveryMode.UNKNOWN -> Unit
            }
            val n = content.choices.size
            return when {
                n < MAX_ACTIONS -> NotificationActions((0 until n).toList(), directReply = true)
                n == MAX_ACTIONS -> NotificationActions((0 until n).toList(), directReply = false)
                else -> NotificationActions(emptyList(), directReply = true)
            }
        }
    }
}

enum class ReplyFailure {
    /** 409: すでに回答済み/取消/期限切れ。再試行不可。 */
    ALREADY_RESOLVED,

    /** 中継サーバーに届かない (同一LAN外・タイムアウト)。未送信。入力は下書きに保存され、再試行可能。 */
    UNREACHABLE,

    /** 5xx など。未送信。入力は下書きに保存され、再試行可能。 */
    RETRYABLE,

    /** 401 / 未ペアリング。 */
    SIGNED_OUT,

    /** 空文字など、送れない入力。再入力可能。 */
    INVALID_INPUT,
}

/** 通知の表示先 (Android 実装は NotificationManager、テストでは fake)。 */
interface RequestNotifier {
    fun show(content: NotificationContent)
    fun cancel(requestId: String)

    /** 通知からの回答が失敗したことを同じ通知上に表示する。 */
    fun showReplyFailure(content: NotificationContent, failure: ReplyFailure)
    fun cancelAll()
}

sealed interface DirectReplyResult {
    data class Success(val request: Request) : DirectReplyResult
    data class Failed(val failure: ReplyFailure) : DirectReplyResult
}

/**
 * 通知からの直接返信 / 選択肢ボタンの処理。relay に POST し、結果に応じて通知を消す/更新する。
 *
 * @param api 未ペアリングなら null を返す
 * @param onAnswered 成功時または 409 後の再取得成功時に最新の Request を渡す (アプリ内の一覧へ反映)
 * @param onUnauthorized 401 を受けたとき (サインアウト処理)
 * @param saveDraft 直接返信のテキストを送れなかったとき (圏外・5xx)、その request の下書きとして残す
 */
class DirectReplyHandler(
    private val api: () -> RelayApi?,
    private val notifier: RequestNotifier,
    private val onAnswered: (Request) -> Unit = {},
    private val onUnauthorized: () -> Unit = {},
    private val saveDraft: (requestId: String, text: String) -> Unit = { _, _ -> },
    private val currentDeviceId: () -> String? = { null },
) {
    /** @param choiceIndex 選択肢ボタンなら そのindex (テキストは choices から取る)。直接返信なら null。 */
    suspend fun handle(content: NotificationContent, replyText: String?, choiceIndex: Int?): DirectReplyResult {
        if (!content.isForDevice(currentDeviceId())) return DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT)
        val body = if (choiceIndex != null) {
            val choice = content.choices.getOrNull(choiceIndex) ?: return fail(content, ReplyFailure.INVALID_INPUT)
            AnswerBody(choice, choiceIndex, InputMethod.CHOICE)
        } else {
            val text = replyText?.trim().orEmpty()
            if (text.isEmpty() || text.length > AnswerLimits.MAX_TEXT_LENGTH) return fail(content, ReplyFailure.INVALID_INPUT)
            AnswerBody(text, null, InputMethod.TEXT)
        }
        val client = api() ?: return fail(content, ReplyFailure.SIGNED_OUT)
        return try {
            val request = client.answer(content.requestId, body)
            if (api() !== client || !content.isForDevice(currentDeviceId())) return DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT)
            notifier.cancel(content.requestId)
            onAnswered(request)
            DirectReplyResult.Success(request)
        } catch (e: RelayException) {
            if (api() !== client || !content.isForDevice(currentDeviceId())) return DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT)
            when {
                e.isAlreadyResolved -> {
                    try {
                        val latest = client.getRequest(content.requestId)
                        if (api() !== client || !content.isForDevice(currentDeviceId())) return DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT)
                        onAnswered(latest)
                    } catch (ignored: RelayException) {
                        // 最新状態が取れなくても通知の更新は行う
                    }
                    if (api() !== client || !content.isForDevice(currentDeviceId())) return DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT)
                    fail(content, ReplyFailure.ALREADY_RESOLVED)
                }
                e.isUnauthorized -> {
                    onUnauthorized()
                    fail(content, ReplyFailure.SIGNED_OUT)
                }
                e is RelayException.Api && e.code == ErrorCode.NOT_FOUND -> fail(content, ReplyFailure.ALREADY_RESOLVED)
                e is RelayException.Api && e.code == ErrorCode.INVALID_REQUEST -> fail(content, ReplyFailure.INVALID_INPUT)
                else -> {
                    if (choiceIndex == null) saveDraft(content.requestId, body.text)
                    fail(content, if (e is RelayException.Network) ReplyFailure.UNREACHABLE else ReplyFailure.RETRYABLE)
                }
            }
        }
    }

    private fun fail(content: NotificationContent, failure: ReplyFailure): DirectReplyResult {
        notifier.showReplyFailure(content, failure)
        return DirectReplyResult.Failed(failure)
    }
}

object AnswerLimits {
    const val MAX_TEXT_LENGTH = 10_000
}
