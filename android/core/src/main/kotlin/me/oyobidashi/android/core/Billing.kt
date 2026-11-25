package me.oyobidashi.android.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

/** GET /v1/billing のストア別商品。未設定のストアはレスポンスに現れない。 */
@Serializable
data class BillingProducts(
    @SerialName("product_ids") val productIds: List<String> = emptyList(),
)

/**
 * GET /v1/billing のレスポンス。課金未設定のデプロイと LAN relay では無効として扱う。
 * 表示に使うのは [active] だけで、適用可否はサーバーが決める。
 */
@Serializable
data class BillingStatus(
    val enabled: Boolean = false,
    val active: Boolean = false,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("active_stores") val activeStores: Set<String>? = null,
    val apple: BillingProducts? = null,
    val google: BillingProducts? = null,
    @SerialName("purchase_account_id") val purchaseAccountId: String? = null,
    @SerialName("voice_training") val voiceTraining: BillingVoiceTraining? = null,
    @SerialName("voice_plan_providers") val voicePlanProviders: Map<String, String>? = null,
    @SerialName("voice_provider") val voiceProvider: String? = null,
) {
    val expiresInstant: Instant? get() = parseTimestamp(expiresAt)

    companion object {
        /** 課金未設定 (404 含む) を表す無効な状態。 */
        val DISABLED: BillingStatus = BillingStatus()
    }
}

@Serializable
data class BillingVoiceTraining(
    val free: Boolean? = null,
    val plus: Boolean? = null,
)

/** POST /v1/billing/challenge のレスポンス。challenge は単回・5分間だけ有効。 */
@Serializable
data class BillingChallenge(
    val challenge: String,
    @SerialName("expires_at") val expiresAt: String? = null,
) {
    val expiresInstant: Instant? get() = parseTimestamp(expiresAt)
}

/** Play の購入1件。サーバーへ送る product_id と purchase_token の組。 */
@Serializable
data class PurchaseRef(
    @SerialName("product_id") val productId: String,
    @SerialName("purchase_token") val purchaseToken: String,
)

/** 課金 API。テストでは fake に差し替える。 */
interface BillingApi {
    suspend fun billingStatus(): BillingStatus
    suspend fun billingChallenge(): BillingChallenge

    /** POST /v1/billing/google。[payload] は送る文字列そのもの (再直列化しない)。 */
    suspend fun syncGoogle(integrityToken: String, payload: String): BillingStatus
}

/** Play Integrity の integrity token を requestHash に対して発行する。 */
interface IntegrityTokens {
    suspend fun token(requestHash: String): String
}

/**
 * 購入をサーバーへ同期する (docs/CLOUD_PROTOCOL.md の契約どおり)。
 *
 * payload の JSON 文字列は一度だけ組み立て、ハッシュした文字列と
 * 送る文字列を同一にする。課金が無効ならそれ以外の呼び出しは一切しない。
 */
class BillingSync(
    private val client: BillingApi,
    private val integrity: IntegrityTokens,
) {
    suspend fun sync(purchases: List<PurchaseRef>): BillingStatus {
        val status = client.billingStatus()
        if (!status.enabled || status.google?.productIds.isNullOrEmpty()) return status
        val challenge = client.billingChallenge()
        val payload = buildJsonObject {
            put("challenge", JsonPrimitive(challenge.challenge))
            put("purchases", buildJsonArray {
                purchases.take(MAX_PURCHASES).forEach { purchase ->
                    add(buildJsonObject {
                        put("product_id", JsonPrimitive(purchase.productId))
                        put("purchase_token", JsonPrimitive(purchase.purchaseToken))
                    })
                }
            })
        }.toString()
        val integrityToken = integrity.token(requestHash(payload))
        return client.syncGoogle(integrityToken, payload)
    }

    companion object {
        const val MAX_PURCHASES: Int = 20

        /** base64url (パディングなし) の SHA-256。payload の UTF-8 バイト列をハッシュする。 */
        fun requestHash(payload: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8))
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        }
    }
}
