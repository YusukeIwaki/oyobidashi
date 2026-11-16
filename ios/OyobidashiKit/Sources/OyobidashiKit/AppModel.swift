import Foundation
import Observation

public enum AnswerOutcome: Equatable, Sendable {
    case answered(AgentRequest)
    /// 409: すでに回答済み・取消・期限切れ (または notification)
    case alreadyResolved
    case notFound
    /// 401: ペアリングが無効。サインアウト済み。
    case unauthorized
    /// 中継サーバーに届かなかった (圏外)。下書きを保持して後で送り直す。
    case unreachable
    case failed(RelayError)
}

@MainActor
public protocol AnswerSubmitting: AnyObject {
    func submitAnswer(requestID: String, body: AnswerBody) async -> AnswerOutcome
}

/// CallKit / アプリ内通話画面への橋渡し。Kit は OS 通話 UI に依存しない。
@MainActor
public protocol IncomingCallHandling: AnyObject {
    func handleIncomingCall(_ call: CallSession, request: AgentRequest)
    func handleCallEnded(callID: String, requestID: String, reason: CallEndReason)
    /// CallKit が使えない (シミュレータ等) ときのアプリ内フォールバック。
    func handleCallFallbackNeeded(_ call: CallSession, request: AgentRequest)
}

public extension IncomingCallHandling {
    func handleCallFallbackNeeded(_ call: CallSession, request: AgentRequest) {}
}

/// 通話アクションの抽象。テストでは fake に差し替える。デフォルト実装で既存 mock は壊れない。
@MainActor
public protocol CallActionPerforming: AnyObject {
    func performCallAction(requestID: String, body: CallEventBody) async -> CallActionOutcome
}

public enum CallActionOutcome: Equatable, Sendable {
    case success(CallActionResponse)
    case unauthorized
    case unreachable
    case failed(RelayError)
}

public enum SignedOutReason: Equatable, Sendable {
    /// ユーザーがペアリングを解除した
    case userRequested
    /// サーバーが 401 を返した (トークン失効・サーバー側で解除)
    case unauthorized
}

public enum PairingState: Equatable, Sendable {
    case idle
    case pairing
    case failed(RelayError)
}

public struct AppModelConfiguration: Sendable {
    public var deviceName: String
    public var pushEnvironment: PushEnvironment
    public var listLimit: Int

    public init(deviceName: String, pushEnvironment: PushEnvironment, listLimit: Int = 100) {
        self.deviceName = deviceName
        self.pushEnvironment = pushEnvironment
        self.listLimit = listLimit
    }
}

/// アプリ全体の状態 (ペアリング・一覧・イベント接続・Push トークン登録・回答送信) をまとめる。
@MainActor
@Observable
public final class AppModel: AnswerSubmitting {
    public enum Phase: Equatable, Sendable {
        case unpaired
        case paired(Credentials)
    }

    public typealias StreamFactory = @MainActor (RelayEndpoint, String) -> any EventStreaming

    public private(set) var phase: Phase = .unpaired
    public private(set) var signedOutReason: SignedOutReason?
    public private(set) var pairingState: PairingState = .idle
    public let store: RequestListStore
    public let drafts: DraftStore
    public let callReconciler = CallReconciler()
    @ObservationIgnored private var sendingVoiceRequests: Set<String> = []
    @ObservationIgnored private var finishingVoiceRequests: Set<String> = []
    public private(set) var presenceAvailability: PresenceAvailability = .available
    public private(set) var presenceUntil: Date?
    public private(set) var presenceNote: String?
    public private(set) var presenceError: RelayError?
    public private(set) var isUpdatingPresence = false
    /// アプリ内に表示する通話。CallKit応答後の操作画面と、利用不可時の着信代替画面で共有する。
    public var fallbackCallRequest: AgentRequest?
    @ObservationIgnored public weak var incomingCallHandler: (any IncomingCallHandling)?

    @ObservationIgnored private let credentialStore: any CredentialStore
    @ObservationIgnored private let transport: any HTTPTransport
    @ObservationIgnored private let streamFactory: StreamFactory
    @ObservationIgnored private let notifications: (any NotificationManaging)?
    @ObservationIgnored private let configuration: AppModelConfiguration

    @ObservationIgnored private var stream: (any EventStreaming)?
    @ObservationIgnored private var streamGeneration = 0
    @ObservationIgnored private var pushToken: String?
    @ObservationIgnored private var registeredPushToken: String?
    @ObservationIgnored private var voipToken: String?
    @ObservationIgnored private var registeredVoipToken: String?

    public init(
        credentialStore: any CredentialStore,
        transport: any HTTPTransport = URLSessionTransport(),
        configuration: AppModelConfiguration,
        notifications: (any NotificationManaging)? = nil,
        draftPersistence: any DraftPersistence = InMemoryDraftPersistence(),
        streamFactory: StreamFactory? = nil
    ) {
        self.credentialStore = credentialStore
        self.transport = transport
        self.configuration = configuration
        self.notifications = notifications
        self.streamFactory = streamFactory ?? { endpoint, token in
            EventStreamClient(endpoint: endpoint, deviceToken: token)
        }
        let drafts = DraftStore(persistence: draftPersistence)
        self.drafts = drafts
        self.store = RequestListStore(notifications: notifications, drafts: drafts)
        // 読み出し失敗 (Keychain エラー等) は未ペアリング扱い。
        if let credentials = try? credentialStore.load() {
            phase = .paired(credentials)
        }
    }

    public var credentials: Credentials? {
        if case .paired(let credentials) = phase { return credentials }
        return nil
    }

    public var isPaired: Bool { credentials != nil }

    public var isStreaming: Bool { stream != nil }

    private var client: RelayClient? {
        credentials.map { RelayClient(endpoint: $0.endpoint, deviceToken: $0.deviceToken, transport: transport) }
    }

    // MARK: Pairing

    /// `POST /v1/pair` を呼び、成功したら接続情報を保存する。
    /// すでにペアリング済みだった場合、成功後に古いデバイス登録を best-effort で削除する。
    @discardableResult
    public func pair(_ info: PairingInfo) async -> Bool {
        guard pairingState != .pairing else { return false }
        pairingState = .pairing
        let previous = credentials
        let tokenAtRequest = pushToken
        let body = PairRequestBody(
            code: info.code, deviceName: configuration.deviceName, platform: .ios,
            pushToken: tokenAtRequest, pushEnvironment: configuration.pushEnvironment
        )
        do {
            let response = try await RelayClient(endpoint: info.endpoint, deviceToken: nil, transport: transport).pair(body)
            let new = Credentials(endpoint: info.endpoint, deviceToken: response.deviceToken, deviceID: response.device.id)
            do {
                try credentialStore.save(new)
            } catch {
                // 保存できないと次回起動時に使えないが、今回のセッションは続行する。
            }
            let wasStreaming = stream != nil
            stopStream()
            store.reset()
            phase = .paired(new)
            signedOutReason = nil
            pairingState = .idle
            registeredPushToken = tokenAtRequest
            if let previous, previous.deviceToken != new.deviceToken {
                try? await RelayClient(endpoint: previous.endpoint, deviceToken: previous.deviceToken, transport: transport).deleteDevice()
            }
            if wasStreaming { activate() }
            await registerPushTokenIfNeeded()
            await registerVoipTokenIfNeeded()
            return true
        } catch {
            pairingState = .failed(RelayError.wrap(error))
            return false
        }
    }

    public func clearPairingError() {
        if case .failed = pairingState { pairingState = .idle }
    }

    /// ペアリング解除。サーバーへの `DELETE /v1/devices/me` は best-effort で、失敗してもローカルの情報は必ず消す。
    public func unpair() async {
        let client = self.client
        signOut(reason: .userRequested)
        try? await client?.deleteDevice()
    }

    private func signOut(reason: SignedOutReason) {
        guard isPaired else { return }
        stopStream()
        try? credentialStore.clear()
        phase = .unpaired
        signedOutReason = reason
        registeredPushToken = nil
        registeredVoipToken = nil
        callReconciler.reset()
        fallbackCallRequest = nil
        presenceAvailability = .available
        presenceUntil = nil
        presenceNote = nil
        presenceError = nil
        store.reset()
        drafts.removeAll()
        notifications?.removeAllDelivered()
    }

    // MARK: Push token

    /// APNs トークン (16進) を受け取ったら呼ぶ。ペアリング済みなら `PUT /v1/devices/me` で登録する。
    public func setPushToken(_ hexToken: String) async {
        pushToken = hexToken
        await registerPushTokenIfNeeded()
    }

    private func registerPushTokenIfNeeded() async {
        guard let client, let pushToken, pushToken != registeredPushToken else { return }
        do {
            _ = try await client.updateDevice(
                DeviceUpdateBody(pushToken: .set(pushToken), pushEnvironment: configuration.pushEnvironment)
            )
            registeredPushToken = pushToken
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            if relayError == .unauthorized { signOut(reason: .unauthorized) }
            // それ以外は次回の activate / refresh で再試行する。
        }
    }

    /// PushKit VoIP トークン (16進) を受け取ったら呼ぶ。通常 push_token とは独立した `voip_token` で登録する。
    public func setVoipToken(_ hexToken: String) async {
        voipToken = hexToken
        await registerVoipTokenIfNeeded()
    }

    public func clearVoipToken() async {
        voipToken = nil
        guard let client, registeredVoipToken != nil else { registeredVoipToken = nil; return }
        do {
            _ = try await client.updateDevice(DeviceUpdateBody(voipToken: .clear, pushEnvironment: configuration.pushEnvironment))
            registeredVoipToken = nil
        } catch {
            // ベストエフォート
        }
    }

    private func registerVoipTokenIfNeeded() async {
        guard let client, let voipToken, voipToken != registeredVoipToken else { return }
        do {
            _ = try await client.updateDevice(
                DeviceUpdateBody(voipToken: .set(voipToken), pushEnvironment: configuration.pushEnvironment)
            )
            registeredVoipToken = voipToken
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            if relayError == .unauthorized { signOut(reason: .unauthorized) }
        }
    }

    // MARK: Presence

    public var myDeviceID: String? { credentials?.deviceID }

    @discardableResult
    public func updatePresence(availability: PresenceAvailability, until: Date? = nil, note: String? = nil) async -> Bool {
        guard let client else { return false }
        // 楽観的に反映し、失敗したらエラー表示 (値は保持して再試行可能にする)
        let previousAvailability = presenceAvailability
        let previousUntil = presenceUntil
        presenceAvailability = availability
        presenceUntil = until
        presenceNote = note
        isUpdatingPresence = true
        presenceError = nil
        defer { isUpdatingPresence = false }
        let body = PresenceUpdateBody(
            availability: availability,
            until: until.map { .set($0) } ?? .clear,
            note: note.map { .set($0) } ?? .clear
        )
        do {
            _ = try await client.updatePresence(body)
            noteReachable()
            return true
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            presenceError = relayError
            if relayError == .unauthorized {
                signOut(reason: .unauthorized)
            } else {
                // 圏外時は楽観値を保持 (次回再送できるようエラーだけ残す)
                _ = previousAvailability; _ = previousUntil
            }
            return false
        }
    }

    @discardableResult
    public func setBusyFor30Minutes(now: Date = Date()) async -> Bool {
        await updatePresence(availability: .busy, until: now.addingTimeInterval(30 * 60))
    }

    public func effectivePresenceAvailability(now: Date = Date()) -> PresenceAvailability {
        if presenceAvailability == .available { return .available }
        if let presenceUntil, presenceUntil <= now { return .available }
        return presenceAvailability
    }

    // MARK: Call reconcile & actions

    /// ストア取り込み後に通話状態を CallKit 側へ伝える。
    public func reconcileCalls(for request: AgentRequest) {
        if shouldFinishSpeaking(request) { return }
        let action = callReconciler.reconcile(request: request, myDeviceID: myDeviceID)
        applyCallAction(action, request: request)
    }

    public func reconcileCalls(for requests: [AgentRequest]) {
        for action in callReconciler.reconcileHello(requests: requests.map { req in
            guard shouldFinishSpeaking(req) else { return req }
            var speaking = req
            speaking.status = .pending
            speaking.call?.state = .active
            return speaking
        }, myDeviceID: myDeviceID) {
            switch action {
            case .reportRinging(let call, let req):
                callReconciler.markReported(callID: call.id, requestID: req.id)
                if let handler = incomingCallHandler {
                    handler.handleIncomingCall(call, request: req)
                } else {
                    fallbackCallRequest = req
                }
            case .endCall(let callID, let reqID, let reason):
                if fallbackCallRequest?.id == reqID { fallbackCallRequest = nil }
                incomingCallHandler?.handleCallEnded(callID: callID, requestID: reqID, reason: reason)
            case .none:
                break
            }
        }
    }

    private func applyCallAction(_ action: CallReconcileAction, request: AgentRequest) {
        switch action {
        case .reportRinging(let call, let req):
            callReconciler.markReported(callID: call.id, requestID: req.id)
            if let handler = incomingCallHandler {
                handler.handleIncomingCall(call, request: req)
            } else {
                fallbackCallRequest = req
            }
        case .endCall(let callID, let reqID, let reason):
            if fallbackCallRequest?.id == reqID { fallbackCallRequest = nil }
            incomingCallHandler?.handleCallEnded(callID: callID, requestID: reqID, reason: reason)
        case .none:
            break
        }
    }

    /// VoIP Push から直接報告する経路。`completion` 相当の後処理は呼び出し側 (PushKit) が必ず行う。
    /// 戻り値: 新規に報告すべきなら true。
    public func shouldReportVoIPCall(callID: String, requestID: String) -> Bool {
        callReconciler.shouldReportVoIP(callID: callID)
    }

    public func markVoIPCallReported(callID: String, requestID: String) {
        callReconciler.markReported(callID: callID, requestID: requestID)
    }

    public func performCallAction(requestID: String, body: CallEventBody) async -> CallActionOutcome {
        guard let client else { return .unauthorized }
        do {
            let resp = try await client.callAction(requestID: requestID, body: body)
            if isPaired {
                store.upsert(resp.request)
                reconcileCalls(for: resp.request)
            }
            noteReachable()
            return .success(resp)
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            switch relayError {
            case .unauthorized:
                signOut(reason: .unauthorized)
                return .unauthorized
            default:
                return relayError.isUnreachable ? .unreachable : .failed(relayError)
            }
        }
    }

    public func answerCall(requestID: String) async -> CallActionOutcome {
        await performCallAction(requestID: requestID, body: CallEventBody(event: .answer))
    }
    public func declineCall(requestID: String) async -> CallActionOutcome {
        await performCallAction(requestID: requestID, body: CallEventBody(event: .decline))
    }
    public func hangupCall(requestID: String) async -> CallActionOutcome {
        await performCallAction(requestID: requestID, body: CallEventBody(event: .hangup))
    }
    public func sendCallTurn(requestID: String, text: String) async -> CallActionOutcome {
        sendingVoiceRequests.insert(requestID)
        defer { sendingVoiceRequests.remove(requestID) }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed(.invalidRequest(message: "empty turn")) }
        let outcome = await performCallAction(requestID: requestID, body: CallEventBody(event: .turn, text: trimmed))
        if case .success = outcome { return outcome }
        if store.request(id: requestID)?.isAnswerable == true {
            drafts.set(AnswerDraft(text: trimmed, usedVoice: true), for: requestID)
        }
        return outcome
    }
    private func shouldFinishSpeaking(_ request: AgentRequest) -> Bool {
        guard request.status == .answered, request.call?.outcome == .resolved,
              request.call?.deviceID == myDeviceID,
              sendingVoiceRequests.contains(request.id) || finishingVoiceRequests.contains(request.id) else { return false }
        finishingVoiceRequests.insert(request.id)
        return true
    }

    /// The response and WebSocket update may arrive in either order. The local voice owner
    /// finishes the acknowledgement before ending its own call UI.
    public func finishVoiceCall(requestID: String) {
        sendingVoiceRequests.remove(requestID)
        finishingVoiceRequests.remove(requestID)
        if let callID = store.request(id: requestID)?.call?.id { callReconciler.markEnded(callID: callID) }
        if fallbackCallRequest?.id == requestID { fallbackCallRequest = nil }
    }

    public func refreshPresence() async {
        guard let client else { return }
        do {
            let response = try await client.getPresence()
            if let own = response.devices.first(where: { $0.deviceID == myDeviceID }) {
                presenceAvailability = own.availability
                presenceUntil = own.until
                presenceNote = own.note
            }
        } catch { /* The last explicitly shared availability remains visible while offline. */ }
    }

    public func failCall(requestID: String) async -> CallActionOutcome {
        await performCallAction(requestID: requestID, body: CallEventBody(event: .failed))
    }

    /// 通知の選択肢アクションから正確な choice_index で回答する。
    @discardableResult
    public func submitChoiceFromNotification(requestID: String, choiceIndex: Int) async -> AnswerOutcome {
        guard let request = store.request(id: requestID) else {
            // 手元に無い場合は取得してから判定
            if let fetched = await refreshRequest(id: requestID) {
                let choices = fetched.effectiveChoices
                guard choices.indices.contains(choiceIndex) else { return .failed(.invalidRequest(message: "choice_index out of range")) }
                return await submitAnswer(requestID: requestID, body: AnswerBody(text: choices[choiceIndex], choiceIndex: choiceIndex, inputMethod: .choice))
            }
            return .notFound
        }
        let choices = request.effectiveChoices
        guard choices.indices.contains(choiceIndex) else {
            return .failed(.invalidRequest(message: "choice_index out of range"))
        }
        return await submitAnswer(requestID: requestID, body: AnswerBody(text: choices[choiceIndex], choiceIndex: choiceIndex, inputMethod: .choice))
    }

    // MARK: Foreground lifecycle

    /// フォアグラウンドに来たら呼ぶ: WebSocket を接続し、一覧を再取得する。
    public func activate() {
        guard let credentials else { return }
        if stream == nil {
            streamGeneration += 1
            let generation = streamGeneration
            let stream = streamFactory(credentials.endpoint, credentials.deviceToken)
            self.stream = stream
            store.connection = .connecting
            stream.start { [weak self] signal in
                await self?.handle(signal, generation: generation)
            }
        }
        Task {
            await refresh()
            await refreshPresence()
            await registerPushTokenIfNeeded()
            await registerVoipTokenIfNeeded()
        }
    }

    /// ネットワーク経路が変わった (Wi‑Fi に戻った等) ら呼ぶ: バックオフを待たずに接続し直し、一覧を再取得する。
    /// フォアグラウンドで接続中のときだけ動く。
    public func connectivityChanged() {
        guard isPaired, stream != nil else { return }
        stopStream()
        activate()
    }

    /// 応答が返ってきた = 中継サーバーに届いている。
    private func noteReachable() {
        if isPaired { store.reachability = .reachable }
    }

    private func noteFailure(_ error: RelayError) {
        guard isPaired else { return }
        if error.isUnreachable {
            store.reachability = .unreachable
        } else if error != .cancelled {
            // HTTP の応答は返ってきている。
            store.reachability = .reachable
        }
    }

    /// バックグラウンドに回ったら呼ぶ: WebSocket を切断する。
    public func deactivate() {
        // A VoIP call keeps its signaling connection while the system call UI is active.
        guard !store.requests.contains(where: { $0.hasLiveCall }) else { return }
        stopStream()
    }

    private func stopStream() {
        stream?.stop()
        stream = nil
        streamGeneration += 1
        store.connection = .disconnected
    }

    func handle(_ signal: EventStreamSignal, generation: Int) async {
        guard generation == streamGeneration, stream != nil else { return }
        switch signal {
        case .state(.connecting):
            store.connection = .connecting
        case .state(.connected):
            store.connection = .connected
            store.reachability = .reachable
            // 圏外の間に登録できなかった Push トークンを送り直す。
            await registerPushTokenIfNeeded()
            await registerVoipTokenIfNeeded()
        case .state(.waiting(let retryIn, _)):
            store.connection = .reconnecting(retryIn: retryIn)
            store.reachability = .unreachable
        case .state(.unauthorized):
            signOut(reason: .unauthorized)
        case .event(let event):
            // 通話リコンサイルはストア反映の前後どちらでも冪等。先に判定材料を取る。
            store.apply(event)
            switch event {
            case .hello(let pending):
                reconcileCalls(for: pending)
                // 切断中に解決されたものを履歴に反映する。
                await refresh()
            case .created(let req), .updated(let req):
                reconcileCalls(for: req)
            case .pong, .unknown:
                break
            }
        }
    }

    // MARK: Requests

    /// `GET /v1/requests` で一覧を再取得する。
    public func refresh() async {
        guard let client else { return }
        store.loadState = .loading
        do {
            let list = try await client.listRequests(limit: configuration.listLimit)
            guard isPaired else { return }
            store.merge(list)
            reconcileCalls(for: list)
            store.loadState = .idle
            noteReachable()
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            if relayError == .unauthorized {
                signOut(reason: .unauthorized)
            } else if isPaired {
                // 圏外は「読み込み失敗」ではなく reachability で表す (手元の一覧はそのまま見せる)。
                store.loadState = relayError.isUnreachable ? .idle : .failed(relayError)
            }
        }
    }

    /// 1件だけ取得して反映する (Push 受信時・通知タップ時)。
    @discardableResult
    public func refreshRequest(id: String) async -> AgentRequest? {
        guard let client else { return nil }
        do {
            let request = try await client.getRequest(id: id)
            guard isPaired else { return nil }
            store.upsert(request)
            reconcileCalls(for: request)
            noteReachable()
            return store.request(id: id)
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            switch relayError {
            case .unauthorized: signOut(reason: .unauthorized)
            case .notFound: store.remove(id: id)
            default: break
            }
            return nil
        }
    }

    public func submitAnswer(requestID: String, body: AnswerBody) async -> AnswerOutcome {
        guard let client else { return .unauthorized }
        do {
            let request = try await client.answer(requestID: requestID, body: body)
            if isPaired { store.upsert(request) }
            noteReachable()
            return .answered(request)
        } catch {
            let relayError = RelayError.wrap(error)
            noteFailure(relayError)
            switch relayError {
            case .alreadyResolved:
                // まず手元で解決済み扱いにし、可能ならサーバー上の最終状態を取り直す。
                store.markResolvedLocally(id: requestID)
                await refreshRequest(id: requestID)
                return .alreadyResolved
            case .notFound:
                store.remove(id: requestID)
                return .notFound
            case .unauthorized:
                signOut(reason: .unauthorized)
                return .unauthorized
            default:
                return relayError.isUnreachable ? .unreachable : .failed(relayError)
            }
        }
    }

    /// 通知の返信アクション (テキスト入力) から回答する。バックグラウンドで呼ばれる。
    ///
    /// 送れなかった場合 (圏外など) は入力内容をその request の下書きとして保存し、
    /// 「送信できなかった」ことをローカル通知で知らせる。入力したものは失われない。
    @discardableResult
    public func submitNotificationReply(requestID: String, text: String) async -> AnswerOutcome {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed(.invalidRequest(message: "empty reply")) }
        guard isPaired else {
            notifications?.presentReplyFailure(requestID: requestID, reason: .signedOut)
            return .unauthorized
        }
        let outcome = await submitAnswer(requestID: requestID, body: AnswerBody(text: trimmed, choiceIndex: nil, inputMethod: .text))
        switch outcome {
        case .answered:
            break
        case .unreachable:
            drafts.set(AnswerDraft(text: trimmed, usedVoice: false), for: requestID)
            notifications?.presentReplyFailure(requestID: requestID, reason: .unreachable)
        case .failed:
            drafts.set(AnswerDraft(text: trimmed, usedVoice: false), for: requestID)
            notifications?.presentReplyFailure(requestID: requestID, reason: .failed)
        case .alreadyResolved, .notFound:
            notifications?.presentReplyFailure(requestID: requestID, reason: .alreadyResolved)
        case .unauthorized:
            notifications?.presentReplyFailure(requestID: requestID, reason: .signedOut)
        }
        return outcome
    }
}
