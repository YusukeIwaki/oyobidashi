import Foundation

/// HTTP の送信口。テストではスタブに差し替える。
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// Device API (アプリ → relay) のクライアント。throw するエラーは常に `RelayError`。
public struct RelayClient: Sendable {
    public let endpoint: RelayEndpoint
    public let deviceToken: String?
    private let transport: any HTTPTransport
    private let timeout: TimeInterval

    public init(endpoint: RelayEndpoint, deviceToken: String?, transport: any HTTPTransport = URLSessionTransport(), timeout: TimeInterval = 20) {
        self.endpoint = endpoint
        self.deviceToken = deviceToken
        self.transport = transport
        self.timeout = timeout
    }

    // MARK: Endpoints

    /// `POST /v1/pair` (認証不要)
    public func pair(_ body: PairRequestBody) async throws -> PairResponse {
        try await perform("POST", ["v1", "pair"], body: body, authorized: false)
    }

    /// `PUT /v1/devices/me`
    public func updateDevice(_ body: DeviceUpdateBody) async throws -> Device {
        let envelope: DeviceEnvelope = try await perform("PUT", ["v1", "devices", "me"], body: body)
        return envelope.device
    }

    /// `DELETE /v1/devices/me` → 204
    public func deleteDevice() async throws {
        _ = try await raw("DELETE", ["v1", "devices", "me"], bodyData: nil, authorized: true)
    }

    /// `GET /v1/requests?status=…&limit=…`
    public func listRequests(status: RequestStatus? = nil, limit: Int? = nil) async throws -> [AgentRequest] {
        var query: [URLQueryItem] = []
        if let status { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        let envelope: RequestListEnvelope = try await perform("GET", ["v1", "requests"], query: query)
        return envelope.requests
    }

    /// `GET /v1/requests/{id}`
    public func getRequest(id: String) async throws -> AgentRequest {
        let envelope: RequestEnvelope = try await perform("GET", ["v1", "requests", id])
        return envelope.request
    }

    /// `POST /v1/requests/{id}/answer`
    public func answer(requestID: String, body: AnswerBody) async throws -> AgentRequest {
        let envelope: RequestEnvelope = try await perform("POST", ["v1", "requests", requestID, "answer"], body: body)
        return envelope.request
    }

    /// `PUT /v1/presence` (device auth)
    public func updatePresence(_ body: PresenceUpdateBody) async throws -> PresenceResponse {
        // Server may return PresenceResponse, a single device object, or empty 200.
        // Decode tolerantly: try PresenceResponse first, then wrap single device.
        let data = try await rawWithBody("PUT", ["v1", "presence"], body: body)
        if data.isEmpty { return PresenceResponse() }
        if let resp = try? OyobidashiJSON.makeDecoder().decode(PresenceResponse.self, from: data), !resp.devices.isEmpty || resp.now != nil {
            return resp
        }
        // Try {device: ...} or bare DevicePresence
        struct SingleDevice: Decodable { var device: DevicePresence? }
        if let single = try? OyobidashiJSON.makeDecoder().decode(SingleDevice.self, from: data), let d = single.device {
            return PresenceResponse(devices: [d])
        }
        if let bare = try? OyobidashiJSON.makeDecoder().decode(DevicePresence.self, from: data), !bare.deviceID.isEmpty {
            return PresenceResponse(devices: [bare])
        }
        if let resp = try? OyobidashiJSON.makeDecoder().decode(PresenceResponse.self, from: data) {
            return resp
        }
        return PresenceResponse()
    }

    /// `GET /v1/presence` (agent auth on relay; device token will get 403 if not allowed — surfaced as RelayError)
    public func getPresence() async throws -> PresenceResponse {
        try await perform("GET", ["v1", "presence"])
    }

    /// `POST /v1/requests/{id}/call` (device auth)
    public func callAction(requestID: String, body: CallEventBody) async throws -> CallActionResponse {
        let envelope: CallEnvelope = try await perform("POST", ["v1", "requests", requestID, "call"], body: body)
        return CallActionResponse(request: envelope.request, call: envelope.call, reply: envelope.reply, resolved: envelope.resolved)
    }

    public func answerCall(requestID: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .answer))
    }
    public func declineCall(requestID: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .decline))
    }
    public func hangupCall(requestID: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .hangup))
    }
    public func sendCallTurn(requestID: String, text: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .turn, text: text))
    }
    public func failCall(requestID: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .failed))
    }

    /// `GET /healthz` (認証不要)
    public func health() async throws -> HealthResponse {
        try await perform("GET", ["healthz"], authorized: false)
    }

    // MARK: Plumbing

    private struct NoBody: Encodable {}

    private func perform<Response: Decodable>(
        _ method: String, _ segments: [String], query: [URLQueryItem] = [], authorized: Bool = true
    ) async throws -> Response {
        try await perform(method, segments, query: query, body: Optional<NoBody>.none, authorized: authorized)
    }

    private func perform<Body: Encodable, Response: Decodable>(
        _ method: String, _ segments: [String], query: [URLQueryItem] = [], body: Body?, authorized: Bool = true
    ) async throws -> Response {
        var bodyData: Data?
        if let body {
            do {
                bodyData = try OyobidashiJSON.makeEncoder().encode(body)
            } catch {
                throw RelayError.invalidRequest(message: "encode failed: \(error)")
            }
        }
        let data = try await raw(method, segments, query: query, bodyData: bodyData, authorized: authorized)
        do {
            return try OyobidashiJSON.makeDecoder().decode(Response.self, from: data)
        } catch {
            throw RelayError.decoding(String(describing: error))
        }
    }

    private func rawWithBody<Body: Encodable>(_ method: String, _ segments: [String], body: Body) async throws -> Data {
        let bodyData: Data
        do {
            bodyData = try OyobidashiJSON.makeEncoder().encode(body)
        } catch {
            throw RelayError.invalidRequest(message: "encode failed: \(error)")
        }
        return try await raw(method, segments, query: [], bodyData: bodyData, authorized: true)
    }

    private func raw(
        _ method: String, _ segments: [String], query: [URLQueryItem] = [], bodyData: Data?, authorized: Bool
    ) async throws -> Data {
        var request = URLRequest(url: endpoint.url(segments: segments, query: query))
        request.httpMethod = method
        request.timeoutInterval = segments.last == "call" ? max(timeout, 100) : timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized {
            // トークンが無ければ送信せずに unauthorized とする。
            guard let deviceToken, !deviceToken.isEmpty else { throw RelayError.unauthorized }
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw RelayError.wrap(error)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw RelayError.from(status: response.statusCode, body: data)
        }
        return data
    }
}
