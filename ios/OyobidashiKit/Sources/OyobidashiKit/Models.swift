import Foundation

// MARK: - Open string enums

/// 契約上の列挙値。未知の値を受け取ってもデコードに失敗せず `.unknown(生の文字列)` として保持する (前方互換)。
public protocol OpenStringEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
    init(raw: String)
}

extension OpenStringEnum {
    public init?(rawValue: String) { self.init(raw: rawValue) }

    public init(from decoder: Decoder) throws {
        self.init(raw: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum RequestKind: OpenStringEnum {
    case question, notification
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "question": self = .question
        case "notification": self = .notification
        default: self = .unknown(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .question: return "question"
        case .notification: return "notification"
        case .unknown(let raw): return raw
        }
    }
}

public enum Urgency: OpenStringEnum {
    case normal, high
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "normal": self = .normal
        case "high": self = .high
        default: self = .unknown(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .normal: return "normal"
        case .high: return "high"
        case .unknown(let raw): return raw
        }
    }
}

public enum RequestStatus: OpenStringEnum {
    case pending, answered, cancelled, expired, notified
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "pending": self = .pending
        case "answered": self = .answered
        case "cancelled": self = .cancelled
        case "expired": self = .expired
        case "notified": self = .notified
        default: self = .unknown(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: return "pending"
        case .answered: return "answered"
        case .cancelled: return "cancelled"
        case .expired: return "expired"
        case .notified: return "notified"
        case .unknown(let raw): return raw
        }
    }

    /// 契約で終端と定義されている状態。未知の状態は終端とはみなさない (が、回答可能ともみなさない)。
    public var isTerminal: Bool {
        switch self {
        case .answered, .cancelled, .expired, .notified: return true
        case .pending, .unknown: return false
        }
    }
}

public enum InputMethod: OpenStringEnum {
    case text, voice, choice
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "text": self = .text
        case "voice": self = .voice
        case "choice": self = .choice
        default: self = .unknown(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .text: return "text"
        case .voice: return "voice"
        case .choice: return "choice"
        case .unknown(let raw): return raw
        }
    }
}

public enum DevicePlatform: OpenStringEnum {
    case ios, android
    case unknown(String)

    public init(raw: String) {
        switch raw {
        case "ios": self = .ios
        case "android": self = .android
        default: self = .unknown(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .ios: return "ios"
        case .android: return "android"
        case .unknown(let raw): return raw
        }
    }
}

public enum PushEnvironment: String, Codable, Sendable {
    case development, production
}

public enum RequestPriority: OpenStringEnum {
    case low, normal, high, urgent
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "low": self = .low
        case "normal": self = .normal
        case "high": self = .high
        case "urgent": self = .urgent
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .low: return "low"
        case .normal: return "normal"
        case .high: return "high"
        case .urgent: return "urgent"
        case .unknown(let r): return r
        }
    }
    public var isHighOrUrgent: Bool { self == .high || self == .urgent }
}

public enum DeliveryMode: OpenStringEnum {
    case actions, text, call
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "actions": self = .actions
        case "text": self = .text
        case "call": self = .call
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .actions: return "actions"
        case .text: return "text"
        case .call: return "call"
        case .unknown(let r): return r
        }
    }
}

public enum RequestedMode: OpenStringEnum {
    case auto, actions, text, call
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "auto": self = .auto
        case "actions": self = .actions
        case "text": self = .text
        case "call": self = .call
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .auto: return "auto"
        case .actions: return "actions"
        case .text: return "text"
        case .call: return "call"
        case .unknown(let r): return r
        }
    }
}

public enum CallState: OpenStringEnum {
    case ringing, active, ended
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "ringing": self = .ringing
        case "active": self = .active
        case "ended": self = .ended
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .ringing: return "ringing"
        case .active: return "active"
        case .ended: return "ended"
        case .unknown(let r): return r
        }
    }
}

public enum CallOutcome: OpenStringEnum {
    case resolved, declined, hangup, missed, cancelled, expired, failed
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "resolved": self = .resolved
        case "declined": self = .declined
        case "hangup": self = .hangup
        case "missed": self = .missed
        case "cancelled": self = .cancelled
        case "expired": self = .expired
        case "failed": self = .failed
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .resolved: return "resolved"
        case .declined: return "declined"
        case .hangup: return "hangup"
        case .missed: return "missed"
        case .cancelled: return "cancelled"
        case .expired: return "expired"
        case .failed: return "failed"
        case .unknown(let r): return r
        }
    }
}

public enum TranscriptRole: OpenStringEnum {
    case user, assistant
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "user": self = .user
        case "assistant": self = .assistant
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .user: return "user"
        case .assistant: return "assistant"
        case .unknown(let r): return r
        }
    }
}

public enum PresenceAvailability: OpenStringEnum {
    case available, busy, away
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "available": self = .available
        case "busy": self = .busy
        case "away": self = .away
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .available: return "available"
        case .busy: return "busy"
        case .away: return "away"
        case .unknown(let r): return r
        }
    }
}

public enum CallEventType: OpenStringEnum {
    case answer, decline, hangup, turn, failed, missed
    case unknown(String)
    public init(raw: String) {
        switch raw {
        case "answer": self = .answer
        case "decline": self = .decline
        case "hangup": self = .hangup
        case "turn": self = .turn
        case "failed": self = .failed
        case "missed": self = .missed
        default: self = .unknown(raw)
        }
    }
    public var rawValue: String {
        switch self {
        case .answer: return "answer"
        case .decline: return "decline"
        case .hangup: return "hangup"
        case .turn: return "turn"
        case .failed: return "failed"
        case .missed: return "missed"
        case .unknown(let r): return r
        }
    }
}

// MARK: - JSON coding

public enum OyobidashiJSON {
    /// ISO 8601。ミリ秒付き (契約) を優先し、小数秒なしも受け付ける。
    public static func parseDate(_ string: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(string)
    }

    /// `2026-11-15T14:00:00.000Z` 形式。
    public static func formatDate(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = parseDate(string) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "invalid ISO 8601 date: \(string)")
            }
            return date
        }
        return decoder
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDate(date))
        }
        return encoder
    }
}

/// 配列の要素のうちデコードできないものを捨てる (1件の不正データで一覧全体を失わないため)。
struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

extension KeyedDecodingContainer {
    func decodeLossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T] {
        guard let elements = try decodeIfPresent([LossyElement<T>].self, forKey: key) else { return [] }
        return elements.compactMap(\.value)
    }
}

// MARK: - Request

public struct AgentInfo: Codable, Equatable, Sendable {
    public var name: String?
    public var cwd: String?

    public init(name: String? = nil, cwd: String? = nil) {
        self.name = name
        self.cwd = cwd
    }
}

public struct Answer: Codable, Equatable, Sendable {
    public var text: String
    public var choiceIndex: Int?
    public var inputMethod: InputMethod
    public var deviceID: String?
    public var answeredAt: Date?

    enum CodingKeys: String, CodingKey {
        case text
        case choiceIndex = "choice_index"
        case inputMethod = "input_method"
        case deviceID = "device_id"
        case answeredAt = "answered_at"
    }

    public init(text: String, choiceIndex: Int? = nil, inputMethod: InputMethod = .text, deviceID: String? = nil, answeredAt: Date? = nil) {
        self.text = text
        self.choiceIndex = choiceIndex
        self.inputMethod = inputMethod
        self.deviceID = deviceID
        self.answeredAt = answeredAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        choiceIndex = try? c.decodeIfPresent(Int.self, forKey: .choiceIndex)
        inputMethod = (try? c.decodeIfPresent(InputMethod.self, forKey: .inputMethod)) ?? .text
        deviceID = try? c.decodeIfPresent(String.self, forKey: .deviceID)
        answeredAt = try? c.decodeIfPresent(Date.self, forKey: .answeredAt)
    }
}

// MARK: - Call

public struct CallTranscriptEntry: Codable, Equatable, Sendable {
    public var role: TranscriptRole
    public var text: String
    enum CodingKeys: String, CodingKey { case role, text }
    public init(role: TranscriptRole, text: String) {
        self.role = role
        self.text = text
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? c.decodeIfPresent(TranscriptRole.self, forKey: .role)) ?? .unknown("")
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
    }
}

public struct CallSession: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var requestID: String
    public var state: CallState
    public var outcome: CallOutcome?
    public var deviceID: String?
    public var startedAt: Date
    public var updatedAt: Date
    public var transcript: [CallTranscriptEntry]

    enum CodingKeys: String, CodingKey {
        case id, state, outcome, transcript
        case requestID = "request_id"
        case deviceID = "device_id"
        case startedAt = "started_at"
        case updatedAt = "updated_at"
    }

    public init(id: String, requestID: String, state: CallState, outcome: CallOutcome? = nil, deviceID: String? = nil, startedAt: Date, updatedAt: Date? = nil, transcript: [CallTranscriptEntry] = []) {
        self.id = id
        self.requestID = requestID
        self.state = state
        self.outcome = outcome
        self.deviceID = deviceID
        self.startedAt = startedAt
        self.updatedAt = updatedAt ?? startedAt
        self.transcript = transcript
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        requestID = (try? c.decodeIfPresent(String.self, forKey: .requestID)) ?? ""
        state = (try? c.decodeIfPresent(CallState.self, forKey: .state)) ?? .unknown("")
        outcome = try? c.decodeIfPresent(CallOutcome.self, forKey: .outcome)
        deviceID = try? c.decodeIfPresent(String.self, forKey: .deviceID)
        // started_at missing -> epoch fallback so one bad call doesn't drop request
        let startedOpt: Date? = try? c.decodeIfPresent(Date.self, forKey: .startedAt)
        let updatedOpt: Date? = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
        startedAt = startedOpt ?? updatedOpt ?? Date(timeIntervalSince1970: 0)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? startedAt
        transcript = (try? c.decodeLossyArray(CallTranscriptEntry.self, forKey: .transcript)) ?? []
    }

    public var isRinging: Bool { state == .ringing }
    public var isActive: Bool { state == .active }
    public var isEnded: Bool { state == .ended }
}

/// 契約の Request オブジェクト。
///
/// デコード方針: `id` / `question` / `status` / `created_at` は必須 (欠けていればデコード失敗)。
/// `kind` 欠落は `question`、`urgency` 欠落は `normal`、`updated_at` 欠落は `created_at` と同じ扱い。
/// それ以外は null / 欠落 / 型不一致をすべて nil として扱う。未知フィールドは無視する。
/// v0.2: `priority` 欠落は `normal`、`delivery_mode` 欠落は `text`、`requested_mode` 欠落は `auto`、`call` 欠落は nil。
public struct AgentRequest: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: RequestKind
    public var question: String
    public var context: String?
    public var choices: [String]?
    public var urgency: Urgency
    public var priority: RequestPriority
    public var deliveryMode: DeliveryMode
    public var requestedMode: RequestedMode
    public var call: CallSession?
    public var status: RequestStatus
    public var answer: Answer?
    public var agent: AgentInfo?
    public var createdAt: Date
    public var updatedAt: Date
    public var expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, kind, question, context, choices, urgency, status, answer, agent, priority, call
        case deliveryMode = "delivery_mode"
        case requestedMode = "requested_mode"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case expiresAt = "expires_at"
    }

    public init(
        id: String, kind: RequestKind = .question, question: String, context: String? = nil,
        choices: [String]? = nil, urgency: Urgency = .normal, status: RequestStatus = .pending,
        answer: Answer? = nil, agent: AgentInfo? = nil, createdAt: Date, updatedAt: Date? = nil, expiresAt: Date? = nil,
        priority: RequestPriority = .normal, deliveryMode: DeliveryMode = .text, requestedMode: RequestedMode = .auto, call: CallSession? = nil
    ) {
        self.id = id
        self.kind = kind
        self.question = question
        self.context = context
        self.choices = choices
        self.urgency = urgency
        self.priority = priority
        self.deliveryMode = deliveryMode
        self.requestedMode = requestedMode
        self.call = call
        self.status = status
        self.answer = answer
        self.agent = agent
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(RequestKind.self, forKey: .kind) ?? .question
        question = try c.decode(String.self, forKey: .question)
        context = try? c.decodeIfPresent(String.self, forKey: .context)
        choices = try? c.decodeIfPresent([String].self, forKey: .choices)
        urgency = (try? c.decodeIfPresent(Urgency.self, forKey: .urgency)) ?? .normal
        priority = (try? c.decodeIfPresent(RequestPriority.self, forKey: .priority)) ?? .normal
        deliveryMode = (try? c.decodeIfPresent(DeliveryMode.self, forKey: .deliveryMode)) ?? .text
        requestedMode = (try? c.decodeIfPresent(RequestedMode.self, forKey: .requestedMode)) ?? .auto
        call = try? c.decodeIfPresent(CallSession.self, forKey: .call)
        status = try c.decode(RequestStatus.self, forKey: .status)
        answer = try? c.decodeIfPresent(Answer.self, forKey: .answer)
        agent = try? c.decodeIfPresent(AgentInfo.self, forKey: .agent)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? createdAt
        expiresAt = try? c.decodeIfPresent(Date.self, forKey: .expiresAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(question, forKey: .question)
        try c.encodeIfPresent(context, forKey: .context)
        try c.encodeIfPresent(choices, forKey: .choices)
        try c.encode(urgency, forKey: .urgency)
        try c.encode(priority, forKey: .priority)
        try c.encode(deliveryMode, forKey: .deliveryMode)
        try c.encode(requestedMode, forKey: .requestedMode)
        try c.encodeIfPresent(call, forKey: .call)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(answer, forKey: .answer)
        try c.encodeIfPresent(agent, forKey: .agent)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
    }

    /// 回答を送れるか (question かつ pending)。未知の kind / status は回答不可とする。
    public var isAnswerable: Bool { kind == .question && status == .pending }

    /// 空でない選択肢。
    public var effectiveChoices: [String] { choices ?? [] }

    /// actions モードとしてボタン表示できるか (契約: <=3 選択肢)。
    public var isActionsEligible: Bool {
        deliveryMode == .actions && !effectiveChoices.isEmpty && effectiveChoices.count <= 3
    }
    public var hasLiveCall: Bool {
        guard let call else { return false }
        return call.state == .ringing || call.state == .active
    }
}

// MARK: - Device

public struct Device: Codable, Equatable, Sendable {
    public var id: String
    public var name: String?
    public var platform: DevicePlatform?
    public var createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name, platform
        case createdAt = "created_at"
    }

    public init(id: String, name: String? = nil, platform: DevicePlatform? = nil, createdAt: Date? = nil) {
        self.id = id
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        platform = try? c.decodeIfPresent(DevicePlatform.self, forKey: .platform)
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
    }
}

// MARK: - Request / response bodies

/// `POST /v1/pair` のボディ。nil のフィールドは出力しない。
public struct PairRequestBody: Codable, Equatable, Sendable {
    public var code: String
    public var deviceName: String
    public var platform: DevicePlatform
    public var pushToken: String?
    public var pushEnvironment: PushEnvironment?

    enum CodingKeys: String, CodingKey {
        case code, platform
        case deviceName = "device_name"
        case pushToken = "push_token"
        case pushEnvironment = "push_environment"
    }

    public init(code: String, deviceName: String, platform: DevicePlatform = .ios, pushToken: String? = nil, pushEnvironment: PushEnvironment? = nil) {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
        self.pushToken = pushToken
        self.pushEnvironment = pushEnvironment
    }
}

public struct PairResponse: Decodable, Equatable, Sendable {
    public var device: Device
    public var deviceToken: String

    enum CodingKeys: String, CodingKey {
        case device
        case deviceToken = "device_token"
    }
}

/// 「変更しない / null で解除 / 値を設定」の3状態。
public enum FieldUpdate<Value: Equatable & Sendable>: Equatable, Sendable {
    case unchanged
    case clear
    case set(Value)
}

/// `PUT /v1/devices/me` のボディ。指定したフィールドだけ出力する。
public struct DeviceUpdateBody: Encodable, Equatable, Sendable {
    public var pushToken: FieldUpdate<String>
    public var voipToken: FieldUpdate<String>
    public var pushEnvironment: PushEnvironment?
    public var deviceName: String?

    enum CodingKeys: String, CodingKey {
        case pushToken = "push_token"
        case voipToken = "voip_token"
        case pushEnvironment = "push_environment"
        case deviceName = "device_name"
    }

    public init(pushToken: FieldUpdate<String> = .unchanged, voipToken: FieldUpdate<String> = .unchanged, pushEnvironment: PushEnvironment? = nil, deviceName: String? = nil) {
        self.pushToken = pushToken
        self.voipToken = voipToken
        self.pushEnvironment = pushEnvironment
        self.deviceName = deviceName
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch pushToken {
        case .unchanged: break
        case .clear: try c.encodeNil(forKey: .pushToken)
        case .set(let token): try c.encode(token, forKey: .pushToken)
        }
        switch voipToken {
        case .unchanged: break
        case .clear: try c.encodeNil(forKey: .voipToken)
        case .set(let token): try c.encode(token, forKey: .voipToken)
        }
        try c.encodeIfPresent(pushEnvironment, forKey: .pushEnvironment)
        try c.encodeIfPresent(deviceName, forKey: .deviceName)
    }
}

/// `POST /v1/requests/{id}/answer` のボディ。`choice_index` は nil なら出力しない (null と欠落は同義)。
public struct AnswerBody: Codable, Equatable, Sendable {
    public var text: String
    public var choiceIndex: Int?
    public var inputMethod: InputMethod

    enum CodingKeys: String, CodingKey {
        case text
        case choiceIndex = "choice_index"
        case inputMethod = "input_method"
    }

    public init(text: String, choiceIndex: Int? = nil, inputMethod: InputMethod) {
        self.text = text
        self.choiceIndex = choiceIndex
        self.inputMethod = inputMethod
    }

    public static let maxTextLength = 10_000
}

// MARK: - Presence

/// `PUT /v1/presence` のボディ。`until`/`note` は FieldUpdate で unchanged/clear/set を区別する。
public struct PresenceUpdateBody: Encodable, Equatable, Sendable {
    public var availability: PresenceAvailability
    public var until: FieldUpdate<Date>
    public var note: FieldUpdate<String>

    enum CodingKeys: String, CodingKey { case availability, until, note }

    public init(availability: PresenceAvailability, until: FieldUpdate<Date> = .unchanged, note: FieldUpdate<String> = .unchanged) {
        self.availability = availability
        self.until = until
        self.note = note
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(availability, forKey: .availability)
        switch until {
        case .unchanged: break
        case .clear: try c.encodeNil(forKey: .until)
        case .set(let d): try c.encode(OyobidashiJSON.formatDate(d), forKey: .until)
        }
        switch note {
        case .unchanged: break
        case .clear: try c.encodeNil(forKey: .note)
        case .set(let s): try c.encode(s, forKey: .note)
        }
    }
}

public struct DevicePresence: Decodable, Equatable, Sendable {
    public var deviceID: String
    public var availability: PresenceAvailability
    public var until: Date?
    public var note: String?
    public var updatedAt: Date?
    public var lastSeenAt: Date?
    enum CodingKeys: String, CodingKey {
        case availability, until, note
        case deviceID = "device_id"
        case updatedAt = "updated_at"
        case lastSeenAt = "last_seen_at"
    }
    public init(deviceID: String, availability: PresenceAvailability = .available, until: Date? = nil, note: String? = nil, updatedAt: Date? = nil, lastSeenAt: Date? = nil) {
        self.deviceID = deviceID
        self.availability = availability
        self.until = until
        self.note = note
        self.updatedAt = updatedAt
        self.lastSeenAt = lastSeenAt
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceID = (try? c.decodeIfPresent(String.self, forKey: .deviceID)) ?? ""
        availability = (try? c.decodeIfPresent(PresenceAvailability.self, forKey: .availability)) ?? .available
        until = try? c.decodeIfPresent(Date.self, forKey: .until)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
        lastSeenAt = try? c.decodeIfPresent(Date.self, forKey: .lastSeenAt)
    }
    /// 期限切れの busy/away は available とみなす (契約)。
    public func effectiveAvailability(now: Date = Date()) -> PresenceAvailability {
        if availability == .available { return .available }
        if let until, until <= now { return .available }
        return availability
    }
}

public struct PresenceEvent: Decodable, Equatable, Sendable {
    public var requestID: String?
    public var deviceID: String?
    public var event: String
    public var at: Date?
    enum CodingKeys: String, CodingKey {
        case event, at
        case requestID = "request_id"
        case deviceID = "device_id"
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try? c.decodeIfPresent(String.self, forKey: .requestID)
        deviceID = try? c.decodeIfPresent(String.self, forKey: .deviceID)
        event = (try? c.decodeIfPresent(String.self, forKey: .event)) ?? ""
        at = try? c.decodeIfPresent(Date.self, forKey: .at)
    }
    public init(requestID: String? = nil, deviceID: String? = nil, event: String, at: Date? = nil) {
        self.requestID = requestID
        self.deviceID = deviceID
        self.event = event
        self.at = at
    }
}

public struct PresenceResponse: Decodable, Equatable, Sendable {
    public var devices: [DevicePresence]
    public var recentEvents: [PresenceEvent]
    public var now: Date?
    enum CodingKeys: String, CodingKey {
        case devices, now
        case recentEvents = "recent_events"
    }
    public init(devices: [DevicePresence] = [], recentEvents: [PresenceEvent] = [], now: Date? = nil) {
        self.devices = devices
        self.recentEvents = recentEvents
        self.now = now
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = (try? c.decodeLossyArray(DevicePresence.self, forKey: .devices)) ?? []
        recentEvents = (try? c.decodeLossyArray(PresenceEvent.self, forKey: .recentEvents)) ?? []
        now = try? c.decodeIfPresent(Date.self, forKey: .now)
    }
}

// MARK: - Call API

public struct CallEventBody: Encodable, Equatable, Sendable {
    public var event: CallEventType
    public var text: String?
    enum CodingKeys: String, CodingKey { case event, text }
    public init(event: CallEventType, text: String? = nil) {
        self.event = event
        self.text = text
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(event, forKey: .event)
        try c.encodeIfPresent(text, forKey: .text)
    }
}

public struct CallActionResponse: Decodable, Equatable, Sendable {
    public var request: AgentRequest
    public var call: CallSession?
    public var reply: String?
    public var resolved: Bool?
    enum CodingKeys: String, CodingKey { case request, call, reply, resolved }
    public init(request: AgentRequest, call: CallSession? = nil, reply: String? = nil, resolved: Bool? = nil) {
        self.request = request
        self.call = call
        self.reply = reply
        self.resolved = resolved
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        request = try c.decode(AgentRequest.self, forKey: .request)
        call = try? c.decodeIfPresent(CallSession.self, forKey: .call)
        reply = try? c.decodeIfPresent(String.self, forKey: .reply)
        resolved = try? c.decodeIfPresent(Bool.self, forKey: .resolved)
    }
}

struct CallEnvelope: Decodable {
    var request: AgentRequest
    var call: CallSession?
    var reply: String?
    var resolved: Bool?
}

struct RequestEnvelope: Decodable {
    var request: AgentRequest
}

struct RequestListEnvelope: Decodable {
    var requests: [AgentRequest]

    enum CodingKeys: String, CodingKey { case requests }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.requests) else {
            throw DecodingError.keyNotFound(CodingKeys.requests, .init(codingPath: c.codingPath, debugDescription: "requests is missing"))
        }
        requests = try c.decodeLossyArray(AgentRequest.self, forKey: .requests)
    }
}

struct DeviceEnvelope: Decodable {
    var device: Device
}

public struct HealthResponse: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var version: String?
}

/// `{ "error": { "code": ..., "message": ... } }`
public struct ErrorEnvelope: Decodable, Equatable, Sendable {
    public struct Body: Decodable, Equatable, Sendable {
        public var code: String
        public var message: String?
    }
    public var error: Body
}
