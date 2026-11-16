package io.github.yusukeiwaki.oyobidashi.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.speech.SpeechRecognizer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.yusukeiwaki.oyobidashi.Session
import io.github.yusukeiwaki.oyobidashi.core.Availability
import java.time.Instant
import java.time.temporal.ChronoUnit

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: MainViewModel, session: Session) {
    val state by session.repository.state.collectAsState()
    val presence by vm.graph.presence.collectAsState()
    val presenceError by vm.graph.presenceSyncError.collectAsState()
    var confirming by remember { mutableStateOf(false) }
    var noteDraft by remember(presence.note) { mutableStateOf(presence.note.orEmpty()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("設定") },
                navigationIcon = {
                    IconButton(onClick = { vm.screen = Screen.List }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("在席", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            Text(
                "取込中・離席中は通話がテキストになります。取込中は30分で自動的に応答可に戻ります。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            listOf(Availability.AVAILABLE, Availability.BUSY, Availability.AWAY).forEach { a ->
                val selected = presence.effectiveAvailability == a
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .selectable(
                            selected = selected,
                            onClick = {
                                when (a) {
                                    Availability.BUSY -> vm.graph.setPresence(
                                        Availability.BUSY,
                                        Instant.now().plus(30, ChronoUnit.MINUTES).toString(),
                                        noteDraft.takeIf { it.isNotBlank() },
                                    )
                                    else -> vm.graph.setPresence(a, note = noteDraft.takeIf { it.isNotBlank() })
                                }
                            },
                            role = Role.RadioButton,
                        )
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    RadioButton(selected = selected, onClick = null)
                    Column(Modifier.weight(1f)) {
                        Text(Texts.availabilityLabel(a), style = MaterialTheme.typography.bodyLarge)
                        Text(Texts.availabilityDescription(a), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (a == Availability.BUSY && selected) {
                            Texts.clock(presence.until).takeIf { it.isNotEmpty() }?.let {
                                Text("$it まで", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            OutlinedTextField(
                value = noteDraft,
                onValueChange = { noteDraft = it.take(200) },
                label = { Text("一言メモ (任意)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = {
                    val current = presence.effectiveAvailability
                    val until = if (current == Availability.BUSY) {
                        presence.until ?: Instant.now().plus(30, ChronoUnit.MINUTES).toString()
                    } else null
                    vm.graph.setPresence(current, until, noteDraft.takeIf { it.isNotBlank() })
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("メモを保存") }
            presenceError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Text("接続", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            Item("中継サーバー", session.credentials.baseUrl)
            Item("接続状態", if (state.relayUnreachable) Texts.UNREACHABLE else "接続できています")
            Item(
                "この端末",
                listOfNotNull(session.credentials.deviceName, session.credentials.deviceId).joinToString(" / ").ifEmpty { "-" },
            )
            Item(
                "プッシュ通知 (FCM)",
                if (vm.graph.pushTokens.available) "有効"
                else "無効 (Firebase 未設定)。アプリを開いている間だけ通知されます",
            )
            Item(
                "通知の許可",
                if (vm.graph.notifier.canPost()) "許可されています" else "許可されていません。端末の設定でこのアプリの通知を許可してください",
            )

            Text("通話", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            Item("音声認識", if (speechAvailable()) "利用できます" else "利用できません (この端末では通話がテキストになります)")
            Item("マイクの権限", if (micGranted()) "許可されています" else "許可されていません。通話の応答時に求めます")
            if (Build.VERSION.SDK_INT >= 34) {
                Item(
                    "全画面の着信表示",
                    if (fullScreenAllowed()) "許可されています" else "許可されていません。端末の設定で許可するとロック画面でも着信を表示します",
                )
            }

            OutlinedButton(
                onClick = { confirming = true },
                enabled = !vm.unpairBusy,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (vm.unpairBusy) "解除中…" else "ペアリングを解除") }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("ペアリングを解除しますか?") },
            text = { Text("この端末には質問が届かなくなります。再度使うにはペアリングし直してください。") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    vm.unpair(force = false)
                }) { Text("解除") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("キャンセル") } },
        )
    }

    vm.unpairError?.let { message ->
        AlertDialog(
            onDismissRequest = { vm.unpairError = null },
            title = { Text("解除できませんでした") },
            text = { Text(message) },
            confirmButton = {
                TextButton(onClick = { vm.unpair(force = true) }) { Text("この端末だけ解除") }
            },
            dismissButton = { TextButton(onClick = { vm.unpairError = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun Item(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun speechAvailable(): Boolean {
    val context = LocalContext.current
    return remember {
        try {
            SpeechRecognizer.isRecognitionAvailable(context)
        } catch (e: RuntimeException) {
            false
        }
    }
}

@Composable
private fun micGranted(): Boolean {
    val context = LocalContext.current
    return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
}

@Composable
private fun fullScreenAllowed(): Boolean {
    val context = LocalContext.current
    return remember {
        if (Build.VERSION.SDK_INT < 34) true
        else try {
            context.getSystemService(android.app.NotificationManager::class.java)?.canUseFullScreenIntent() ?: true
        } catch (e: RuntimeException) {
            true
        }
    }
}
