package me.oyobidashi.android.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import me.oyobidashi.android.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * google-services.json / google-services プラグインを使わず、BuildConfig の値から Firebase を手動で初期化する。
 * 値が1つでも欠けていれば [available] = false となり、プッシュ通知は無効 (アプリを開いている間の WebSocket 通知のみ)。
 */
class PushTokens(context: Context) {
    val available: Boolean = initialize(context.applicationContext)

    /** 現在の FCM 登録トークン。Firebase 未設定・取得失敗・5秒以内に取れない場合は null。 */
    suspend fun current(): String? {
        if (!available) return null
        return withTimeoutOrNull(5_000) {
            suspendCancellableCoroutine { cont ->
                try {
                    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                        if (cont.isActive) cont.resume(if (task.isSuccessful) task.result else null)
                    }
                } catch (e: RuntimeException) {
                    Log.w(TAG, "FCM token unavailable", e)
                    if (cont.isActive) cont.resume(null)
                }
            }
        }
    }

    private fun initialize(context: Context): Boolean {
        val projectId = BuildConfig.FIREBASE_PROJECT_ID
        val applicationId = BuildConfig.FIREBASE_APPLICATION_ID
        val apiKey = BuildConfig.FIREBASE_API_KEY
        val senderId = BuildConfig.FIREBASE_SENDER_ID
        if (projectId.isBlank() || applicationId.isBlank() || apiKey.isBlank() || senderId.isBlank()) {
            Log.i(TAG, "Firebase values are not configured; push notifications are disabled")
            return false
        }
        return try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(projectId)
                        .setApplicationId(applicationId)
                        .setApiKey(apiKey)
                        .setGcmSenderId(senderId)
                        .build(),
                )
            }
            true
        } catch (e: RuntimeException) {
            Log.w(TAG, "Firebase initialization failed; push notifications are disabled", e)
            false
        }
    }

    private companion object {
        const val TAG = "oyobidashi"
    }
}
