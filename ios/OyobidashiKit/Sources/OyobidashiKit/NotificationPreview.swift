import Foundation

public enum NotificationPreviewError: Error, Equatable, Sendable {
    case invalidDescriptor, unavailable, invalidResponse
}

/// The capability is restricted to one request and one current push destination.
/// Its secret travels only in Authorization, never a URL or log.
public struct NotificationPreviewDescriptor: Sendable {
    public let url: URL
    public let token: String
    public let requestID: String
    public let recipientDeviceID: String

    public init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo["preview_url"] as? String, let url = URL(string: raw),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              let token = userInfo["preview_token"] as? String,
              token.range(of: "^kp_[A-Za-z0-9_-]{16,256}$", options: .regularExpression) != nil,
              let requestID = userInfo["request_id"] as? String, !requestID.isEmpty, requestID.count <= 200,
              case .device(let recipientDeviceID) = PushRecipient(userInfo: userInfo),
              url.path == "/v1/previews/\(requestID)", !requestID.contains("/") else { return nil }
        self.url = url; self.token = token; self.requestID = requestID; self.recipientDeviceID = recipientDeviceID
    }
}

public struct NotificationPreviewClient: Sendable {
    public static let maxBytes = 128 * 1024
    private let transport: any HTTPTransport
    public init(transport: any HTTPTransport = NotificationPreviewTransport()) { self.transport = transport }

    public func fetch(_ descriptor: NotificationPreviewDescriptor) async throws -> AgentRequest {
        guard !Task.isCancelled else { throw NotificationPreviewError.unavailable }
        var request = URLRequest(url: descriptor.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.setValue("Bearer \(descriptor.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        let (data, response): (Data, HTTPURLResponse)
        do { (data, response) = try await transport.send(request) }
        catch { throw NotificationPreviewError.unavailable }
        guard !Task.isCancelled, response.statusCode == 200, response.url == descriptor.url,
              data.count <= Self.maxBytes,
              response.expectedContentLength <= Int64(Self.maxBytes) else { throw NotificationPreviewError.invalidResponse }
        struct Envelope: Decodable { var request: AgentRequest; var recipient_device_id: String }
        guard let result = try? OyobidashiJSON.makeDecoder().decode(Envelope.self, from: data),
              result.request.id == descriptor.requestID,
              result.recipient_device_id == descriptor.recipientDeviceID else { throw NotificationPreviewError.invalidResponse }
        return result.request
    }
}

private final class PreviewRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Streaming byte cap prevents a large/malicious response from exhausting NSE memory.
/// The URLSession resource deadline bounds the entire exchange, including slow bodies.
public struct NotificationPreviewTransport: HTTPTransport {
    public init() {}
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 3
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: PreviewRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, raw) = try await session.bytes(for: request)
        guard let response = raw as? HTTPURLResponse,
              response.expectedContentLength <= Int64(NotificationPreviewClient.maxBytes) else { throw NotificationPreviewError.invalidResponse }
        var body = Data()
        for try await byte in bytes {
            guard body.count < NotificationPreviewClient.maxBytes else { throw NotificationPreviewError.invalidResponse }
            body.append(byte)
        }
        return (body, response)
    }
}

public enum NotificationPreviewPrivacy {
    public static let title = "お呼び出し"
    public static let body = "新しい質問・お知らせがあります。アプリを開いて確認してください。"
    /// Remove capability secrets and any legacy embedded personal content before delivery.
    public static func safeUserInfo(_ info: [AnyHashable: Any]) -> [AnyHashable: Any] {
        guard info["recipient_device_id"] != nil else { return info }
        var safe = info
        for key in ["preview_token", "preview_url", "question", "context", "choices", "agent", "transcript", "turn"] { safe.removeValue(forKey: key) }
        safe["delivery_mode"] = "text"
        if var aps = safe["aps"] as? [AnyHashable: Any] {
            if aps["alert"] != nil { aps["alert"] = ["title": title, "body": body] }
            aps["category"] = PushCategory.notification
            safe["aps"] = aps
        }
        return safe
    }
}
