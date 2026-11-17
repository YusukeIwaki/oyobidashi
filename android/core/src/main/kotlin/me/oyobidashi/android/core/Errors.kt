package me.oyobidashi.android.core

/** 契約のエラーコード。未知のコードは HTTP ステータスから推定し、それも無理なら [UNKNOWN]。 */
enum class ErrorCode(val wire: String?) {
    INVALID_REQUEST("invalid_request"),
    UNAUTHORIZED("unauthorized"),
    PAIRING_CODE_INVALID("pairing_code_invalid"),
    FORBIDDEN("forbidden"),
    NOT_FOUND("not_found"),
    ALREADY_RESOLVED("already_resolved"),
    TURN_IN_PROGRESS("turn_in_progress"),
    IDEMPOTENCY_CONFLICT("idempotency_conflict"),
    CALL_ENDED("call_ended"),
    CALL_CLAIMED("call_claimed"),
    PAYLOAD_TOO_LARGE("payload_too_large"),
    RATE_LIMITED("rate_limited"),
    INTERNAL("internal"),
    UNKNOWN(null);

    companion object {
        fun fromWire(code: String?): ErrorCode? = entries.firstOrNull { it.wire != null && it.wire == code }

        /** ボディが JSON でない (プロキシの HTML 等) / code が未知のときのフォールバック。 */
        fun fromHttpStatus(status: Int): ErrorCode = when (status) {
            400 -> INVALID_REQUEST
            401 -> UNAUTHORIZED
            403 -> FORBIDDEN
            404 -> NOT_FOUND
            409 -> ALREADY_RESOLVED
            413 -> PAYLOAD_TOO_LARGE
            429 -> RATE_LIMITED
            in 500..599 -> INTERNAL
            else -> UNKNOWN
        }
    }
}

sealed class RelayException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** relay が 2xx 以外を返した。 */
    class Api(
        val httpStatus: Int,
        val code: ErrorCode,
        /** ボディに入っていた生の code (JSON でなければ null)。 */
        val rawCode: String?,
        val serverMessage: String?,
    ) : RelayException("HTTP $httpStatus ${rawCode ?: code.name}: ${serverMessage ?: "(no message)"}")

    /** 接続失敗・タイムアウトなど、レスポンスを得られなかった。 */
    class Network(val isTimeout: Boolean, cause: Throwable) :
        RelayException(if (isTimeout) "timeout" else "network error: ${cause.message}", cause)

    /** 2xx だがボディが契約どおりに読めない。 */
    class Protocol(message: String, cause: Throwable? = null) : RelayException(message, cause)

    /** 完了した失敗を、回答成功や通信切断と混同しない。 */
    class VoiceTurn(val turnId: String, val state: String, val code: String?) :
        RelayException(if (state == "cancelled") "通話が終了しました" else "音声の応答を取得できませんでした。テキストで返信できます")

    /** ベースURLが http(s) として不正。 */
    class InvalidBaseUrl(val baseUrl: String) : RelayException("invalid base url: $baseUrl")

    val isUnauthorized: Boolean get() = this is Api && code == ErrorCode.UNAUTHORIZED
    val isAlreadyResolved: Boolean get() = this is Api && code == ErrorCode.ALREADY_RESOLVED &&
        (rawCode == null || rawCode == "already_resolved")
}
