import Foundation

public enum PushCategory {
    public static let question = "OYOBIDASHI_QUESTION"
    public static let notification = "OYOBIDASHI_NOTIFICATION"
    public static let actions = "OYOBIDASHI_ACTIONS"
    /// 通知から直接返信する `UNTextInputNotificationAction` の identifier。
    public static let replyAction = "OYOBIDASHI_REPLY"
    public static let choiceActionPrefix = "OYOBIDASHI_CHOICE_"
    public static func choiceActionIdentifier(index: Int) -> String { "\(choiceActionPrefix)\(index)" }
    public static func choiceIndex(fromActionIdentifier identifier: String) -> Int? {
        guard identifier.hasPrefix(choiceActionPrefix) else { return nil }
        return Int(identifier.dropFirst(choiceActionPrefix.count))
    }
    public static func actionsCategoryIdentifier(requestID: String) -> String { "OYOBIDASHI_ACTIONS_\(requestID)" }
    public static let threadID = "oyobidashi"
}

/// VoIP Push (PushKit) ペイロード。新規 ringing 通話専用。
public struct VoIPPayload: Equatable, Sendable {
    public var requestID: String
    public var callID: String
    public var question: String?
    public init(requestID: String, callID: String, question: String? = nil) {
        self.requestID = requestID
        self.callID = callID
        self.question = question
    }
    public init?(userInfo: [AnyHashable: Any]) {
        guard let rid = userInfo["request_id"] as? String, !rid.isEmpty,
              let cid = userInfo["call_id"] as? String, !cid.isEmpty else { return nil }
        requestID = rid
        callID = cid
        question = userInfo["question"] as? String
    }
}

/// APNs ペイロード (または同じ形で組み立てたローカル通知の userInfo) から取り出した情報。
public struct PushPayload: Equatable, Sendable {
    public var requestID: String
    public var kind: RequestKind
    public var title: String?
    public var body: String?
    public var category: String?
    public var callID: String?
    public var question: String?

    public init(requestID: String, kind: RequestKind, title: String? = nil, body: String? = nil, category: String? = nil, callID: String? = nil, question: String? = nil) {
        self.requestID = requestID
        self.kind = kind
        self.title = title
        self.body = body
        self.category = category
        self.callID = callID
        self.question = question
    }

    /// `request_id` (空でない文字列) が無ければ nil。それ以外の欠落・型不一致は許容する。
    /// `kind` が無い場合は category から推定し、それも無ければ `question`。
    public init?(userInfo: [AnyHashable: Any]) {
        guard let requestID = userInfo["request_id"] as? String, !requestID.isEmpty else { return nil }
        self.requestID = requestID

        let aps = userInfo["aps"] as? [AnyHashable: Any]
        category = aps?["category"] as? String
        if let alert = aps?["alert"] as? [AnyHashable: Any] {
            title = alert["title"] as? String
            body = alert["body"] as? String
        } else if let alert = aps?["alert"] as? String {
            title = nil
            body = alert
        } else {
            title = nil
            body = nil
        }

        if let kind = userInfo["kind"] as? String, !kind.isEmpty {
            self.kind = RequestKind(raw: kind)
        } else if category == PushCategory.notification {
            self.kind = .notification
        } else {
            self.kind = .question
        }
        callID = userInfo["call_id"] as? String
        question = userInfo["question"] as? String
    }

    /// ローカル通知に載せる userInfo (APNs と同じキー)。
    public static func userInfo(for request: AgentRequest) -> [String: Any] {
        var info: [String: Any] = ["request_id": request.id, "kind": request.kind.rawValue]
        info["delivery_mode"] = request.deliveryMode.rawValue
        info["priority"] = request.priority.rawValue
        if let call = request.call {
            info["call_id"] = call.id
        }
        if !request.effectiveChoices.isEmpty {
            info["choices"] = request.effectiveChoices
        }
        return info
    }
}

public enum APNsToken {
    /// APNs デバイストークンを小文字16進文字列にする。
    public static func hexString(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

/// 契約 §6 の通知文面 (WebSocket 経由で受けた request をアプリ側で通知にするとき用)。
public enum NotificationText {
    public static func title(for request: AgentRequest) -> String {
        let suffix = request.kind == .notification ? "お知らせ" : "質問"
        if let name = request.agent?.name, !name.isEmpty {
            return "\(name) からの\(suffix)"
        }
        return "エージェントからの\(suffix)"
    }

    public static func body(for request: AgentRequest) -> String {
        String(request.question.prefix(1000))
    }
}
