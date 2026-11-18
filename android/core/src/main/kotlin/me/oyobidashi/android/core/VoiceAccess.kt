package me.oyobidashi.android.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

interface VoiceTokenProvider {
    suspend fun token(): String?
}

@Serializable
data class VoiceStatus(
    val enabled: Boolean,
    val supported: Boolean,
    val platform: String,
    val uid: String,
    @SerialName("device_id") val deviceId: String,
)

@Serializable
data class VoiceChallenge(val challenge: String)

@Serializable
data class VoiceAccess(
    @SerialName("access_token") val accessToken: String,
    @SerialName("expires_at") val expiresAt: String,
)

@Serializable
internal data class VoiceChallengeRequest(val purpose: String)

@Serializable
internal data class VoiceAndroidEnroll(
    val challenge: String,
    @SerialName("public_key") val publicKey: String,
    @SerialName("integrity_token") val integrityToken: String,
)

@Serializable
internal data class VoiceTokenRequest(
    val challenge: String,
    @SerialName("key_id") val keyId: String,
    val signature: String,
)

object VoiceProofMessage {
    fun enrollment(uid: String, deviceId: String, challenge: String, keyId: String): String =
        "voice-enroll\n$uid\n$deviceId\n$challenge\n$keyId"

    fun token(uid: String, deviceId: String, challenge: String): String =
        "voice-token\n$uid\n$deviceId\n$challenge"
}
