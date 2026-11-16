package io.github.yusukeiwaki.oyobidashi.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handleIntent(intent)
        setContent { OyobidashiTheme { AppRoot(viewModel) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        viewModel.graph.setForeground(true)
    }

    override fun onStop() {
        viewModel.graph.setForeground(false)
        super.onStop()
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val data = intent.data
        when {
            intent.action == Intent.ACTION_VIEW && data?.scheme.equals("oyobidashi", ignoreCase = true) ->
                viewModel.onPairingLink(data.toString())
            intent.action == ACTION_OPEN_REQUEST ->
                intent.getStringExtra(EXTRA_REQUEST_ID)?.let { viewModel.openRequest(it, intent.getStringExtra(EXTRA_CONTENT)) }
        }
    }

    companion object {
        const val ACTION_OPEN_REQUEST = "io.github.yusukeiwaki.oyobidashi.action.OPEN_REQUEST"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_CONTENT = "content"
    }
}

/** ポケベル調: 温かいクリーム、濃い墨、オレンジのアクセント、緑の液晶の欠片。 */
@Composable
fun OyobidashiTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) {
        darkColorScheme(
            primary = Color(0xFFFF8A4C),
            onPrimary = Color(0xFF3A1D00),
            primaryContainer = Color(0xFF5C2A0A),
            onPrimaryContainer = Color(0xFFFFDCC2),
            secondary = Color(0xFFD8CDB4),
            onSecondary = Color(0xFF23201A),
            secondaryContainer = Color(0xFF3A352A),
            onSecondaryContainer = Color(0xFFFFF6E5),
            tertiary = Color(0xFF7CFC9A),
            onTertiary = Color(0xFF0F2E1D),
            tertiaryContainer = Color(0xFF0F2E1D),
            onTertiaryContainer = Color(0xFF7CFC9A),
            background = Color(0xFF1A1712),
            onBackground = Color(0xFFFFF6E5),
            surface = Color(0xFF23201A),
            onSurface = Color(0xFFFFF6E5),
            surfaceVariant = Color(0xFF3A352A),
            onSurfaceVariant = Color(0xFFD8CDB4),
            outline = Color(0xFF5C5648),
            error = Color(0xFFFFB4AB),
            onError = Color(0xFF690005),
            errorContainer = Color(0xFF93000A),
            onErrorContainer = Color(0xFFFFDAD6),
        )
    } else {
        lightColorScheme(
            primary = Color(0xFFE8641B),
            onPrimary = Color(0xFFFFFFFF),
            primaryContainer = Color(0xFFFFDCC2),
            onPrimaryContainer = Color(0xFF5C2A0A),
            secondary = Color(0xFF5C5648),
            onSecondary = Color(0xFFFFFDF6),
            secondaryContainer = Color(0xFFF5EAD0),
            onSecondaryContainer = Color(0xFF23201A),
            tertiary = Color(0xFF1B5E20),
            onTertiary = Color(0xFFFFFFFF),
            tertiaryContainer = Color(0xFF0F2E1D),
            onTertiaryContainer = Color(0xFF7CFC9A),
            background = Color(0xFFFFF6E5),
            onBackground = Color(0xFF23201A),
            surface = Color(0xFFFFFDF6),
            onSurface = Color(0xFF23201A),
            surfaceVariant = Color(0xFFF5EAD0),
            onSurfaceVariant = Color(0xFF5C5648),
            outline = Color(0xFFD8CDB4),
            error = Color(0xFFBA1A1A),
            onError = Color(0xFFFFFFFF),
            errorContainer = Color(0xFFFFDAD6),
            onErrorContainer = Color(0xFF410002),
        )
    }
    MaterialTheme(colorScheme = colors, content = content)
}

@Composable
fun AppRoot(vm: MainViewModel) {
    val session by vm.session.collectAsState()
    val current = session

    if (current == null) {
        PairingScreen(vm)
    } else {
        when (val screen = vm.screen) {
            Screen.List -> RequestListScreen(vm, current)
            is Screen.Detail -> {
                BackHandler { vm.screen = Screen.List }
                RequestDetailScreen(vm, current, screen.requestId)
            }
            Screen.Settings -> {
                BackHandler { vm.screen = Screen.List }
                SettingsScreen(vm, current)
            }
            Screen.Pairing -> {
                BackHandler { vm.screen = Screen.Settings }
                PairingScreen(vm, onClose = { vm.screen = Screen.Settings })
            }
        }
    }

    vm.pendingLink?.let { info ->
        AlertDialog(
            onDismissRequest = { vm.pendingLink = null },
            title = { Text("ペアリングしますか?") },
            text = {
                Text(
                    "次の中継サーバーとペアリングします。\n\n${info.url}" +
                        if (current != null) "\n\n現在のペアリング (${current.credentials.baseUrl}) は解除されます。" else ""
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.pendingLink = null
                    vm.pair(info)
                }) { Text("ペアリング") }
            },
            dismissButton = { TextButton(onClick = { vm.pendingLink = null }) { Text("キャンセル") } },
        )
    }

    // ペアリング済みの状態でディープリンク経由の再ペアリングに失敗した場合のエラー表示
    if (current != null && vm.screen != Screen.Pairing) {
        vm.pairingError?.let { message ->
            AlertDialog(
                onDismissRequest = { vm.pairingError = null },
                title = { Text("ペアリングできませんでした") },
                text = { Text(message) },
                confirmButton = { TextButton(onClick = { vm.pairingError = null }) { Text("OK") } },
            )
        }
    }
}
