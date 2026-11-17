import AVFoundation
import CallKit
import OyobidashiKit
import Observation
import PushKit
import UIKit

/// CallKit + PushKit の統合。シミュレータでは CallKit が使えないため、その場合は
/// OS の通話 UI が動いたふりをせず、アプリ内通話画面 (InAppCallView) にフォールバックする。
@MainActor
@Observable
final class CallKitCoordinator: NSObject, IncomingCallHandling {
    /// CallKit が実際に使えるか (シミュレータでは false)。
    nonisolated static var isCallKitAvailable: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return true
        #endif
    }

    private(set) var activeCallUUID: UUID?
    private(set) var activeRequestID: String?
    /// 最後に CallKit 報告が失敗した理由 (フォールバック表示用)。
    private(set) var lastReportError: String?

    @ObservationIgnored private let provider: CXProvider
    @ObservationIgnored private let callController = CXCallController()
    @ObservationIgnored private let pushRegistry: PKPushRegistry
    @ObservationIgnored private weak var model: AppModel?
    @ObservationIgnored let voice = VoiceConversationController()
    @ObservationIgnored private var uuidByCallID: [String: UUID] = [:]
    @ObservationIgnored private var requestIDByUUID: [UUID: String] = [:]
    @ObservationIgnored private var callIDByUUID: [UUID: UUID] = [:]
    @ObservationIgnored private var pendingInitialReply: String?
    @ObservationIgnored private var audioActivated = false
    @ObservationIgnored private var answeredCallIDs: Set<String> = []

    override init() {
        let config = CXProviderConfiguration(localizedName: "お呼び出し")
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        provider = CXProvider(configuration: config)
        pushRegistry = PKPushRegistry(queue: .main)
        super.init()
        provider.setDelegate(self, queue: nil)
        pushRegistry.delegate = self
        voice.onRequestEndCall = { [weak self] in
            guard let self, let requestID = self.activeRequestID else { return }
            self.model?.finishVoiceCall(requestID: requestID)
            if let callID = self.uuidByCallID.first(where: { $0.value == self.activeCallUUID })?.key {
                self.handleCallEnded(callID: callID, requestID: requestID, reason: .resolved)
            } else {
                self.voice.endConversation()
                self.activeRequestID = nil
            }
        }
        voice.onConversationFailed = { [weak self] _ in
            guard let self, let requestID = self.activeRequestID else { return }
            Task { await self.model?.failCall(requestID: requestID) }
            if let uuid = self.activeCallUUID {
                let action = CXEndCallAction(call: uuid)
                self.callController.request(CXTransaction(action: action)) { _ in }
            } else if let model = self.model {
                model.fallbackCallRequest = nil
            }
        }
    }

    func attach(model: AppModel) {
        self.model = model
        voice.attach(model: model)
        model.incomingCallHandler = self
        // VoIP Push 登録 (通常の APNs とは別系統)。
        pushRegistry.desiredPushTypes = [.voIP]
    }

    // MARK: IncomingCallHandling

    func handleIncomingCall(_ call: CallSession, request: AgentRequest) {
        guard Self.isCallKitAvailable else {
            // OS UI は使えない。アプリ内画面で受ける。
            model?.fallbackCallRequest = request
            return
        }
        let uuid = uuid(for: call.id, requestID: request.id)
        // 既に同じ通話がアクティブなら二重に報告しない。
        guard activeCallUUID != uuid else { return }
        activeCallUUID = uuid
        activeRequestID = request.id
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: request.agent?.name ?? "エージェント")
        update.localizedCallerName = request.incomingCallerName
        update.hasVideo = false
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let error, !Self.isAlreadyReported(error) {
                    // 報告失敗 → アプリ内画面にフォールバック (OS UI が出たふりはしない)。
                    self.lastReportError = error.localizedDescription
                    self.activeCallUUID = nil
                    self.activeRequestID = nil
                    self.model?.fallbackCallRequest = request
                    Task { _ = await self.model?.failCall(requestID: request.id) }
                } else {
                    self.lastReportError = nil
                }
            }
        }
    }

    func handleCallEnded(callID: String, requestID: String, reason: CallEndReason) {
        #if DEBUG
        print("[oyobidashi.callkit] ended request=\(requestID) reason=\(reason)")
        #endif
        voice.endConversation()
        answeredCallIDs.remove(callID)
        pendingInitialReply = nil
        audioActivated = false
        guard let uuid = uuidByCallID[callID] else {
            if model?.fallbackCallRequest?.id == requestID { model?.fallbackCallRequest = nil }
            activeRequestID = nil
            return
        }
        defer {
            uuidByCallID.removeValue(forKey: callID)
            requestIDByUUID.removeValue(forKey: uuid)
            callIDByUUID.removeValue(forKey: uuid)
            if activeCallUUID == uuid { activeCallUUID = nil; activeRequestID = nil }
        }
        guard Self.isCallKitAvailable else { return }
        // 既に通話が確立している場合はトランザクションで終了、そうでなければ reportCall で終了を伝える。
        let cxReason: CXCallEndedReason
        switch reason {
        case .answeredElsewhere: cxReason = .answeredElsewhere
        case .declinedElsewhere: cxReason = .declinedElsewhere
        case .missed: cxReason = .unanswered
        case .failed: cxReason = .failed
        default: cxReason = .remoteEnded
        }
        provider.reportCall(with: uuid, endedAt: Date(), reason: cxReason)
    }

    func handleCallFallbackNeeded(_ call: CallSession, request: AgentRequest) {
        model?.fallbackCallRequest = request
    }

    // MARK: Helpers

    /// A PushKit callback must still report its call. If WebSocket already reported
    /// the same UUID, CallKit's duplicate response confirms that the native call exists.
    private static func isAlreadyReported(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == CXErrorDomainIncomingCall
            && error.code == CXErrorCodeIncomingCallError.Code.callUUIDAlreadyExists.rawValue
    }

    private func uuid(for callID: String, requestID: String) -> UUID {
        if let existing = uuidByCallID[callID] { return existing }
        let uuid = UUID(uuidString: callID) ?? UUID()
        uuidByCallID[callID] = uuid
        requestIDByUUID[uuid] = requestID
        callIDByUUID[uuid] = uuid
        return uuid
    }

    func endActiveCallViaSystem() {
        guard let uuid = activeCallUUID else { return }
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
    }

    /// アプリ内フォールバックで応答したときに会話を開始する。
    func startFallbackConversation(request: AgentRequest, initialReply: String) async {
        activeRequestID = request.id
        if let call = request.call { answeredCallIDs.insert(call.id) }
        await voice.startConversation(requestID: request.id, initialText: initialReply.isEmpty ? request.question : initialReply, usesCallKitAudio: false)
    }
}

// MARK: - CXProviderDelegate

extension CallKitCoordinator: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor [weak self] in
            self?.voice.endConversation()
            self?.activeCallUUID = nil
            self?.activeRequestID = nil
            self?.uuidByCallID = [:]
            self?.requestIDByUUID = [:]
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        #if DEBUG
        print("[oyobidashi.callkit] answer_action")
        #endif
        let uuid = action.callUUID
        Task { @MainActor [weak self] in
            guard let self, let requestID = self.requestIDByUUID[uuid], let model = self.model else {
                action.fail()
                return
            }
            self.activeCallUUID = uuid
            self.activeRequestID = requestID
            let outcome = await model.answerCall(requestID: requestID)
            switch outcome {
            case .success(let resp):
                if let call = resp.call { self.answeredCallIDs.insert(call.id) }
                // The system's compact incoming banner does not open a call screen
                // after answering while our app is foregrounded. Present our controls.
                model.fallbackCallRequest = resp.request
                self.pendingInitialReply = resp.reply ?? resp.request.question
                action.fulfill()
                // didActivate が既に来ていれば会話を開始。まだなら didActivate で開始。
                if self.audioActivated, let reply = self.pendingInitialReply {
                    self.pendingInitialReply = nil
                    await self.voice.startConversation(requestID: requestID, initialText: reply, usesCallKitAudio: true)
                }
            case .unauthorized, .unreachable, .failed:
                action.fail()
                // 応答できなかった通話は終了として伝える。
                provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
                self.activeCallUUID = nil
                self.activeRequestID = nil
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        #if DEBUG
        print("[oyobidashi.callkit] end_action")
        #endif
        let uuid = action.callUUID
        Task { @MainActor [weak self] in
            guard let self else { action.fulfill(); return }
            let requestID = self.requestIDByUUID[uuid] ?? self.activeRequestID
            let callID = self.uuidByCallID.first(where: { $0.value == uuid })?.key
            let wasAnswered = callID.map { self.answeredCallIDs.contains($0) } ?? false
            self.voice.endConversation()
            self.pendingInitialReply = nil
            self.audioActivated = false
            // マッピング掃除
            if let callID {
                self.answeredCallIDs.remove(callID)
                self.uuidByCallID.removeValue(forKey: callID)
            }
            self.requestIDByUUID.removeValue(forKey: uuid)
            self.callIDByUUID.removeValue(forKey: uuid)
            if self.activeCallUUID == uuid { self.activeCallUUID = nil; self.activeRequestID = nil }
            action.fulfill()
            guard let requestID, let model = self.model else { return }
            // 未応答の終了は decline、応答後の終了は hangup。
            if wasAnswered {
                _ = await model.hangupCall(requestID: requestID)
            } else {
                _ = await model.declineCall(requestID: requestID)
            }
            if model.fallbackCallRequest?.id == requestID { model.fallbackCallRequest = nil }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor [weak self] in
            self?.voice.setMuted(action.isMuted)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        #if DEBUG
        print("[oyobidashi.callkit] audio_activated")
        #endif
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.audioActivated = true
            // CallKit が有効化したセッション上で音声会話を動かす。カテゴリは通話用に寄せる。
            try? audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
            if let reply = self.pendingInitialReply, let requestID = self.activeRequestID {
                self.pendingInitialReply = nil
                await self.voice.startConversation(requestID: requestID, initialText: reply, usesCallKitAudio: true)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor [weak self] in
            self?.audioActivated = false
            self?.voice.endConversation()
        }
    }
}

// MARK: - PKPushRegistryDelegate

extension CallKitCoordinator: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = APNsToken.hexString(from: pushCredentials.token)
        Task { @MainActor [weak self] in
            await self?.model?.setVoipToken(token)
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        Task { @MainActor [weak self] in
            await self?.model?.clearVoipToken()
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        MainActor.assumeIsolated {
            receiveVoip(payload.dictionaryPayload, type: type, completion: completion)
        }
    }

    private func receiveVoip(_ dict: [AnyHashable: Any], type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        #if DEBUG
        print("[oyobidashi.callkit] voip_received")
        #endif
        let payload = VoIPPayload(userInfo: dict)
        let expectedCredentials = model?.credentials
        let accepted = expectedCredentials != nil && PushRecipient(userInfo: dict).matches(currentDeviceID: expectedCredentials?.deviceID)
        if !accepted {
            // PushKit requires reporting every VoIP push to CallKit. Report a fresh
            // generic call and end it without associating it with the active user.
            // Never reuse a stale payload's UUID, which could end a current call.
            guard Self.isCallKitAvailable else { completion(); return }
            let rejectedID = UUID()
            let rejected = CXCallUpdate()
            rejected.remoteHandle = CXHandle(type: .generic, value: "お呼び出し")
            rejected.localizedCallerName = "お呼び出し"
            provider.reportNewIncomingCall(with: rejectedID, update: rejected) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.provider.reportCall(with: rejectedID, endedAt: Date(), reason: .remoteEnded)
                    completion()
                }
            }
            return
        }
        let callUUID = payload.flatMap { UUID(uuidString: $0.callID) } ?? UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: payload?.agentName ?? "お呼び出し")
        update.localizedCallerName = payload?.incomingCallerName ?? "お呼び出し"
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        if let payload {
            // Stable call UUID lets CallKit deduplicate a WebSocket/push race.
            model?.markVoIPCallReported(callID: payload.callID, requestID: payload.requestID)
            uuidByCallID[payload.callID] = callUUID
            requestIDByUUID[callUUID] = payload.requestID
            activeCallUUID = callUUID
            activeRequestID = payload.requestID
        }
        if Self.isCallKitAvailable {
            provider.reportNewIncomingCall(with: callUUID, update: update) { [weak self] error in
                completion()
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard self.model?.credentials == expectedCredentials else {
                        self.provider.reportCall(with: callUUID, endedAt: Date(), reason: .remoteEnded)
                        return
                    }
                    guard let payload else {
                        self.provider.reportCall(with: callUUID, endedAt: Date(), reason: .failed)
                        return
                    }
                    self.model?.activate()
                    _ = await self.model?.refreshRequest(id: payload.requestID)
                    if let error, !Self.isAlreadyReported(error) {
                        self.lastReportError = error.localizedDescription
                        // Duplicate-call errors must not erase the existing system call.
                        if let request = self.model?.store.request(id: payload.requestID), request.hasLiveCall {
                            self.model?.fallbackCallRequest = request
                        }
                    } else {
                        self.lastReportError = nil
                        if self.activeCallUUID == callUUID,
                           let request = self.model?.store.request(id: payload.requestID), request.hasLiveCall {
                            let refreshed = CXCallUpdate()
                            refreshed.localizedCallerName = CallPresentation.callerName(agentName: request.agent?.name, subject: request.subject)
                            self.provider.reportCall(with: callUUID, updated: refreshed)
                        }
                    }
                }
            }
        } else {
            completion()
            guard let payload else { return }
            model?.activate()
            Task { [weak self] in
                guard let self else { return }
                _ = await self.model?.refreshRequest(id: payload.requestID)
                if let request = self.model?.store.request(id: payload.requestID), request.hasLiveCall {
                    self.model?.fallbackCallRequest = request
                }
            }
        }
    }
}
