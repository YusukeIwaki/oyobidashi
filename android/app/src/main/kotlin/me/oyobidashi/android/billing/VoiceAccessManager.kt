package me.oyobidashi.android.billing

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import me.oyobidashi.android.core.RelayClient
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.core.VoiceProofMessage
import me.oyobidashi.android.core.VoiceStatus
import me.oyobidashi.android.core.VoiceTokenProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant

/** Play Integrity は登録時と6時間ごと、短い更新は端末内の鍵で署名する。 */
class VoiceAccessManager(
    context: Context,
    private val api: RelayClient,
    private val baseUrl: String,
    cloudProjectNumber: String,
) : VoiceTokenProvider {
    private val integrity = if (cloudProjectNumber.toLongOrNull() != null)
        PlayIntegrityTokens(context, cloudProjectNumber) else null
    private val prefs = context.getSharedPreferences("voice-access", Context.MODE_PRIVATE)
    private val mutex = Mutex()
    private var cached: Triple<String, String, Instant>? = null

    override suspend fun token(): String? = mutex.withLock {
        try { issueToken() }
        catch (e: CancellationException) { throw e }
        catch (e: RelayException) { throw e }
        catch (e: Exception) { throw RelayException.Protocol("端末の確認に失敗しました", e) }
    }

    private suspend fun issueToken(): String? {
        val status = api.voiceStatus() ?: return null
        if (!status.enabled || !status.supported || status.platform != "android")
            throw RelayException.Protocol("この端末ではクラウド音声を利用できません")
        val scope = baseUrl + ":" + status.uid + ":" + status.deviceId
        cached?.let { (key, token, expiry) ->
            if (key == scope && expiry.isAfter(Instant.now().plusSeconds(30))) return token
        }
        val pair = keyPair(scope)
        val keyId = b64url(sha(pair.public.encoded))
        val enrolled = prefs.getLong(scope, 0L)
        if (enrolled == 0L || System.currentTimeMillis() - enrolled >= 6 * 3600_000L) {
            enroll(status, scope, pair, keyId)
        }
        val access = try {
            issue(status, pair, keyId)
        } catch (e: RelayException.Api) {
            if (e.rawCode !in listOf("attestation_required", "integrity_required", "voice_proof_failed")) throw e
            enroll(status, scope, pair, keyId)
            issue(status, pair, keyId)
        }
        cached = Triple(scope, access.accessToken, Instant.parse(access.expiresAt))
        return access.accessToken
    }

    private suspend fun enroll(status: VoiceStatus, scope: String, pair: KeyPair, keyId: String) {
        val provider = integrity ?: throw RelayException.Protocol("Play Integrity のプロジェクト番号が未設定です")
        val challenge = api.voiceChallenge("android_enroll").challenge
        val message = VoiceProofMessage.enrollment(status.uid, status.deviceId, challenge, keyId)
        val integrityToken = provider.token(b64url(sha(message.toByteArray(StandardCharsets.UTF_8))))
        api.voiceAndroidEnroll(challenge, Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP), integrityToken)
        prefs.edit().putLong(scope, System.currentTimeMillis()).apply()
    }

    private suspend fun issue(status: VoiceStatus, pair: KeyPair, keyId: String): me.oyobidashi.android.core.VoiceAccess {
        val challenge = api.voiceChallenge("token").challenge
        val message = VoiceProofMessage.token(status.uid, status.deviceId, challenge)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(pair.private)
            update(message.toByteArray(StandardCharsets.UTF_8))
            sign()
        }
        return api.voiceAccess(challenge, keyId, Base64.encodeToString(signature, Base64.NO_WRAP))
    }

    private fun keyPair(scope: String): KeyPair {
        val alias = "oyobidashi-voice-" + b64url(sha(scope.toByteArray(StandardCharsets.UTF_8)))
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        if (existing != null) return KeyPair(existing.certificate.publicKey, existing.privateKey)
        return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build())
            generateKeyPair()
        }
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun b64url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
