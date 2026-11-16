package io.github.yusukeiwaki.oyobidashi.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.yusukeiwaki.oyobidashi.core.OyobidashiJson
import io.github.yusukeiwaki.oyobidashi.core.NotificationContent
import io.github.yusukeiwaki.oyobidashi.core.PairingInfo
import io.github.yusukeiwaki.oyobidashi.core.PairingParseResult
import io.github.yusukeiwaki.oyobidashi.core.PairingUri
import io.github.yusukeiwaki.oyobidashi.core.RelayException
import io.github.yusukeiwaki.oyobidashi.graph
import kotlinx.coroutines.launch

sealed interface Screen {
    data object List : Screen
    data class Detail(val requestId: String) : Screen
    data object Settings : Screen
}

class MainViewModel(app: Application) : AndroidViewModel(app) {
    val graph = app.graph
    val session = graph.session

    var screen by mutableStateOf<Screen>(Screen.List)

    // ---- ペアリング ----
    var pairingBusy by mutableStateOf(false)
        private set
    var pairingError by mutableStateOf<String?>(null)

    /** ディープリンクで受け取ったペアリング情報。意図しないサーバーに繋がないよう、必ず確認ダイアログを出す。 */
    var pendingLink by mutableStateOf<PairingInfo?>(null)

    // ---- ペアリング解除 ----
    var unpairBusy by mutableStateOf(false)
        private set
    var unpairError by mutableStateOf<String?>(null)

    fun onPairingLink(uri: String) {
        when (val result = PairingUri.parse(uri)) {
            is PairingParseResult.Success -> pendingLink = result.info
            is PairingParseResult.Failure -> pairingError = Texts.pairingError(result.error)
        }
    }

    /** QR 読み取り結果。oyobidashi のペアリングURIならペアリングを開始して true。 */
    fun onQrScanned(raw: String): Boolean {
        val result = PairingUri.parse(raw) as? PairingParseResult.Success ?: return false
        pair(result.info)
        return true
    }

    fun pairManually(url: String, code: String) {
        when (val result = PairingUri.fromManualInput(url, code)) {
            is PairingParseResult.Success -> pair(result.info)
            is PairingParseResult.Failure -> pairingError = Texts.pairingError(result.error)
        }
    }

    fun pair(info: PairingInfo) {
        if (pairingBusy) return
        pairingBusy = true
        pairingError = null
        viewModelScope.launch {
            try {
                graph.pair(info)
                screen = Screen.List
            } catch (e: RelayException) {
                pairingError = Texts.pairFailure(e)
            } finally {
                pairingBusy = false
            }
        }
    }

    fun unpair(force: Boolean) {
        if (unpairBusy) return
        unpairBusy = true
        unpairError = null
        viewModelScope.launch {
            try {
                graph.unpair(force)
                screen = Screen.List
            } catch (e: RelayException) {
                unpairError = Texts.unpairFailure(e)
            } finally {
                unpairBusy = false
            }
        }
    }

    /** @param contentJson 通知から開いた場合の通知内容。relay に届かなくても質問を表示できるようにする。 */
    fun openRequest(id: String, contentJson: String? = null) {
        if (contentJson != null) {
            try {
                val content = OyobidashiJson.decodeFromString(NotificationContent.serializer(), contentJson)
                if (content.requestId == id) session.value?.repository?.onPushReceived(content)
            } catch (e: Exception) {
                // 壊れた extra は無視して、通常どおり relay から取得する
            }
        }
        screen = Screen.Detail(id)
    }
}
