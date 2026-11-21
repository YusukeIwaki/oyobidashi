import Foundation

public enum RelayEndpointError: Error, Equatable, Sendable {
    case malformed
    case unsupportedScheme
    case missingHost
}

/// 検証・正規化済みの relay ベースURL (http/https、ホストあり、末尾スラッシュ・クエリ・フラグメントなし)。
public struct RelayEndpoint: Equatable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let baseURL: URL

    public init(_ string: String) throws {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
            throw RelayEndpointError.malformed
        }
        guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw RelayEndpointError.unsupportedScheme
        }
        guard let host = components.host, !host.isEmpty else {
            throw RelayEndpointError.missingHost
        }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        components.percentEncodedPath = path
        guard let url = components.url else { throw RelayEndpointError.malformed }
        baseURL = url
    }

    public init(url: URL) throws {
        try self.init(url.absoluteString)
    }

    public init(from decoder: Decoder) throws {
        let string = try decoder.singleValueContainer().decode(String.self)
        try self.init(string)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(baseURL.absoluteString)
    }

    public var description: String { baseURL.absoluteString }

    public var host: String { baseURL.host ?? "" }

    /// 公式クラウド。アプリの「Oyobidashiクラウドに接続」が開くペアリングページの接続先。
    public static let officialCloud = try! RelayEndpoint("https://api.oyobidashi.me")

    public var isOfficialCloud: Bool {
        baseURL.scheme == "https" && host.lowercased() == "api.oyobidashi.me"
            && (baseURL.port ?? 443) == 443 && baseURL.path.isEmpty
            && baseURL.user == nil && baseURL.password == nil
    }

    /// `segments` を1つずつパーセントエンコードして `<base>/<segments…>` を作る。
    public var supportsCloudAccountDeletion: Bool {
        isOfficialCloud || (baseURL.scheme == "https" && host.lowercased() == "oyobidashi.up.railway.app"
            && (baseURL.port ?? 443) == 443 && baseURL.path.isEmpty
            && baseURL.user == nil && baseURL.password == nil)
    }

    public func url(segments: [String], query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/;?#%")
        let suffix = segments
            .map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0 }
            .joined(separator: "/")
        components.percentEncodedPath = components.percentEncodedPath + "/" + suffix
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    /// `GET /v1/events` 用の WebSocket URL (http→ws, https→wss)。
    public var eventsURL: URL {
        var components = URLComponents(url: url(segments: ["v1", "events"]), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }
}
