import Foundation

public enum CallPresentation {
    /// CallKit has a caller name, but no separate subject/body field.
    public static func callerName(agentName: String?, subject: String?, fallbackName: String = "お呼び出し") -> String {
        let name = singleLine(agentName) ?? fallbackName
        guard let subject = singleLine(subject) else { return name }
        return "\(name)：\(subject)"
    }

    public static func singleLine(_ value: String?) -> String? {
        let text = value?.components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }.joined(separator: " ")
        return text?.isEmpty == false ? text : nil
    }
}

public enum CallEndReason: String, Equatable, Sendable {
    case remoteEnded
    case answeredElsewhere
    case declinedElsewhere
    case resolved
    case cancelled
    case expired
    case missed
    case failed
    case unknown
}

public enum CallReconcileAction: Equatable, Sendable {
    case reportRinging(call: CallSession, request: AgentRequest)
    /// Restore local UI after interruption; never report a new OS incoming call.
    case restoreActive(call: CallSession, request: AgentRequest)
    case endCall(callID: String, requestID: String, reason: CallEndReason)
    case none
}

/// 通話の二重報告防止とリモート終了判定 (純粋ロジック、CallKit 非依存でテスト可能)。
public final class CallReconciler: @unchecked Sendable {
    private let lock = NSLock()
    private var reportedCallIDs: Set<String> = []
    private var endedCallIDs: Set<String> = []
    private var callIDByRequestID: [String: String] = [:]

    public init() {}

    public var reported: Set<String> { lock.withLock { reportedCallIDs } }

    public func markReported(callID: String, requestID: String) {
        lock.withLock {
            reportedCallIDs.insert(callID)
            callIDByRequestID[requestID] = callID
        }
    }

    public func markEnded(callID: String) {
        lock.withLock {
            _ = endedCallIDs.insert(callID)
            reportedCallIDs.remove(callID)
        }
    }

    public func isReported(callID: String) -> Bool { lock.withLock { reportedCallIDs.contains(callID) } }
    public func hasEnded(callID: String) -> Bool { lock.withLock { endedCallIDs.contains(callID) } }

    public func reset() {
        lock.withLock {
            reportedCallIDs = []
            endedCallIDs = []
            callIDByRequestID = [:]
        }
    }

    /// VoIP Push 受信時: 同じ call を一度だけ報告する。
    public func shouldReportVoIP(callID: String) -> Bool {
        lock.withLock {
            guard !reportedCallIDs.contains(callID), !endedCallIDs.contains(callID) else { return false }
            return true
        }
    }

    public func reconcile(request: AgentRequest, myDeviceID: String?) -> CallReconcileAction {
        // 通話が無いが以前報告した request が終端になったら終了
        guard let call = request.call else {
            if request.status.isTerminal {
                let known: String? = lock.withLock { callIDByRequestID[request.id] }
                if let known, isReported(callID: known) {
                    markEnded(callID: known)
                    return .endCall(callID: known, requestID: request.id, reason: Self.endReason(for: request))
                }
            }
            return .none
        }
        lock.withLock { callIDByRequestID[request.id] = call.id }

        // 終端リクエストは常に終了が優先
        if request.status.isTerminal {
            guard isReported(callID: call.id) else { return .none }
            markEnded(callID: call.id)
            return .endCall(callID: call.id, requestID: request.id, reason: Self.endReason(for: request))
        }

        switch call.state {
        case .ended:
            guard isReported(callID: call.id) else { return .none }
            markEnded(callID: call.id)
            return .endCall(callID: call.id, requestID: request.id, reason: Self.endReason(forOutcome: call.outcome))
        case .active:
            if let owner = call.deviceID, let me = myDeviceID, !me.isEmpty, owner != me {
                guard isReported(callID: call.id) else { return .none }
                markEnded(callID: call.id)
                return .endCall(callID: call.id, requestID: request.id, reason: .answeredElsewhere)
            }
            if let owner = call.deviceID, let me = myDeviceID, !me.isEmpty, owner == me,
               !isReported(callID: call.id), !hasEnded(callID: call.id) {
                return .restoreActive(call: call, request: request)
            }
            return .none
        case .ringing:
            // 他端末が既に応答/所有している場合は鳴らさない
            if let owner = call.deviceID, let me = myDeviceID, !me.isEmpty, owner != me {
                if isReported(callID: call.id) {
                    markEnded(callID: call.id)
                    return .endCall(callID: call.id, requestID: request.id, reason: .answeredElsewhere)
                }
                return .none
            }
            if hasEnded(callID: call.id) { return .none }
            if isReported(callID: call.id) { return .none }
            return .reportRinging(call: call, request: request)
        case .unknown:
            return .none
        }
    }

    public func reconcileHello(requests: [AgentRequest], myDeviceID: String?) -> [CallReconcileAction] {
        // hello に含まれない報告済み通話は終了扱い (切断中に解決された)
        var actions: [CallReconcileAction] = []
        let liveIDs: Set<String> = Set(requests.compactMap { $0.call?.id })
        let snapshot: [(String, String)] = lock.withLock {
            callIDByRequestID.filter { reportedCallIDs.contains($0.value) }.map { ($0.key, $0.value) }
        }
        for (reqID, callID) in snapshot where !liveIDs.contains(callID) {
            // hello の pending にその request 自体が無ければ終了
            if !requests.contains(where: { $0.id == reqID }) {
                markEnded(callID: callID)
                actions.append(.endCall(callID: callID, requestID: reqID, reason: .remoteEnded))
            }
        }
        for req in requests {
            let a = reconcile(request: req, myDeviceID: myDeviceID)
            if a != .none { actions.append(a) }
        }
        return actions
    }

    static func endReason(for request: AgentRequest) -> CallEndReason {
        if let outcome = request.call?.outcome {
            return endReason(forOutcome: outcome)
        }
        switch request.status {
        case .answered: return .resolved
        case .cancelled: return .cancelled
        case .expired: return .expired
        default: return .remoteEnded
        }
    }

    static func endReason(forOutcome outcome: CallOutcome?) -> CallEndReason {
        switch outcome {
        case .resolved: return .resolved
        case .cancelled: return .cancelled
        case .expired: return .expired
        case .missed: return .missed
        case .declined: return .declinedElsewhere
        case .hangup: return .remoteEnded
        case .failed: return .failed
        case .unknown, nil: return .remoteEnded
        }
    }
}

/// 会話ターン送信ポリシー: 部分結果は絶対に送らない。
public enum ConversationPolicy {
    public static func grantsSpokenConsent(text: String, isFinal: Bool) -> Bool {
        guard isFinal else { return false }
        let phrase = text.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        return phrase == "同意します"
    }

    public static func shouldSendTurn(text: String, isFinal: Bool) -> Bool {
        guard isFinal else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    /// resolved のときだけ、最終返答を読み上げた後に通話を終了する。
    public static func shouldEndAfterSpeaking(resolved: Bool?) -> Bool {
        resolved == true
    }
}

/// 通知の割り込みレベル (契約: low=passive, normal=active, high/urgent=timeSensitive)。
public enum NotificationInterruption: String, Equatable, Sendable {
    case passive, active, timeSensitive
}

public enum NotificationPolicy {
    public static func interruption(for priority: RequestPriority) -> NotificationInterruption {
        switch priority {
        case .low: return .passive
        case .normal: return .active
        case .high, .urgent: return .timeSensitive
        case .unknown: return .active
        }
    }
    public static func interruption(for request: AgentRequest) -> NotificationInterruption {
        // priority があれば優先。無ければ urgency=high を timeSensitive 扱い (後方互換)。
        if request.priority == .unknown("") {
            return request.urgency == .high ? .timeSensitive : .active
        }
        // デフォルト normal の場合でも urgency high は上げる
        if request.priority == .normal && request.urgency == .high {
            return .timeSensitive
        }
        return interruption(for: request.priority)
    }
    public static func isActionsMode(_ request: AgentRequest) -> Bool {
        request.isActionsEligible
    }
    /// 配信済み/保留中通知の中から userInfo.request_id が一致する identifier を返す (APNs identifier は任意)。
    public static func matchingIdentifiers(delivered: [(identifier: String, userInfo: [AnyHashable: Any])], requestIDs: Set<String>) -> [String] {
        guard !requestIDs.isEmpty else { return [] }
        var result: [String] = []
        for item in delivered {
            if requestIDs.contains(item.identifier) {
                result.append(item.identifier)
                continue
            }
            if let rid = item.userInfo["request_id"] as? String, requestIDs.contains(rid) {
                result.append(item.identifier)
            }
        }
        return result
    }
    /// 終端状態なら通知を (再)提示しない。非同期レースで古い通知が復活するのを防ぐ。
    public static func shouldPresent(request: AgentRequest) -> Bool {
        request.status == .pending || request.status == .notified
    }
}
