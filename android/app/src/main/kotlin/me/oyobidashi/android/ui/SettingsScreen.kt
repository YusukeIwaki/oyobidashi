package me.oyobidashi.android.ui

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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import me.oyobidashi.android.BuildConfig
import me.oyobidashi.android.R
import me.oyobidashi.android.Session

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: MainViewModel, session: Session) {
    val state by session.repository.state.collectAsState()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    var refresh by remember { mutableIntStateOf(0) }
    var confirming by remember { mutableStateOf(false) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val mic = remember(refresh) { ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
    val camera = remember(refresh) { ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED }
    val notifications = remember(refresh) { vm.graph.notifier.canPost() }
    val speech = remember(refresh) { runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false) }
    val fullScreen = remember(refresh) { Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() == true }
    fun appSettings() = openSettings(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text("設定") }, scrollBehavior = scrollBehavior,
                navigationIcon = {
                    IconButton(onClick = vm::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                Modifier.widthIn(max = 640.dp).fillMaxSize(),
                contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                item { SectionHeading("ペアリング") }
                item {
                    SettingsGroup {
                        ListItem(
                            headlineContent = { Text("接続先") },
                            supportingContent = {
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    SelectionContainer { Text(session.credentials.baseUrl, maxLines = 2) }
                                    Text(if (state.relayUnreachable) "接続できません" else "接続できます",
                                        color = if (state.relayUnreachable) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                        style = MaterialTheme.typography.labelMedium)
                                }
                            },
                            leadingContent = { Icon(painterResource(R.drawable.ic_computer), null, Modifier.size(24.dp)) },
                            trailingContent = { TextButton(onClick = vm::openPairing) { Text("変更") } },
                            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        )
                        TextButton(
                            onClick = { confirming = true }, enabled = !vm.unpairBusy,
                            modifier = Modifier.padding(start = 56.dp, bottom = 8.dp),
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        ) { Text(if (vm.unpairBusy) "解除中…" else "ペアリングを解除") }
                    }
                }
                item { SectionHeading("権限") }
                item {
                    SettingsGroup {
                        PermissionItem("通知", notifications, R.drawable.ic_notification) {
                            openSettings(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                        }
                        PermissionItem("マイク", mic, R.drawable.ic_mic, ::appSettings)
                        PermissionItem("カメラ（QRコード）", camera, R.drawable.ic_camera, ::appSettings)
                        SettingsItem("音声認識", if (speech) "利用できます" else "利用できません", icon = { Icon(painterResource(R.drawable.ic_mic), null) }) {
                            openSettings(context, Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
                        }
                        if (Build.VERSION.SDK_INT >= 34) {
                            PermissionItem("全画面の着信表示", fullScreen, R.drawable.ic_fullscreen) {
                                openSettings(context, Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
                            }
                        }
                    }
                }
                item {
                    Text("項目をタップすると端末の設定が開きます。変更した権限は、戻るとこの画面に反映されます。",
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                item { SectionHeading("アプリについて") }
                item {
                    SettingsGroup {
                        SettingsItem("通知サービス", if (vm.graph.pushTokens.available) "利用できます" else "未設定・バックグラウンドでの受信には設定が必要です",
                            icon = { Icon(Icons.Default.Notifications, null) })
                        SettingsItem("バージョン", BuildConfig.VERSION_NAME, icon = { Icon(Icons.Default.Info, null) })
                    }
                }
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false }, title = { Text("ペアリングを解除しますか?") },
            text = { Text("この端末には質問が届かなくなります。") },
            confirmButton = { TextButton(onClick = { confirming = false; vm.unpair(force = false) }) { Text("解除") } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("キャンセル") } },
        )
    }
    vm.unpairError?.let { message ->
        AlertDialog(
            onDismissRequest = { vm.unpairError = null }, title = { Text("解除できませんでした") }, text = { Text(message) },
            confirmButton = { TextButton(onClick = { vm.unpair(force = true) }) { Text("この端末だけ解除") } },
            dismissButton = { TextButton(onClick = { vm.unpairError = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun PermissionItem(title: String, allowed: Boolean, icon: Int, onClick: () -> Unit) {
    SettingsItem(title, if (allowed) "許可済み" else "未許可", icon = { Icon(painterResource(icon), null, Modifier.size(24.dp)) },
        onClick = onClick)
}

@Composable
private fun SettingsItem(title: String, subtitle: String, icon: @Composable () -> Unit,
                         onClick: (() -> Unit)? = null) {
    ListItem(
        modifier = if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = "端末の設定を開く", onClick = onClick) else Modifier,
        headlineContent = { Text(title) },
        supportingContent = { Text(subtitle) },
        leadingContent = icon,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

private fun openSettings(context: Context, intent: Intent) {
    try { context.startActivity(intent) }
    catch (_: RuntimeException) {
        try { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }
        catch (_: RuntimeException) { Toast.makeText(context, "端末の設定から権限を変更してください", Toast.LENGTH_LONG).show() }
    }
}
