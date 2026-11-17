import Foundation
import Observation

/// 送信前の回答の下書き。
public struct AnswerDraft: Codable, Equatable, Sendable {
    public var text: String
    /// 音声入力に由来するか (送信時の `input_method` 判定に使う)。
    public var usedVoice: Bool
    /// Retain the ID before sending so an uncertain delivery can be recovered after restart.
    public var voiceTurnID: String?
    public var voiceCallID: String?

    public init(text: String, usedVoice: Bool = false, voiceTurnID: String? = nil, voiceCallID: String? = nil) {
        self.text = text
        self.usedVoice = usedVoice
        self.voiceTurnID = voiceTurnID
        self.voiceCallID = voiceCallID
    }
}

public protocol DraftPersistence: Sendable {
    func load() -> [String: AnswerDraft]
    func save(_ drafts: [String: AnswerDraft])
}

public final class InMemoryDraftPersistence: DraftPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: AnswerDraft]

    public init(_ drafts: [String: AnswerDraft] = [:]) {
        stored = drafts
    }

    public func load() -> [String: AnswerDraft] { lock.withLock { stored } }
    public func save(_ drafts: [String: AnswerDraft]) { lock.withLock { stored = drafts } }
}

/// UserDefaults に JSON で保存する (下書きは秘密情報ではないので Keychain には入れない)。
public struct UserDefaultsDraftPersistence: DraftPersistence, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "oyobidashi.answer-drafts") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> [String: AnswerDraft] {
        guard let data = defaults.data(forKey: key) else { return [:] }
        return (try? JSONDecoder().decode([String: AnswerDraft].self, from: data)) ?? [:]
    }

    public func save(_ drafts: [String: AnswerDraft]) {
        if drafts.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(drafts) {
            defaults.set(data, forKey: key)
        }
    }
}

/// request ごとの下書き。圏外で送れなかった回答 (通知からの返信を含む) を失わないために永続化する。
@MainActor
@Observable
public final class DraftStore {
    public private(set) var drafts: [String: AnswerDraft]
    @ObservationIgnored private let persistence: any DraftPersistence

    public init(persistence: any DraftPersistence = InMemoryDraftPersistence()) {
        self.persistence = persistence
        drafts = persistence.load()
    }

    public func draft(for requestID: String) -> AnswerDraft? { drafts[requestID] }

    /// 空白のみのテキストは「下書きなし」として扱う。
    public func set(_ draft: AnswerDraft, for requestID: String) {
        if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            remove(requestID)
        } else if drafts[requestID] != draft {
            drafts[requestID] = draft
            persistence.save(drafts)
        }
    }

    public func remove(_ requestID: String) {
        guard drafts.removeValue(forKey: requestID) != nil else { return }
        persistence.save(drafts)
    }

    public func removeAll() {
        guard !drafts.isEmpty else { return }
        drafts = [:]
        persistence.save(drafts)
    }
}
