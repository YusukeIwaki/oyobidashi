package me.oyobidashi.android.push

import android.content.Context
import android.provider.Settings
import java.security.MessageDigest

/** Android 8+ scopes this value to signing key, Android user and device; reinstalls retain it. */
object PushClientIdentity {
    fun current(context: Context): String? {
        val id = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeIf { it.isNotBlank() } ?: return null
        // Never transmit the OS identifier itself; namespace the digest to this app.
        return MessageDigest.getInstance("SHA-256")
            .digest("me.oyobidashi.android:push-client:$id".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
