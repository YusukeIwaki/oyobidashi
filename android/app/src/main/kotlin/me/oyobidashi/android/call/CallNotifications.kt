package me.oyobidashi.android.call

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import me.oyobidashi.android.R
import me.oyobidashi.android.core.Call
import me.oyobidashi.android.core.Request

/**
 * 通話のネイティブ通知。着信は CallStyle + 許可時のみフルスクリーン、通話中は FGS 用の ongoing。
 * 着信用の tag/id は通常通知と同じ (requestId/1) にして、1リクエスト1通知・取り消しの共通化を図る。
 * FGS の ongoing は id 2 (tag 無し) で別枠にする。
 */
object CallNotifications {
    const val CHANNEL_CALLS = "calls"
    const val INCOMING_ID = 1
    const val ONGOING_ID = 2

    fun ensureCallChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_CALLS,
            context.getString(R.string.channel_calls),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_calls_desc)
            enableVibration(true)
            enableLights(true)
            setBypassDnd(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        NotificationManagerCompat.from(context).createNotificationChannel(channel)
    }

    fun canPost(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled() && (
            Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            )

    /** Android 14+ ではユーザーがフルスクリーン通知を無効にできる。許可があるときだけ使う。 */
    fun canUseFullScreen(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        return try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return true
            nm.canUseFullScreenIntent()
        } catch (e: RuntimeException) {
            true
        }
    }

    private fun caller(request: Request): Person {
        val name = request.agent?.name?.takeIf { it.isNotBlank() }?.let { "$it からの通話" } ?: "エージェントからの通話"
        return Person.Builder()
            .setName(name)
            .setImportant(true)
            .build()
    }

    private fun callIntent(context: Context, action: String, requestId: String, callId: String): PendingIntent {
        val intent = Intent(context, CallActivity::class.java)
            .setAction(action)
            .setData(Uri.parse("oyobidashi-call://$action/${Uri.encode(requestId)}/${Uri.encode(callId)}"))
            .putExtra(CallActivity.EXTRA_REQUEST_ID, requestId)
            .putExtra(CallActivity.EXTRA_CALL_ID, callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun showIncoming(context: Context, request: Request, call: Call) {
        if (!canPost(context)) return
        ensureCallChannel(context)
        val answer = callIntent(context, CallActivity.ACTION_ANSWER, request.id, call.id)
        val decline = callIntent(context, CallActivity.ACTION_DECLINE, request.id, call.id)
        val fullScreen = callIntent(context, CallActivity.ACTION_SHOW, request.id, call.id)
        val style = NotificationCompat.CallStyle.forIncomingCall(caller(request), decline, answer)
            .setIsVideo(false)
        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(request.agent?.name?.let { "$it からの通話" } ?: "エージェントからの通話")
            .setContentText(listOfNotNull(request.subject?.takeIf { it.isNotBlank() }, request.question).joinToString("\n").take(200))
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(fullScreen)
            .setDeleteIntent(decline)
        // 許可があるときだけフルスクリーン (ロック画面・全画面の着信表示)。
        if (canUseFullScreen(context)) {
            builder.setFullScreenIntent(fullScreen, true)
        }
        post(context, request.id, INCOMING_ID, builder)
    }

    /** FGS (通話中) 用の ongoing 通知。hangup アクション付き。 */
    fun ongoingNotification(context: Context, requestId: String, callId: String, agentName: String?, question: String): android.app.Notification {
        ensureCallChannel(context)
        val hangup = callIntent(context, CallActivity.ACTION_HANGUP, requestId, callId)
        val open = callIntent(context, CallActivity.ACTION_SHOW, requestId, callId)
        val name = agentName?.takeIf { it.isNotBlank() }?.let { "$it と通話中" } ?: "エージェントと通話中"
        // CallStyle ongoing は answer 無し・hangup のみ。端末によっては表示が崩れるため、
        // BigTextStyle を併用せず CallStyle 一本にする。
        val style = NotificationCompat.CallStyle.forOngoingCall(
            Person.Builder().setName(name).setImportant(true).build(),
            hangup,
        ).setIsVideo(false)
        return NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(name)
            .setContentText(question.take(200))
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(NotificationCompat.Action.Builder(0, "切断", hangup).build())
            .build()
    }

    fun cancelIncoming(context: Context, requestId: String) {
        NotificationManagerCompat.from(context).cancel(requestId, INCOMING_ID)
    }

    @SuppressLint("MissingPermission")
    private fun post(context: Context, tag: String, id: Int, builder: NotificationCompat.Builder) {
        if (!canPost(context)) return
        NotificationManagerCompat.from(context).notify(tag, id, builder.build())
    }
}
