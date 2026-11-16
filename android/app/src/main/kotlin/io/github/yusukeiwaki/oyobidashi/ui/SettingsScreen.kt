package io.github.yusukeiwaki.oyobidashi.ui

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.speech.SpeechRecognizer
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.yusukeiwaki.oyobidashi.BuildConfig
import io.github.yusukeiwaki.oyobidashi.Session

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: MainViewModel, session: Session) {
    val state by session.repository.state.collectAsState()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var refresh by remember { mutableIntStateOf(0) }
    var confirming by remember { mutableStateOf(false) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh++
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val mic = remember(refresh) { ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
    val camera = remember(refresh) { ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED }
    val notifications = remember(refresh) { vm.graph.notifier.canPost() }
    val speech = remember(refresh) { runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false) }
    val fullScreen = remember(refresh) {
        Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() == true
    }
    fun appSettings() = openSettings(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("設定") },
            navigationIcon = {
                IconButton(onClick = { vm.screen = Screen.List }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                }
            },
        )
    }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionTitle("ペアリング")
            Item("接続先", session.credentials.baseUrl)
            Item("接続状態", if (state.relayUnreachable) Texts.UNREACHABLE else "接続できます")
            OutlinedButton(onClick = { vm.screen = Screen.Pairing }, modifier = Modifier.fillMaxWidth()) {
                Text("ペアリングし直す")
            }
            OutlinedButton(
                onClick = { confirming = true }, enabled = !vm.unpairBusy,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (vm.unpairBusy) "解除中…" else "ペアリングを解除") }

            SectionTitle("権限")
            PermissionRow("通知", if (notifications) "許可済み" else "未許可") {
                openSettings(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            }
            PermissionRow("マイク", if (mic) "許可済み" else "未許可", ::appSettings)
            PermissionRow("カメラ（QRコード）", if (camera) "許可済み" else "未許可", ::appSettings)
            PermissionRow("音声認識", if (speech) "利用できます" else "利用できません") {
                openSettings(context, Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
            }
            if (Build.VERSION.SDK_INT >= 34) {
                PermissionRow("全画面の着信表示", if (fullScreen) "許可済み" else "未許可") {
                    openSettings(context, Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
                }
            }
            Text("端末の設定で許可を変更すると、この画面にも反映されます。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Item("通知サービス", if (vm.graph.pushTokens.available) "利用できます" else "未設定（アプリを閉じている間は通知されません）")
            Item("バージョン", BuildConfig.VERSION_NAME)
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("ペアリングを解除しますか?") },
            text = { Text("この端末には質問が届かなくなります。") },
            confirmButton = { TextButton(onClick = { confirming = false; vm.unpair(force = false) }) { Text("解除") } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("キャンセル") } },
        )
    }
    vm.unpairError?.let { message ->
        AlertDialog(
            onDismissRequest = { vm.unpairError = null }, title = { Text("解除できませんでした") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { vm.unpair(force = true) }) { Text("この端末だけ解除") } },
            dismissButton = { TextButton(onClick = { vm.unpairError = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun Item(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun PermissionRow(title: String, status: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onClick, modifier = Modifier.semantics { contentDescription = "${title}の設定" }) { Text("設定") }
    }
}

private fun openSettings(context: Context, intent: Intent) {
    try {
        context.startActivity(intent)
    } catch (_: RuntimeException) {
        try {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        } catch (_: RuntimeException) {
            Toast.makeText(context, "端末の設定から権限を変更してください", Toast.LENGTH_LONG).show()
        }
    }
}
