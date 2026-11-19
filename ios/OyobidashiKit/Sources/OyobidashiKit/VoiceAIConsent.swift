import Foundation

// 音声通話で話した内容は、接続先が使う第三者のAIへ送られる。その許可は
// ペアリングのときに1回だけ、このアプリの画面で受け取る。通話中には尋ねない。
// 文字・選択肢での回答はAIへ送らないので、この同意の対象ではない。

/// 接続先が `GET /healthz` の `voice_ai` で示す、音声会話の送信先。
public struct VoiceAIDisclosure: Decodable, Equatable, Sendable {
    /// 未知の値も保持する。画面では名前を出さず、同意の照合にだけ使う。
    public let provider: String?

    public init(provider: String?) {
        self.provider = provider
    }

    /// 接続先が送信先を示さない (古いサーバー、または確認に失敗した) 場合。
    public static let unknown = VoiceAIDisclosure(provider: nil)

    /// 画面に出す送信先の名前。
    public var recipientName: String {
        switch provider {
        case "anthropic": return "Anthropic"
        case "meta": return "Meta"
        case "claude-code": return "接続先のMacで設定されたClaude Code（Anthropic）"
        default: return "接続先で設定された第三者のAIサービス"
        }
    }

    public static let title = "音声通話とAIへの送信"
    public static let acceptTitle = "同意してペアリング"

    /// 同意の前に見せる説明。何を・どこへ・何のために送るかを先に書く。
    public var paragraphs: [String] {
        [
            "通話に音声で応答すると、話した内容を文字に変換し、エージェントからの質問・補足・選択肢と会話の履歴とともに、\(recipientName)へ送信します。",
            "送信した内容は、通話での返答の生成と、エージェントへ伝える回答の要約に使われます。音声そのものは送信しません。音声を文字に変換するため、Appleが音声を処理する場合があります。",
            "文字や選択肢での回答は、AIへ送信されません。",
        ]
    }
}

/// この端末で受け取った同意の記録。どの接続先の、どの送信先に対するものかを持つ。
public struct VoiceAIConsent: Codable, Equatable, Sendable {
    /// 説明文の意味が変わったときに上げる。古い版の同意は使わない。
    public static let currentVersion = 1

    public var endpoint: String
    public var provider: String?
    public var version: Int
    public var acceptedAt: Date

    public init(endpoint: RelayEndpoint, disclosure: VoiceAIDisclosure, acceptedAt: Date, version: Int = VoiceAIConsent.currentVersion) {
        self.endpoint = endpoint.description
        self.provider = disclosure.provider
        self.version = version
        self.acceptedAt = acceptedAt
    }

    /// 今のペアリング先に対する、現行版の同意か。
    public func covers(_ endpoint: RelayEndpoint) -> Bool {
        version == Self.currentVersion && self.endpoint == endpoint.description
    }

    /// 接続先が別の送信先を示したら、同意を取り直す。送信先を確認できないだけなら取り直さない。
    public func covers(_ endpoint: RelayEndpoint, disclosure: VoiceAIDisclosure) -> Bool {
        guard covers(endpoint) else { return false }
        guard let current = disclosure.provider else { return true }
        return current == provider
    }
}

public protocol VoiceAIConsentStore: Sendable {
    func load() -> VoiceAIConsent?
    func save(_ consent: VoiceAIConsent?)
}

/// テスト・プレビュー用。
public final class InMemoryVoiceAIConsentStore: VoiceAIConsentStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: VoiceAIConsent?

    public init(_ consent: VoiceAIConsent? = nil) {
        stored = consent
    }

    public func load() -> VoiceAIConsent? { lock.withLock { stored } }
    public func save(_ consent: VoiceAIConsent?) { lock.withLock { stored = consent } }
}

/// 同意の記録は秘密情報ではないので UserDefaults に置く。
public struct UserDefaultsVoiceAIConsentStore: VoiceAIConsentStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "oyobidashi.voice-ai-consent") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> VoiceAIConsent? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(VoiceAIConsent.self, from: data)
    }

    public func save(_ consent: VoiceAIConsent?) {
        if let consent, let data = try? JSONEncoder().encode(consent) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
