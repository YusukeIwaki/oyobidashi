package me.oyobidashi.android.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant
import java.util.UUID

/** 回答欄の下書き。[dictated] は音声入力由来のテキストが入っていること (送信時 `input_method: voice`)。 */
@kotlinx.serialization.Serializable
data class Draft(
    val text: String = "",
    val dictated: Boolean = false,
    /** 発話確定から結果確認まで保持し、プロセス再起動後も同じ UUID で復旧する。 */
    val voiceTurnId: String? = null,
    val voiceCallId: String? = null,
) {
    /** キーボードでの編集。音声入力後の手直しは voice のまま。空にしたらリセット。 */
    fun edited(newText: String): Draft = when {
        newText.isEmpty() -> Draft()
        newText == text -> this
        else -> copy(text = newText, voiceTurnId = null, voiceCallId = null)
    }

    /** 音声認識結果 (途中結果含む) を反映。 */
    fun dictated(newText: String): Draft = if (newText.isEmpty()) Draft() else Draft(newText, dictated = true)

    val inputMethod: InputMethod get() = if (dictated) InputMethod.VOICE else InputMethod.TEXT
}

enum class AnswerError {
    /** 409: 他の端末で回答済み、取消、期限切れ */
    ALREADY_RESOLVED,

    /** 通信失敗・タイムアウト (下書きは保持、再送可能) */
    NETWORK,

    /** 400 / 空文字 / 長すぎる */
    INVALID,

    /** 404 */
    NOT_FOUND,

    /** その他 (5xx など。再送可能) */
    SERVER,
}

enum class RefreshError { NETWORK, SERVER }

/** 下書きの永続化先 (通知からの返信失敗時など、プロセスをまたいで入力を失わないため)。 */
interface DraftStore {
    fun loadAll(): Map<String, Draft>
    fun put(requestId: String, draft: Draft)
    fun remove(requestId: String)
    fun clear()
    /** バックグラウンド保存を完了させる。呼び出し側のスレッドをブロックしない。 */
    suspend fun flush() {}
}

class InMemoryDraftStore(initial: Map<String, Draft> = emptyMap()) : DraftStore {
    private val map = java.util.concurrent.ConcurrentHashMap(initial)
    override fun loadAll(): Map<String, Draft> = map.toMap()
    override fun put(requestId: String, draft: Draft) { map[requestId] = draft }
    override fun remove(requestId: String) { map.remove(requestId) }
    override fun clear() = map.clear()
}

data class RequestsState(
    /** 未回答 (pending) が先頭、その後に履歴。それぞれ created_at 降順。 */
    val requests: List<Request> = emptyList(),
    val drafts: Map<String, Draft> = emptyMap(),
    val submitting: Set<String> = emptySet(),
    val answerErrors: Map<String, AnswerError> = emptyMap(),
    val refreshing: Boolean = false,
    val refreshError: RefreshError? = null,
    /** 401 を受けた。資格情報を消してペアリング画面に戻るべき状態。 */
    val signedOut: Boolean = false,
    /**
     * 中継サーバーに届かない (同一LAN外にいる等)。サインアウトでも一般的なエラーでもない「通常ありうる状態」。
     * 下書きは保持され、WebSocket 再接続・一覧取得・回答送信のいずれかが成功した時点で false に戻る。
     */
    val relayUnreachable: Boolean = false,
    val homeNotice: HomeNotice? = null,
    /** 一覧取得か WebSocket の hello で、未回答の有無を確認した。 */
    val inboxLoaded: Boolean = false,
) {
    val pending: List<Request> get() = requests.filter { it.isPending }
    val history: List<Request> get() = requests.filterNot { it.isPending }
    fun find(id: String): Request? = requests.firstOrNull { it.id == id }
    fun draft(id: String): Draft = drafts[id] ?: Draft()
}

sealed interface AnswerOutcome {
    data class Success(val request: Request) : AnswerOutcome
    data class Failed(val error: AnswerError) : AnswerOutcome
    data object SignedOut : AnswerOutcome

    /** すでに送信中だったので何もしなかった */
    data object Ignored : AnswerOutcome
}

/**
 * 画面の状態ロジック (Android 非依存)。WebSocket イベント・一覧取得・回答送信を1つの状態にまとめる。
 *
 * マージ規則: 同じ id は `updated_at` が古くないものだけ採用し、終端状態から pending には戻さない
 * (遅れて届いたイベントや重複イベントで状態が巻き戻らない)。
 */
class RequestsRepository(
    private val api: RelayApi,
    private val notifier: RequestNotifier,
    /** 401 を受けた時に1度だけ呼ばれる (資格情報の削除など)。 */
    private val onSignedOut: () -> Unit = {},
    private val draftStore: DraftStore = InMemoryDraftStore(),
) {
    private val _state = MutableStateFlow(RequestsState(drafts = draftStore.loadAll().filterValues { it != Draft() }))
    val state: StateFlow<RequestsState> = _state.asStateFlow()

    // ---- イベント ----

    fun onEvent(event: RelayEvent) {
        when (event) {
            is RelayEvent.Hello -> replacePending(event.pending, event.homeNotice)
            is RelayEvent.HomeNoticeUpdated -> _state.update { it.copy(homeNotice = event.notice) }
            is RelayEvent.RequestCreated -> {
                val isNew = _state.value.find(event.request.id) == null
                applyRequest(event.request)
                // フォアグラウンド中は FCM なしでも鳴るようにローカル通知を出す (重複イベントでは出し直さない)。
                // 生きた通話は CallManager がネイティブ通話通知を出すので通常通知は出さない。
                if (isNew && !event.request.isLiveCall &&
                    (event.request.isAnswerable || event.request.kind != RequestKind.QUESTION)
                ) {
                    notifier.show(NotificationContent.fromRequest(event.request))
                }
            }
            is RelayEvent.RequestUpdated -> applyRequest(event.request)
            RelayEvent.Pong -> Unit
        }
    }

    /** hello: サーバーの pending 一覧が正。手元で pending のままのものは解決済みなので取り除く (履歴は [refresh] で補う)。 */
    private fun replacePending(pending: List<Request>, notice: HomeNotice?) {
        val ids = pending.map { it.id }.toSet()
        val dropped = mutableListOf<String>()
        _state.update { s ->
            dropped.clear()
            val kept = s.requests.filter { r ->
                val keep = !r.isPending || r.id in ids
                if (!keep) dropped += r.id
                keep
            }
            s.copy(requests = sorted(merge(kept, pending)), homeNotice = notice, inboxLoaded = true)
        }
        dropped.forEach { notifier.cancel(it) }
        pending.filter(::shouldDismissNotification).forEach { notifier.cancel(it.id) }
    }

    /** 回答済み・取消等の通知は消す。未取消のお知らせ (notified) は維持する。 */
    fun applyRequest(request: Request) {
        _state.update { it.copy(requests = sorted(merge(it.requests, listOf(request)))) }
        _state.value.find(request.id)?.let {
            if (shouldDismissNotification(it)) notifier.cancel(it.id)
        }
    }

    private fun shouldDismissNotification(request: Request): Boolean =
        !request.isPending && !(request.kind == RequestKind.NOTIFICATION && request.status == RequestStatus.NOTIFIED)

    /**
     * Push (FCM) や通知タップで知った質問を、relay に届かなくても (LAN 外でも) 表示・下書きできるよう
     * 仮の pending Request として登録する。すでに知っている id なら何もしない。
     * 後から届く本物のデータ (hello / 一覧 / イベント) で置き換わる。
     * 終端 push / サイレント push は何も足さない (取り消し側で処理する)。
     */
    fun onPushReceived(content: NotificationContent) {
        if (!content.isQuestion || _state.value.signedOut) return
        if (content.isTerminalPush) return
        _state.update { s ->
            if (s.find(content.requestId) != null) s
            else s.copy(
                requests = sorted(
                    s.requests + Request(
                        id = content.requestId, kind = content.kind, question = content.body,
                        choices = content.choices.ifEmpty { null }, urgency = content.urgency,
                        status = content.status ?: RequestStatus.PENDING,
                        priority = content.priority, deliveryMode = content.deliveryMode,
                    )
                )
            )
        }
    }

    // ---- 到達性 ----

    /** WebSocket の接続状態を反映する。 */
    fun onConnectionState(connection: ConnectionState) {
        when (connection) {
            ConnectionState.CONNECTED -> markReachable()
            ConnectionState.WAITING_TO_RECONNECT -> markUnreachable()
            else -> Unit
        }
    }

    private fun markUnreachable() = _state.update { if (it.signedOut) it else it.copy(relayUnreachable = true) }

    /** relay から何らかの応答が得られた。圏外由来のエラー表示を消す (下書きはそのまま)。 */
    private fun markReachable() = _state.update { s ->
        if (!s.relayUnreachable) s
        else s.copy(
            relayUnreachable = false,
            answerErrors = s.answerErrors.filterValues { it != AnswerError.NETWORK },
            refreshError = s.refreshError.takeIf { it != RefreshError.NETWORK },
        )
    }

    // ---- 一覧取得 ----

    suspend fun refresh(limit: Int = 100) {
        if (_state.value.signedOut) return
        _state.update { it.copy(refreshing = true) }
        try {
            val list = api.listRequests(status = null, limit = limit)
            markReachable()
            _state.update {
                it.copy(requests = sorted(merge(it.requests, list)), refreshing = false, refreshError = null, inboxLoaded = true)
            }
            _state.value.requests.filter(::shouldDismissNotification).forEach { notifier.cancel(it.id) }
        } catch (e: RelayException) {
            noteReachability(e)
            if (e.isUnauthorized) {
                handleUnauthorized()
            } else {
                val error = if (e is RelayException.Network) RefreshError.NETWORK else RefreshError.SERVER
                _state.update { it.copy(refreshing = false, refreshError = error) }
            }
        } finally {
            _state.update { if (it.refreshing) it.copy(refreshing = false) else it }
        }
    }

    // ---- 下書き ----

    fun editDraft(id: String, text: String) = updateDraft(id) { it.edited(text) }
    fun dictateDraft(id: String, text: String) = updateDraft(id) { it.dictated(text) }

    /** ネットワークに渡す前に確定発話と idempotency key を永続化する。 */
    fun beginVoiceTurn(id: String, callId: String, text: String, recoveredTurnId: String? = null): CallEventBody {
        val saved = state.value.draft(id)
        val savedTurnId = saved.voiceTurnId?.takeIf { saved.voiceCallId == callId && saved.text == text }
        val turnId = savedTurnId
            ?: recoveredTurnId ?: UUID.randomUUID().toString()
        updateDraft(id) { Draft(text, dictated = true, voiceTurnId = turnId, voiceCallId = callId) }
        return CallEventBody(CallEvent.TURN, text, turnId = turnId, async = true, resumeTurn = savedTurnId != null || recoveredTurnId != null)
    }

    /** 待機中にユーザーが編集した別の下書きは消さない。 */
    fun completeVoiceTurn(id: String, turnId: String?) {
        updateDraft(id) { if (turnId != null && it.voiceTurnId == turnId) Draft() else it }
    }

    /** 確定した失敗の次は新しい ID で明示的に再試行できる。発話は消さない。 */
    fun failVoiceTurn(id: String, turnId: String?) {
        updateDraft(id) { if (turnId != null && it.voiceTurnId == turnId) it.copy(voiceTurnId = null) else it }
    }

    suspend fun flushVoiceDraft(turnId: String?) {
        try {
            draftStore.flush()
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Exception) {
            throw RelayException.VoiceTurn(turnId.orEmpty(), "failed", "local_storage_failed")
        }
    }

    private fun updateDraft(id: String, transform: (Draft) -> Draft) {
        _state.update { s ->
            val next = transform(s.draft(id))
            s.copy(drafts = if (next == Draft()) s.drafts - id else s.drafts + (id to next))
        }
        val saved = _state.value.drafts[id]
        if (saved == null) draftStore.remove(id) else draftStore.put(id, saved)
    }

    private fun noteReachability(e: RelayException) {
        if (e is RelayException.Network) markUnreachable() else if (e is RelayException.Api) markReachable()
    }

    fun clearAnswerError(id: String) = _state.update { it.copy(answerErrors = it.answerErrors - id) }

    // ---- 回答 ----

    /** 下書きを送信する (`input_method` は text / voice)。 */
    suspend fun submitDraft(id: String): AnswerOutcome {
        val draft = _state.value.draft(id)
        return submit(id, AnswerBody(draft.text.trim(), null, draft.inputMethod))
    }

    /** 選択肢ボタン (`input_method: choice`)。 */
    suspend fun submitChoice(id: String, choiceIndex: Int): AnswerOutcome {
        val choice = _state.value.find(id)?.choices?.getOrNull(choiceIndex)
            ?: return failed(id, AnswerError.INVALID)
        return submit(id, AnswerBody(choice, choiceIndex, InputMethod.CHOICE))
    }

    suspend fun submitItems(id: String, replies: List<ItemReply>): AnswerOutcome =
        submit(id, AnswerBody("", inputMethod = InputMethod.TEXT, itemAnswers = replies))

    private suspend fun submit(id: String, body: AnswerBody): AnswerOutcome {
        if (_state.value.signedOut) return AnswerOutcome.SignedOut
        if (body.itemAnswers == null && (body.text.isEmpty() || body.text.length > AnswerLimits.MAX_TEXT_LENGTH))
            return failed(id, AnswerError.INVALID)
        var started = false
        _state.update { s ->
            started = id !in s.submitting
            if (started) s.copy(submitting = s.submitting + id, answerErrors = s.answerErrors - id) else s
        }
        if (!started) return AnswerOutcome.Ignored
        try {
            val request = api.answer(id, body)
            markReachable()
            updateDraft(id) { Draft() }
            applyRequest(request)
            // レスポンスが古い/不完全でも、回答済みであることは確実
            if (_state.value.find(id)?.isPending == true) markResolved(id)
            return AnswerOutcome.Success(request)
        } catch (e: RelayException) {
            noteReachability(e)
            return when {
                e.isUnauthorized -> {
                    handleUnauthorized()
                    AnswerOutcome.SignedOut
                }
                e.isAlreadyResolved -> {
                    // 実際の状態 (誰かの回答 / 取消 / 期限切れ) を取り直す。取れなければ「解決済み(詳細不明)」にする。
                    val latest = try {
                        api.getRequest(id)
                    } catch (inner: RelayException) {
                        if (inner.isUnauthorized) {
                            handleUnauthorized()
                            return AnswerOutcome.SignedOut
                        }
                        null
                    }
                    if (latest != null) applyRequest(latest)
                    if (_state.value.find(id)?.isPending == true) markResolved(id)
                    notifier.cancel(id)
                    failed(id, AnswerError.ALREADY_RESOLVED)
                }
                e is RelayException.Network -> failed(id, AnswerError.NETWORK)
                e is RelayException.Api && e.code == ErrorCode.NOT_FOUND -> failed(id, AnswerError.NOT_FOUND)
                e is RelayException.Api && (e.code == ErrorCode.INVALID_REQUEST || e.code == ErrorCode.PAYLOAD_TOO_LARGE) ->
                    failed(id, AnswerError.INVALID)
                else -> failed(id, AnswerError.SERVER)
            }
        } finally {
            _state.update { it.copy(submitting = it.submitting - id) }
        }
    }

    private fun failed(id: String, error: AnswerError): AnswerOutcome {
        _state.update { it.copy(answerErrors = it.answerErrors + (id to error)) }
        return AnswerOutcome.Failed(error)
    }

    private fun markResolved(id: String) {
        _state.update { s ->
            s.copy(requests = sorted(s.requests.map { if (it.id == id && it.isPending) it.copy(status = RequestStatus.UNKNOWN) else it }))
        }
    }

    /** 401 を受けた (REST / WebSocket どちらでも)。冪等。 */
    fun handleUnauthorized() {
        var first = false
        _state.update { s ->
            first = !s.signedOut
            RequestsState(signedOut = true)
        }
        if (first) {
            draftStore.clear()
            notifier.cancelAll()
            onSignedOut()
        }
    }

    companion object {
        internal fun merge(current: List<Request>, incoming: List<Request>): List<Request> {
            val map = LinkedHashMap<String, Request>()
            current.forEach { map[it.id] = it }
            for (r in incoming) {
                val existing = map[r.id]
                if (existing == null || shouldReplace(existing, r)) map[r.id] = r
            }
            return map.values.toList()
        }

        internal fun shouldReplace(existing: Request, incoming: Request): Boolean {
            if (!existing.isPending && incoming.isPending) return false
            if (existing.isPending && !incoming.isPending) return true
            val old = existing.updatedInstant
            val new = incoming.updatedInstant
            return old == null || new == null || !new.isBefore(old)
        }

        internal fun sorted(requests: List<Request>): List<Request> =
            requests.sortedWith(
                compareByDescending<Request> { it.isPending }
                    .thenByDescending { it.createdInstant ?: Instant.EPOCH }
                    .thenByDescending { it.id }
            )
    }
}
