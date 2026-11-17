package me.oyobidashi.android.push

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
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import me.oyobidashi.android.R
import me.oyobidashi.android.call.CallNotifications
import me.oyobidashi.android.core.OyobidashiJson
import me.oyobidashi.android.core.NotificationActions
import me.oyobidashi.android.core.NotificationContent
import me.oyobidashi.android.core.Priority
import me.oyobidashi.android.core.ReplyFailure
import me.oyobidashi.android.core.RequestNotifier
import me.oyobidashi.android.core.Urgency
import me.oyobidashi.android.ui.MainActivity
import me.oyobidashi.android.graph

/** 通知の組み立て。request id を tag にするので、FCM と WebSocket の両方から届いても1件にまとまる。 */
class AndroidNotifier(private val context: Context) : RequestNotifier {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        val low = NotificationChannel(
            CHANNEL_LOW, context.getString(R.string.channel_low), NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.channel_low_desc)
            enableVibration(false)
            enableLights(false)
            setSound(null, null)
            setShowBadge(false)
        }
        val normal = NotificationChannel(
            CHANNEL_NORMAL, context.getString(R.string.channel_normal), NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.channel_normal_desc)
            enableVibration(true)
            enableLights(true)
        }
        val high = NotificationChannel(
            CHANNEL_HIGH, context.getString(R.string.channel_high), NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_high_desc)
            enableVibration(true)
            enableLights(true)
        }
        manager.createNotificationChannels(listOf(low, normal, high))
        CallNotifications.ensureCallChannel(context)
        // 旧チャンネル (v0.1) の掃除。残っていても無害だが設定画面を汚すので消す。
        try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            nm.deleteNotificationChannel(CHANNEL_QUESTIONS)
            nm.deleteNotificationChannel(CHANNEL_NOTIFICATIONS)
        } catch (e: RuntimeException) {
            // 削除失敗は無害
        }
    }

    fun canPost(): Boolean =
        manager.areNotificationsEnabled() && (
            Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            )

    override fun show(content: NotificationContent) {
        if (!content.isForDevice(context.graph.session.value?.credentials?.deviceId)) return
        // 終端 push・通話は通常通知にしない (呼び出し側で取り消し・通話通知する)。
        if (content.isTerminalPush || content.silent) {
            cancel(content.requestId)
            return
        }
        if (content.isCall) return
        val builder = if (content.isQuestion) questionBuilder(content, errorText = null) else plainBuilder(content)
        post(content.requestId, builder)
    }

    override fun cancel(requestId: String) {
        manager.cancel(requestId, NOTIFICATION_ID)
        // 通話通知も同じ tag のため同時に消える。FGS の ongoing (id 2) は service 停止で消える。
    }

    override fun cancelAll() = manager.cancelAll()

    override fun showReplyFailure(content: NotificationContent, failure: ReplyFailure) {
        if (!content.isForDevice(context.graph.session.value?.credentials?.deviceId)) return
        val builder = when (failure) {
            ReplyFailure.UNREACHABLE -> questionBuilder(
                content,
                "回答は送信されていません。中継サーバーに接続できません。同じWi‑Fiに接続してからもう一度お試しください (入力内容は下書きに保存しました)",
            )
            ReplyFailure.RETRYABLE -> questionBuilder(
                content, "回答は送信されていません。サーバーでエラーが発生しました。もう一度お試しください (入力内容は下書きに保存しました)",
            )
            ReplyFailure.INVALID_INPUT -> questionBuilder(content, "回答を送信できませんでした。入力内容を確認してください")
            ReplyFailure.ALREADY_RESOLVED -> statusBuilder(content, "この質問はすでに回答済みか、取り消されています").setTimeoutAfter(8_000)
            ReplyFailure.SIGNED_OUT -> statusBuilder(content, "回答は送信されていません。ペアリングが解除されています。アプリを開いて再度ペアリングしてください")
        }
        // 返信中のスピナーを止めるため、必ず同じ tag で出し直す (音は鳴らさない)
        post(content.requestId, builder.setSilent(true))
    }

    /** 優先度 → チャンネル。旧 urgency high は high に寄せる (後方互換)。 */
    internal fun channelFor(content: NotificationContent): String = when (content.priority) {
        Priority.LOW -> CHANNEL_LOW
        Priority.HIGH, Priority.URGENT -> CHANNEL_HIGH
        Priority.NORMAL, Priority.UNKNOWN ->
            if (content.urgency == Urgency.HIGH) CHANNEL_HIGH else CHANNEL_NORMAL
    }

    private fun compatPriority(content: NotificationContent): Int = when (channelFor(content)) {
        CHANNEL_LOW -> NotificationCompat.PRIORITY_LOW
        CHANNEL_HIGH -> NotificationCompat.PRIORITY_HIGH
        else -> NotificationCompat.PRIORITY_DEFAULT
    }

    private fun questionBuilder(content: NotificationContent, errorText: String?): NotificationCompat.Builder {
        val text = if (errorText != null) "$errorText\n\n${content.body}" else content.body
        val channel = channelFor(content)
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(content.title)
            .setContentText(errorText ?: content.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(compatPriority(content))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(openIntent(content))

        val plan = NotificationActions.plan(content)
        for (index in plan.choiceIndices) {
            builder.addAction(
                NotificationCompat.Action.Builder(0, content.choices[index].take(40), replyIntent(content, index, mutable = false)).build()
            )
        }
        if (plan.directReply) {
            val remoteInput = RemoteInput.Builder(ReplyReceiver.KEY_REPLY_TEXT).setLabel("回答を入力").build()
            builder.addAction(
                NotificationCompat.Action.Builder(0, "返信", replyIntent(content, null, mutable = true))
                    .addRemoteInput(remoteInput)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setAllowGeneratedReplies(false)
                    .build()
            )
        }
        return builder
    }

    private fun plainBuilder(content: NotificationContent): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channelFor(content))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(content.title)
            .setContentText(content.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(content.body))
            .setPriority(compatPriority(content))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(openIntent(content))

    private fun statusBuilder(content: NotificationContent, message: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channelFor(content))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(content.title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(compatPriority(content))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(openIntent(content))

    @SuppressLint("MissingPermission") // canPost() で確認済み
    private fun post(requestId: String, builder: NotificationCompat.Builder) {
        if (!canPost()) return
        manager.notify(requestId, NOTIFICATION_ID, builder.build())
    }

    private fun openIntent(content: NotificationContent): PendingIntent {
        val requestId = content.requestId
        val intent = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_REQUEST)
            .setData(Uri.parse("oyobidashi-request://open/${Uri.encode(requestId)}"))
            .putExtra(MainActivity.EXTRA_REQUEST_ID, requestId)
            .putExtra(MainActivity.EXTRA_CONTENT, OyobidashiJson.encodeToString(NotificationContent.serializer(), content))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun replyIntent(content: NotificationContent, choiceIndex: Int?, mutable: Boolean): PendingIntent {
        val intent = Intent(context, ReplyReceiver::class.java)
            .setAction(ReplyReceiver.ACTION_REPLY)
            // PendingIntent を request / アクションごとに区別するための data
            .setData(Uri.parse("oyobidashi-request://reply/${Uri.encode(content.requestId)}/${choiceIndex ?: "text"}"))
            .putExtra(ReplyReceiver.EXTRA_CONTENT, OyobidashiJson.encodeToString(NotificationContent.serializer(), content))
        if (choiceIndex != null) intent.putExtra(ReplyReceiver.EXTRA_CHOICE_INDEX, choiceIndex)
        // RemoteInput の結果を書き込めるよう、直接返信だけ MUTABLE にする
        val mutability = if (mutable && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else if (mutable) 0 else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutability)
    }

    companion object {
        const val CHANNEL_LOW = "requests_low"
        const val CHANNEL_NORMAL = "requests_normal"
        const val CHANNEL_HIGH = "requests_high"

        /** v0.1 の旧チャンネル。ensureChannels で削除する。 */
        const val CHANNEL_QUESTIONS = "questions"
        const val CHANNEL_NOTIFICATIONS = "notifications"

        private const val NOTIFICATION_ID = 1
    }
}
