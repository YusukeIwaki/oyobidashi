package me.oyobidashi.android.ui

import me.oyobidashi.android.core.AnswerError
import me.oyobidashi.android.core.Availability
import me.oyobidashi.android.core.CallOutcome
import me.oyobidashi.android.core.DeliveryMode
import me.oyobidashi.android.core.ErrorCode
import me.oyobidashi.android.core.PairingError
import me.oyobidashi.android.core.Priority
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.core.Request
import me.oyobidashi.android.core.RequestKind
import me.oyobidashi.android.core.RequestStatus
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object Texts {
    const val UNREACHABLE = "中継サーバーに接続できません。ネットワーク接続を確認してください"

    fun pairingError(error: PairingError): String = when (error) {
        PairingError.NOT_PAIRING_URI -> "oyobidashi のペアリング用QRコード/リンクではありません"
        PairingError.MISSING_URL -> "中継サーバーのURLを入力してください"
        PairingError.MISSING_CODE -> "ペアリングコードを入力してください"
        PairingError.INVALID_URL -> "URLは http:// または https:// で始まる形式で入力してください (例: http://192.168.1.10:8787)"
        PairingError.INVALID_CODE -> "ペアリングコードの形式が正しくありません"
    }

    fun pairFailure(e: RelayException): String = when (e) {
        is RelayException.Network -> UNREACHABLE
        is RelayException.InvalidBaseUrl -> "URLが正しくありません"
        is RelayException.Protocol -> "中継サーバーから想定外の応答がありました。URLを確認してください"
        is RelayException.VoiceTurn -> e.message ?: "音声の応答を取得できませんでした"
        is RelayException.Api -> when (e.code) {
            ErrorCode.PAIRING_CODE_INVALID -> "ペアリングコードが正しくないか、期限切れ・使用済みです。コードを再発行してください"
            ErrorCode.RATE_LIMITED -> "試行回数が多すぎます。しばらく待ってからやり直してください"
            ErrorCode.FORBIDDEN -> "中継サーバーに拒否されました。接続先とペアリング設定を確認してください"
            ErrorCode.NOT_FOUND -> "URLが oyobidashi の中継サーバーではないようです"
            ErrorCode.INVALID_REQUEST, ErrorCode.PAYLOAD_TOO_LARGE -> "入力内容が正しくありません"
            else -> "中継サーバーでエラーが発生しました (HTTP ${e.httpStatus})"
        }
    }

    fun unpairFailure(e: RelayException): String = when (e) {
        is RelayException.Network -> "$UNREACHABLE。\nサーバー側の登録は残りますが、この端末だけ解除することもできます"
        else -> "サーバー側の解除に失敗しました。この端末だけ解除することもできます"
    }

    fun answerError(error: AnswerError): String = when (error) {
        AnswerError.ALREADY_RESOLVED -> "この質問はすでに回答済みか、取り消されています"
        AnswerError.NETWORK -> "回答の送信結果を確認できませんでした。$UNREACHABLE (入力内容は保持されます)"
        AnswerError.INVALID -> "回答を入力してください (1〜10000文字)"
        AnswerError.NOT_FOUND -> "この質問は中継サーバーに見つかりません"
        AnswerError.SERVER -> "回答を送信できませんでした。もう一度お試しください"
    }

    fun status(request: Request): String = when (request.status) {
        RequestStatus.PENDING -> "未回答"
        RequestStatus.ANSWERED -> "回答済み"
        RequestStatus.CANCELLED -> "取り消し"
        RequestStatus.EXPIRED -> "期限切れ"
        RequestStatus.NOTIFIED -> "お知らせ"
        RequestStatus.UNKNOWN -> "解決済み"
    }

    fun agentLabel(request: Request): String {
        val name = request.agent?.name?.takeIf { it.isNotBlank() } ?: "エージェント"
        return if (request.kind == RequestKind.QUESTION) "$name からの質問" else "$name からのお知らせ"
    }

    fun priorityLabel(priority: Priority): String = when (priority) {
        Priority.LOW -> "低"
        Priority.NORMAL -> "通常"
        Priority.HIGH -> "高"
        Priority.URGENT -> "至急"
        Priority.UNKNOWN -> "通常"
    }

    fun deliveryLabel(mode: DeliveryMode): String? = when (mode) {
        DeliveryMode.ACTIONS -> "ボタン"
        DeliveryMode.TEXT -> "テキスト"
        DeliveryMode.CALL -> "通話"
        DeliveryMode.UNKNOWN -> null
    }

    fun callOutcomeLabel(outcome: CallOutcome?): String? = when (outcome) {
        null -> null
        CallOutcome.RESOLVED -> "通話で解決"
        CallOutcome.DECLINED -> "通話を拒否"
        CallOutcome.HANGUP -> "通話を切断"
        CallOutcome.MISSED -> "不在着信"
        CallOutcome.CANCELLED -> "通話取消"
        CallOutcome.EXPIRED -> "通話期限切れ"
        CallOutcome.FAILED -> "通話失敗"
        CallOutcome.UNKNOWN -> "通話終了"
    }

    fun availabilityLabel(availability: Availability): String = when (availability) {
        Availability.AVAILABLE -> "対応可"
        Availability.BUSY -> "取り込み中"
        Availability.AWAY -> "離席中"
        Availability.UNKNOWN -> "対応可"
    }

    fun availabilityDescription(availability: Availability): String = when (availability) {
        Availability.AVAILABLE -> "質問・通話を受け取ります"
        Availability.BUSY -> "通話はテキストになります (30分)"
        Availability.AWAY -> "通話はテキストになります"
        Availability.UNKNOWN -> "質問・通話を受け取ります"
    }

    private val timeFormat = DateTimeFormatter.ofPattern("M/d HH:mm")
    private val clockFormat = DateTimeFormatter.ofPattern("HH:mm")

    fun time(request: Request): String =
        request.createdInstant?.atZone(ZoneId.systemDefault())?.format(timeFormat).orEmpty()

    fun clock(iso8601: String?): String = try {
        if (iso8601.isNullOrBlank()) ""
        else java.time.Instant.parse(iso8601).atZone(ZoneId.systemDefault()).format(clockFormat)
    } catch (e: Exception) {
        ""
    }
}
