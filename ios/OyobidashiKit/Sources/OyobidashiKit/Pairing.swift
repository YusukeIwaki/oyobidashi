import Foundation

public enum PairingParseError: Error, Equatable, Sendable {
    /// URI として解釈できない
    case malformed
    /// スキームが `oyobidashi` でない
    case wrongScheme
    /// `oyobidashi://pair` でない
    case wrongHost
    case missingURL
    case missingCode
    /// `url` が http(s) の URL でない
    case invalidRelayURL

    public var userMessage: String {
        switch self {
        case .malformed, .wrongScheme, .wrongHost:
            return "oyobidashi のペアリング用コードではありません"
        case .missingURL:
            return "サーバーのURLを入力してください"
        case .missingCode:
            return "ペアリングコードを入力してください"
        case .invalidRelayURL:
            return "サーバーのURLが正しくありません (http:// または https:// で始まるURL)"
        }
    }
}

/// ペアリングに必要な情報 (relay の公開ベースURL + ワンタイムコード)。
public struct PairingInfo: Equatable, Sendable {
    public let endpoint: RelayEndpoint
    public let code: String

    public init(endpoint: RelayEndpoint, code: String) {
        self.endpoint = endpoint
        self.code = code
    }

    /// `oyobidashi://pair?url=<URLエンコードしたベースURL>&code=<code>` を解釈する。
    ///
    /// スキーム・ホストは大文字小文字を区別しない。未知のパラメーターは無視。同名パラメーターが複数あれば最初のものを使う。
    public static func parse(uri: String) throws -> PairingInfo {
        let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let components = URLComponents(string: trimmed), let scheme = components.scheme else {
            throw PairingParseError.malformed
        }
        guard scheme.lowercased() == "oyobidashi" else { throw PairingParseError.wrongScheme }
        guard components.host?.lowercased() == "pair", components.path.isEmpty || components.path == "/" else {
            throw PairingParseError.wrongHost
        }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let urlString = value("url"), !urlString.isEmpty else { throw PairingParseError.missingURL }
        guard let code = value("code"), !code.isEmpty else { throw PairingParseError.missingCode }
        guard let endpoint = try? RelayEndpoint(urlString) else { throw PairingParseError.invalidRelayURL }
        return PairingInfo(endpoint: endpoint, code: code)
    }

    public static func parse(url: URL) throws -> PairingInfo {
        try parse(uri: url.absoluteString)
    }

    /// 手入力 (URL とコード) を検証する。
    ///
    /// - URL 欄に `oyobidashi://pair?...` を貼り付けた場合はそれを解釈する (コード欄は無視)。
    /// - `://` を含まない入力 (`192.168.1.10:8787` 等) には `http://` を補う (LAN 内の平文 HTTP が標準のため)。
    /// - コードは前後および途中の空白・改行を取り除く。
    public static func manual(url: String, code: String) throws -> PairingInfo {
        let urlInput = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if urlInput.lowercased().hasPrefix("oyobidashi:") {
            return try parse(uri: urlInput)
        }
        guard !urlInput.isEmpty else { throw PairingParseError.missingURL }
        let normalizedCode = code.components(separatedBy: .whitespacesAndNewlines).joined()
        let candidate = urlInput.contains("://") ? urlInput : "http://" + urlInput
        guard let endpoint = try? RelayEndpoint(candidate) else { throw PairingParseError.invalidRelayURL }
        guard !normalizedCode.isEmpty else { throw PairingParseError.missingCode }
        return PairingInfo(endpoint: endpoint, code: normalizedCode)
    }
}
