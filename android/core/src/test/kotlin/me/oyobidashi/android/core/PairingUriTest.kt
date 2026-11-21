package me.oyobidashi.android.core

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingUriTest {
    private fun ok(url: String, code: String) = PairingParseResult.Success(PairingInfo(url, code))
    private fun fail(e: PairingError) = PairingParseResult.Failure(e)

    @Test
    fun `fixture pairing_uri`() {
        assertEquals(
            ok("http://192.168.1.10:8787", "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21"),
            PairingUri.parse(Fixtures.text("pairing_uri.txt")), // 末尾の改行つき
        )
    }

    @Test
    fun `percent-encoded LAN url with port`() {
        assertEquals(ok("http://192.168.1.10:8787", "abc"), PairingUri.parse("oyobidashi://pair?url=http%3A%2F%2F192.168.1.10%3A8787&code=abc"))
    }

    @Test
    fun `plain http with private IP literals, IPv6 literals and mDNS names is accepted`() {
        for (u in listOf("http://10.0.0.5:8787", "http://172.16.3.4:8787", "http://192.168.0.2", "http://127.0.0.1:8787",
            "http://169.254.1.2:8787", "http://[::1]:8787", "http://[fe80::1]:8787", "http://my-mac.local:8787", "https://192.168.1.10:8443")) {
            val encoded = java.net.URLEncoder.encode(u, "UTF-8")
            assertEquals(u, ok(u, "c1"), PairingUri.parse("oyobidashi://pair?url=$encoded&code=c1"))
            assertEquals(u, ok(u, "c1"), PairingUri.fromManualInput(u, "c1"))
        }
    }

    @Test
    fun `invalid ports and hosts are rejected`() {
        for (u in listOf("http://192.168.1.10:99999", "http://192.168.1.10:abc", "http://:8787", "http://[::1")) {
            assertEquals(u, fail(PairingError.INVALID_URL), PairingUri.fromManualInput(u, "c1"))
        }
    }

    @Test
    fun `lowercase hex escapes and percent-encoded code`() {
        assertEquals(ok("https://a.example", "a b".replace(" ", "-") ), PairingUri.parse("oyobidashi://pair?url=https%3a%2f%2fa.example&code=a%2Db"))
    }

    @Test
    fun `unencoded url is accepted`() {
        assertEquals(ok("https://a.example", "c1"), PairingUri.parse("oyobidashi://pair?url=https://a.example&code=c1"))
    }

    @Test
    fun `url with path prefix keeps the path and drops the trailing slash`() {
        assertEquals(ok("https://a.example/oyobidashi", "c1"), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example%2Foyobidashi%2F&code=c1"))
        assertEquals(ok("https://a.example", "c1"), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example%2F&code=c1"))
    }

    @Test
    fun `parameter order, extra params, duplicates and fragment`() {
        assertEquals(ok("https://a.example", "c1"), PairingUri.parse("oyobidashi://pair?v=2&code=c1&foo&url=https%3A%2F%2Fa.example&code=c2&&x=%ZZ#frag"))
    }

    @Test
    fun `scheme and host are case-insensitive, trailing slash allowed`() {
        assertEquals(ok("https://a.example", "c1"), PairingUri.parse("  OYOBIDASHI://Pair/?url=https%3A%2F%2Fa.example&code=c1 "))
    }

    @Test
    fun `plus is kept literally`() {
        assertEquals(ok("https://a.example", "a+b"), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=a+b"))
    }

    @Test
    fun `missing or empty params`() {
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair"))
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair?"))
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair?code=c1"))
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair?url=&code=c1"))
        assertEquals(fail(PairingError.MISSING_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example"))
        assertEquals(fail(PairingError.MISSING_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code="))
        assertEquals(fail(PairingError.MISSING_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=%20"))
    }

    @Test
    fun `wrong scheme or host`() {
        for (s in listOf(
            "", "hello", "https://example.com/pair?url=https%3A%2F%2Fa.example&code=c1",
            "oyobidashi://unpair?url=https%3A%2F%2Fa.example&code=c1",
            "oyobidashi://pairing?url=https%3A%2F%2Fa.example&code=c1",
            "oyobidashi://pair/extra?url=https%3A%2F%2Fa.example&code=c1",
            "oyobidashi:pair?url=https%3A%2F%2Fa.example&code=c1",
            "xoyobidashi://pair?url=https%3A%2F%2Fa.example&code=c1",
        )) {
            assertEquals(s, fail(PairingError.NOT_PAIRING_URI), PairingUri.parse(s))
        }
    }

    @Test
    fun `non-http url is rejected`() {
        for (u in listOf("ftp%3A%2F%2Fa.example", "javascript%3Aalert(1)", "file%3A%2F%2F%2Fetc%2Fpasswd", "a.example", "oyobidashi%3A%2F%2Fpair",
            "https%3A%2F%2F", "http%3A%2F%2Fa%20b.example", "ws%3A%2F%2Fa.example")) {
            assertEquals(u, fail(PairingError.INVALID_URL), PairingUri.parse("oyobidashi://pair?url=$u&code=c1"))
        }
    }

    @Test
    fun `malformed percent escape in url makes it missing or invalid, never a crash`() {
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example%&code=c1"))
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.parse("oyobidashi://pair?url=%FF%FE&code=c1")) // 不正なUTF-8
    }

    @Test
    fun `code with control characters or absurd length is rejected`() {
        assertEquals(fail(PairingError.INVALID_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=a%0Ab"))
        assertEquals(fail(PairingError.INVALID_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=a%20b"))
        assertEquals(fail(PairingError.INVALID_CODE), PairingUri.parse("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=" + "a".repeat(257)))
    }

    @Test
    fun `manual input is trimmed and validated`() {
        assertEquals(ok("https://a.example", "c1"), PairingUri.fromManualInput("  https://a.example/ ", " c1\n"))
        assertEquals(ok("http://192.168.0.2:8787", "c1"), PairingUri.fromManualInput("HTTP://192.168.0.2:8787", "c1"))
        assertEquals(fail(PairingError.MISSING_URL), PairingUri.fromManualInput(" ", "c1"))
        assertEquals(fail(PairingError.MISSING_CODE), PairingUri.fromManualInput("https://a.example", "  "))
        assertEquals(fail(PairingError.INVALID_URL), PairingUri.fromManualInput("a.example", "c1"))
        assertEquals(fail(PairingError.INVALID_URL), PairingUri.fromManualInput("ftp://a.example", "c1"))
        assertEquals(fail(PairingError.INVALID_CODE), PairingUri.fromManualInput("https://a.example", "a b"))
    }

    @Test
    fun `manual input drops query and fragment from the url`() {
        assertEquals(ok("https://a.example/x", "c1"), PairingUri.fromManualInput("https://a.example/x/?a=1#f", "c1"))
    }

    @Test
    fun `pairing uri pasted into the manual url field is parsed`() {
        assertEquals(ok("https://a.example", "c9"), PairingUri.fromManualInput("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=c9", ""))
        assertEquals(fail(PairingError.NOT_PAIRING_URI), PairingUri.fromManualInput("oyobidashi://other", "c1"))
    }

    // ---- アプリが始めたペアリングだけをリンクから受け付ける ----

    private val cloud = "https://api.oyobidashi.me"
    private fun link(url: String = "https%3A%2F%2Fapi.oyobidashi.me", code: String = "c1", state: String? = null) =
        "oyobidashi://pair?url=$url&code=$code" + (state?.let { "&state=$it" } ?: "")

    @Test
    fun `attempt issues an unguessable state and opens the pairing page with it`() {
        val first = PairingAttempt.begin(cloud, 0)
        val second = PairingAttempt.begin(cloud, 0)
        assertEquals(false, first.state == second.state)
        assertEquals(true, Regex("^[A-Za-z0-9_-]{43}$").matches(first.state))
        assertEquals("https://api.oyobidashi.me/pair?from=app&state=${first.state}", first.pageUrl)
    }

    @Test
    fun `attempt accepts only the link that returns its state`() {
        val now = 1_800_000_000_000L
        val attempt = PairingAttempt.begin(cloud, now)
        val rejected = fail(PairingError.NOT_STARTED_IN_APP)
        assertEquals(ok(cloud, "c1"), attempt.accept(link(state = attempt.state), now + 60_000))
        // 他人が送ってきたリンク: state を知らない。
        assertEquals(rejected, attempt.accept(link(code = "attacker"), now))
        assertEquals(rejected, attempt.accept(link(code = "attacker", state = ""), now))
        assertEquals(rejected, attempt.accept(link(code = "attacker", state = "A".repeat(43)), now))
        // state が合っても、アプリが開いたのとは別のサーバーには繋がない。
        assertEquals(rejected, attempt.accept(link(url = "https%3A%2F%2Fevil.example", state = attempt.state), now))
        // 期限切れ。
        assertEquals(rejected, attempt.accept(link(state = attempt.state), now + PairingAttempt.LIFETIME_MILLIS))
        // 形式の誤りは従来どおりの理由を返す。
        assertEquals(fail(PairingError.NOT_PAIRING_URI), attempt.accept("https://example.com/pair", now))
    }
}
