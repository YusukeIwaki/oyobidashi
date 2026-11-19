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
        let path = request.url?.path ?? ""
        let sensitive = path == "/v1/billing" || path.hasPrefix("/v1/billing/") || path.hasPrefix("/v1/account/")
        let (data, response) = try await session.data(for: request, delegate: sensitive ? RefuseRedirects() : nil)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Device API (アプリ → relay) のクライアント。throw するエラーは常に `RelayError`。
public struct RelayClient: Sendable {
    public let endpoint: RelayEndpoint
    public let deviceToken: String?
    private let transport: any HTTPTransport
    private let timeout: TimeInterval
    private let voiceTurnPolicy: VoiceTurnPolicy
    private let voiceAccessToken: String?

    public init(endpoint: RelayEndpoint, deviceToken: String?, transport: any HTTPTransport = URLSessionTransport(), timeout: TimeInterval = 20, voiceTurnPolicy: VoiceTurnPolicy = VoiceTurnPolicy(), voiceAccessToken: String? = nil) {
        self.endpoint = endpoint
        self.deviceToken = deviceToken
        self.transport = transport
        self.timeout = timeout
        self.voiceTurnPolicy = voiceTurnPolicy
        self.voiceAccessToken = voiceAccessToken
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

    public func beginAccountDeletion() async throws -> AccountDeletionResponse {
        guard endpoint.supportsCloudAccountDeletion else { throw RelayError.forbidden }
        return try await perform("POST", ["v1", "account", "deletion"])
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
        if body.event == .turn { return try await performVoiceTurn(requestID: requestID, body: body) }
        let envelope: CallEnvelope = try await perform("POST", ["v1", "requests", requestID, "call"], body: body)
        return CallActionResponse(request: envelope.request, call: envelope.call, reply: envelope.reply, resolved: envelope.resolved, turn: envelope.turn)
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
    public func sendCallTurn(requestID: String, text: String, turnID: String? = nil, recovering: Bool = false) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .turn, text: text, turnID: turnID, recoveringTurn: recovering))
    }
    public func failCall(requestID: String) async throws -> CallActionResponse {
        try await callAction(requestID: requestID, body: CallEventBody(event: .failed))
    }

    // MARK: Billing

    public func voiceStatus() async throws -> VoiceStatus? {
        do { return try await perform("GET", ["v1", "voice"]) }
        catch RelayError.notFound { return nil }
    }

    public func voiceChallenge(_ purpose: String) async throws -> VoiceChallenge {
        try await perform("POST", ["v1", "voice", "challenge"], body: VoiceChallengeRequest(purpose: purpose))
    }

    public func voiceAppleAttest(challenge: String, keyID: String, attestation: Data) async throws {
        _ = try await rawWithBody("POST", ["v1", "voice", "apple", "attest"], body: VoiceAppleAttestRequest(challenge: challenge, keyID: keyID, attestation: attestation.base64EncodedString()))
    }

    public func voiceToken(challenge: String, keyID: String, signature: Data) async throws -> VoiceAccess {
        try await perform("POST", ["v1", "voice", "token"], body: VoiceTokenRequest(challenge: challenge, keyID: keyID, signature: signature.base64EncodedString()))
    }

    // MARK: Billing

    /// 公式 API の `GET /v1/billing` (device auth)。404 は billing 無効として扱う。
    public func billingStatus() async throws -> BillingStatus {
        guard endpoint.isOfficialCloud else { return .disabled }
        do {
            return try await perform("GET", ["v1", "billing"])
        } catch let error as RelayError {
            if error == .notFound { return .disabled }
            if case .unexpectedResponse(let status, _, _) = error, status == 404 { return .disabled }
            throw error
        }
    }

    /// `POST /v1/billing/challenge` (device auth)
    public func billingChallenge() async throws -> BillingChallenge {
        try await perform("POST", ["v1", "billing", "challenge"], body: BillingChallengeRequest())
    }

    /// `POST /v1/billing/apple/attest` (device auth) → 204
    public func attestApple(keyID: String, attestation: Data, challenge: String) async throws {
        let body: Data
        do {
            body = try OyobidashiJSON.makeEncoder().encode(
                AttestAppleRequest(keyID: keyID, attestation: attestation.base64EncodedString(), challenge: challenge)
            )
        } catch {
            throw RelayError.invalidRequest(message: "encode failed: \(error)")
        }
        _ = try await raw("POST", ["v1", "billing", "apple", "attest"], bodyData: body, authorized: true)
    }

    /// `POST /v1/billing/apple` (device auth)。`payload` は組み立て済みの文字列をそのまま送る。
    public func syncApple(keyID: String, assertion: Data, payload: String) async throws -> BillingStatus {
        let body: Data
        do {
            body = try OyobidashiJSON.makeEncoder().encode(
                SyncAppleRequest(keyID: keyID, assertion: assertion.base64EncodedString(), payload: payload)
            )
        } catch {
            throw RelayError.invalidRequest(message: "encode failed: \(error)")
        }
        let (data, response) = try await sendRequest("POST", ["v1", "billing", "apple"], bodyData: body, authorized: true)
        guard (200..<300).contains(response.statusCode) else {
            if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data), envelope.error.code == "attestation_required" {
                throw BillingError.attestationRequired
            }
            throw RelayError.from(status: response.statusCode, body: data)
        }
        do {
            return try OyobidashiJSON.makeDecoder().decode(BillingStatus.self, from: data)
        } catch {
            throw RelayError.decoding(String(describing: error))
        }
    }

    /// `GET /healthz` (認証不要)
    public func health() async throws -> HealthResponse {
        try await perform("GET", ["healthz"], authorized: false)
    }

    // MARK: Durable voice turns

    private func performVoiceTurn(requestID: String, body: CallEventBody) async throws -> CallActionResponse {
        guard let text = body.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RelayError.invalidRequest(message: "empty turn")
        }
        let turnID = body.turnID ?? UUID().uuidString.lowercased()
        guard UUID(uuidString: turnID) != nil else { throw RelayError.invalidRequest(message: "invalid turn ID") }
        let encoded = try OyobidashiJSON.makeEncoder().encode(CallEventBody(event: .turn, text: text, turnID: turnID, asynchronous: true))
        let deadline = voiceTurnPolicy.now() + voiceTurnPolicy.overallTimeout
        let postPath = ["v1", "requests", requestID, "call"]
        let pollPath = ["v1", "requests", requestID, "turns", turnID]
        var recovering = body.recoveringTurn
        var accepted = false
        var posts = 0
        var consecutiveFailures = 0
        var delay: TimeInterval = 0.25

        // The deadline is the main bound; the count also protects injected clocks.
        for _ in 0..<512 {
            try Task.checkCancellationWrapped()
            guard voiceTurnPolicy.now() < deadline else { throw RelayError.turnPending }
            let isPost = !recovering
            do {
                if isPost { posts += 1 }
                let (data, status) = try await exchange(
                    isPost ? "POST" : "GET", isPost ? postPath : pollPath,
                    bodyData: isPost ? encoded : nil, authorized: true, deadline: deadline
                )
                let response: CallActionResponse
                do { response = try OyobidashiJSON.makeDecoder().decode(CallActionResponse.self, from: data) }
                catch {
                    // URLSession can return a truncated 2xx body without throwing a
                    // transport error. Delivery is uncertain: recover by ID, never
                    // invent success or blindly repeat the utterance.
                    if (try? JSONSerialization.jsonObject(with: data)) == nil {
                        throw RelayError.network(code: URLError.badServerResponse.rawValue, message: "incomplete voice turn response")
                    }
                    throw RelayError.decoding("invalid voice turn response")
                }
                guard response.request.id == requestID,
                      response.call == nil || response.call?.requestID.isEmpty == true || response.call?.requestID == requestID else {
                    throw RelayError.decoding("voice turn belongs to another request")
                }
                guard let turn = response.turn else {
                    // Older LAN relays complete synchronously and do not implement deduplication.
                    guard isPost, status == 200,
                          response.call?.turn == nil, response.request.call?.turn == nil,
                          let reply = response.reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          response.resolved != nil else {
                        throw RelayError.decoding("missing voice turn result")
                    }
                    return response
                }
                guard turn.id == turnID else { throw RelayError.decoding("mismatched voice turn ID") }
                if let nested = response.call?.turn, nested != turn {
                    throw RelayError.decoding("inconsistent voice turn result")
                }
                if let nested = response.request.call?.turn, nested != turn {
                    throw RelayError.decoding("inconsistent request turn result")
                }
                accepted = true
                consecutiveFailures = 0
                switch turn.state {
                case .queued, .running:
                    guard !turn.resolved, turn.reply == nil, turn.error == nil else {
                        throw RelayError.decoding("invalid pending voice turn")
                    }
                    recovering = true
                case .completed:
                    // Completion and polling may straddle a hangup, cancellation
                    // or a text answer. Never resume listening from an old reply.
                    if !turn.resolved && (response.request.status != .pending || response.call?.state == .ended || response.request.call?.state == .ended) {
                        throw RelayError.turnCancelled
                    }
                    guard let reply = turn.reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          turn.error == nil,
                          response.reply == nil || response.reply == reply,
                          response.resolved == nil || response.resolved == turn.resolved,
                          !turn.resolved || response.request.status == .answered else {
                        throw RelayError.decoding("invalid completed voice turn")
                    }
                    return CallActionResponse(request: response.request, call: response.call, reply: reply, resolved: turn.resolved, turn: turn)
                case .failed:
                    throw RelayError.turnFailed
                case .cancelled:
                    throw RelayError.turnCancelled
                }
            } catch {
                let error = RelayError.wrap(error)
                if error == .cancelled { throw error }
                if error == .notFound && recovering && !accepted {
                    // A legacy relay ignores turn_id; never repeat its uncertain POST.
                    guard posts < voiceTurnPolicy.maxPostAttempts,
                          try await supportsIdempotentTurns(deadline: deadline) else {
                        throw RelayError.turnPending
                    }
                    recovering = false
                } else if error.isRetryableVoiceTransport {
                    consecutiveFailures += 1
                    guard consecutiveFailures < 3 else { throw RelayError.turnPending }
                    // Recover by ID before resubmitting any POST whose result was lost.
                    recovering = true
                } else {
                    throw error
                }
            }
            let remaining = deadline - voiceTurnPolicy.now()
            guard remaining > 0 else { throw RelayError.turnPending }
            do { try await voiceTurnPolicy.sleep(min(delay, remaining)) }
            catch { throw RelayError.wrap(error) }
            delay = min(2, delay * 2)
        }
        throw RelayError.turnPending
    }

    private func supportsIdempotentTurns(deadline: TimeInterval) async throws -> Bool {
        let (data, _) = try await exchange("GET", ["healthz"], bodyData: nil, authorized: false, deadline: deadline)
        guard let health = try? OyobidashiJSON.makeDecoder().decode(HealthResponse.self, from: data) else { return false }
        return health.ok && health.capabilities?.asyncTurns == true && health.capabilities?.turnIdempotency == true
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
        try await exchange(method, segments, query: query, bodyData: bodyData, authorized: authorized).0
    }

    private func sendRequest(
        _ method: String, _ segments: [String], query: [URLQueryItem] = [], bodyData: Data?, authorized: Bool,
        deadline: TimeInterval? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        try Task.checkCancellationWrapped()
        if segments.starts(with: ["v1", "billing"]), !endpoint.isOfficialCloud {
            throw RelayError.forbidden
        }
        var request = URLRequest(url: endpoint.url(segments: segments, query: query))
        request.httpMethod = method
        request.timeoutInterval = segments.last == "call" ? max(timeout, 100) : timeout
        if let deadline {
            let remaining = deadline - voiceTurnPolicy.now()
            guard remaining > 0 else { throw RelayError.turnPending }
            request.timeoutInterval = min(request.timeoutInterval, remaining)
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized {
            // トークンが無ければ送信せずに unauthorized とする。
            guard let deviceToken, !deviceToken.isEmpty else { throw RelayError.unauthorized }
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        if segments.last == "call", let voiceAccessToken {
            request.setValue(voiceAccessToken, forHTTPHeaderField: "X-Oyobidashi-Voice-Token")
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
        try Task.checkCancellationWrapped()
        if let deadline, voiceTurnPolicy.now() >= deadline { throw RelayError.turnPending }
        return (data, response)
    }

    private func exchange(
        _ method: String, _ segments: [String], query: [URLQueryItem] = [], bodyData: Data?, authorized: Bool,
        deadline: TimeInterval? = nil
    ) async throws -> (Data, Int) {
        let (data, response) = try await sendRequest(
            method, segments, query: query, bodyData: bodyData, authorized: authorized, deadline: deadline
        )
        guard (200..<300).contains(response.statusCode) else {
            throw RelayError.from(status: response.statusCode, body: data)
        }
        return (data, response.statusCode)
    }
}

private extension Task where Success == Never, Failure == Never {
    static func checkCancellationWrapped() throws {
        if isCancelled { throw RelayError.cancelled }
    }
}

private struct BillingChallengeRequest: Encodable {}

private struct AttestAppleRequest: Encodable {
    var keyID: String
    var attestation: String
    var challenge: String
    enum CodingKeys: String, CodingKey {
        case attestation, challenge
        case keyID = "key_id"
    }
}

private struct SyncAppleRequest: Encodable {
    var keyID: String
    var assertion: String
    var payload: String
    enum CodingKeys: String, CodingKey {
        case assertion, payload
        case keyID = "key_id"
    }
}

private extension RelayError {
    var isRetryableVoiceTransport: Bool {
        switch self {
        case .network, .timeout, .server, .rateLimited: return true
        case .unexpectedResponse(let status, _, _): return status >= 500
        default: return false
        }
    }
}
