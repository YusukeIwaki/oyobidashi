package me.oyobidashi.android.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.ByteArrayOutputStream

/** ペアリングに必要な情報。[url] は検証済みの http(s) ベースURL (末尾スラッシュなし)。 */
data class PairingInfo(val url: String, val code: String)

enum class PairingError {
    /** `oyobidashi://pair?...` の形をしていない (スキーム/ホスト違い、URIとして不正) */
    NOT_PAIRING_URI,
    MISSING_URL,
    MISSING_CODE,

    /** url が http(s) の絶対URLでない */
    INVALID_URL,

    /** code に空白・制御文字が含まれる、または長すぎる */
    INVALID_CODE,

    /** このアプリが始めたペアリングへの戻りリンクではない */
    NOT_STARTED_IN_APP,
}

sealed interface PairingParseResult {
    data class Success(val info: PairingInfo) : PairingParseResult
    data class Failure(val error: PairingError) : PairingParseResult
}

/**
 * `oyobidashi://pair?url=<percent-encoded>&code=<code>` のパーサと手入力のバリデーション。
 *
 * - スキーム/ホストは大文字小文字を区別しない。`oyobidashi://pair/?…` (末尾スラッシュ) も許容。
 * - クエリは RFC 3986 のパーセントデコード (UTF-8)。`+` は空白にせずそのまま扱う。
 * - 同じキーが複数あれば最初のものを採用。未知のパラメータは無視。
 */
object PairingUri {
    private const val PREFIX = "oyobidashi://pair"
    private const val MAX_CODE_LENGTH = 256

    fun parse(raw: String): PairingParseResult {
        val params = params(raw) ?: return PairingParseResult.Failure(PairingError.NOT_PAIRING_URI)
        return validate(params["url"].orEmpty(), params["code"].orEmpty())
    }

    /** リンクに載っている `state` (アプリがペアリングページへ渡した1回限りの値)。無ければ null。 */
    fun state(raw: String): String? = params(raw)?.get("state")?.takeIf { it.isNotEmpty() }

    private fun params(raw: String): Map<String, String>? {
        val text = raw.trim()
        if (!text.regionMatches(0, PREFIX, 0, PREFIX.length, ignoreCase = true)) return null
        var rest = text.substring(PREFIX.length).substringBefore('#')
        if (rest.startsWith("/")) rest = rest.substring(1)
        val query = when {
            rest.isEmpty() -> ""
            rest.startsWith("?") -> rest.substring(1)
            else -> return null // oyobidashi://pairing, oyobidashi://pair/x など
        }
        val params = LinkedHashMap<String, String>()
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val key = percentDecode(part.substringBefore('=')) ?: continue
            val value = percentDecode(part.substringAfter('=', "")) ?: ""
            if (key !in params) params[key] = value
        }
        return params
    }

    /** 手入力 (URL とコード) の検証。URL欄に `oyobidashi://pair?...` を貼られた場合はそれを解釈する。 */
    fun fromManualInput(url: String, code: String): PairingParseResult {
        val trimmedUrl = url.trim()
        if (trimmedUrl.regionMatches(0, "oyobidashi:", 0, "oyobidashi:".length, ignoreCase = true)) return parse(trimmedUrl)
        return validate(trimmedUrl, code)
    }

    private fun validate(url: String, code: String): PairingParseResult {
        val u = url.trim()
        val c = code.trim()
        if (u.isEmpty()) return PairingParseResult.Failure(PairingError.MISSING_URL)
        if (c.isEmpty()) return PairingParseResult.Failure(PairingError.MISSING_CODE)
        val normalized = normalizeBaseUrl(u) ?: return PairingParseResult.Failure(PairingError.INVALID_URL)
        if (c.length > MAX_CODE_LENGTH || c.any { it.isWhitespace() || it.isISOControl() }) {
            return PairingParseResult.Failure(PairingError.INVALID_CODE)
        }
        return PairingParseResult.Success(PairingInfo(normalized, c))
    }

    /** http(s) の絶対URLなら末尾スラッシュ・クエリ・フラグメントを除いて返す。それ以外は null。 */
    fun normalizeBaseUrl(url: String): String? {
        val lower = url.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
        if (url.any { it.isWhitespace() }) return null
        val parsed = url.toHttpUrlOrNull() ?: return null
        if (parsed.host.isEmpty()) return null
        return parsed.newBuilder().query(null).fragment(null).build().toString().trimEnd('/')
    }

    /** 不正な % エスケープや不正な UTF-8 は null。 */
    internal fun percentDecode(s: String): String? {
        if ('%' !in s) return s
        val out = ByteArrayOutputStream(s.length)
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            if (ch == '%') {
                if (i + 2 >= s.length) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                out.write(hi * 16 + lo)
                i += 3
            } else {
                val next = s.indexOf('%', i).let { if (it < 0) s.length else it }
                out.write(s.substring(i, next).toByteArray(Charsets.UTF_8))
                i = next
            }
        }
        return try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            null
        }
    }
}

/**
 * アプリが自分で始めたペアリングの控え。
 *
 * `oyobidashi://pair` のリンクは外部から誰でも開ける。届いたリンクのコードが他人のアカウントのものでも
 * 見分けがつかないため、リンクからのペアリングは、アプリがブラウザへ渡した1回限りの値 ([state]) を
 * そのまま返したものだけを受け付ける。QR読み取りと手入力は、利用者がアプリ内で始めるのでこの対象外。
 */
data class PairingAttempt(val state: String, val url: String, val expiresAtMillis: Long) {
    /** ブラウザで開くペアリングページ。ページは [state] を「アプリを開く」のリンクにそのまま載せる。 */
    val pageUrl: String get() = "$url/pair?from=app&state=$state"

    /** 届いたリンクが、この控えのペアリングへの戻りであれば、その内容を返す。 */
    fun accept(uri: String, nowMillis: Long): PairingParseResult {
        val parsed = PairingUri.parse(uri)
        if (parsed !is PairingParseResult.Success) return parsed
        val returned = PairingUri.state(uri)
        if (nowMillis >= expiresAtMillis || returned == null || returned != state || parsed.info.url != url) {
            return PairingParseResult.Failure(PairingError.NOT_STARTED_IN_APP)
        }
        return parsed
    }

    companion object {
        /** ログインにかかる時間と、コードの有効期間 (10分) を足した余裕。 */
        const val LIFETIME_MILLIS = 30 * 60 * 1000L

        /** 新しい控えを作る。[state] は推測できない256ビットの乱数 (base64url、43文字)。 */
        fun begin(url: String, nowMillis: Long, random: java.security.SecureRandom = java.security.SecureRandom()): PairingAttempt {
            val bytes = ByteArray(32).also(random::nextBytes)
            val state = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            return PairingAttempt(state, url, nowMillis + LIFETIME_MILLIS)
        }
    }
}
