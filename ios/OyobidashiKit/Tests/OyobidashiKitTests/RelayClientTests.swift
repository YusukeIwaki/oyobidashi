import XCTest
@testable import OyobidashiKit

final class RelayClientTests: XCTestCase {
    private let stub = StubTransport()

    private func client(_ base: String = "https://relay.example", token: String? = "kd_token") throws -> RelayClient {
        RelayClient(endpoint: try RelayEndpoint(base), deviceToken: token, transport: stub)
    }

    private func assertThrows(_ expected: RelayError, file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> Void) async {
        do {
            try await body()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch let error as RelayError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("non-RelayError thrown: \(error)", file: file, line: line)
        }
    }

    // MARK: Endpoints

    func testPair() async throws {
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        let body = try Fixtures.decode(PairRequestBody.self, "pair_request.json")
        let response = try await client(token: nil).pair(body)

        XCTAssertEqual(response.device.id, "dev_01")
        XCTAssertEqual(response.deviceToken, "test-device-token")
        let sent = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(stub.requests.count, 1)
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.absoluteString, "https://relay.example/v1/pair")
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"), "pair は認証不要")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json; charset=utf-8")
        assertJSONEqual(sent.httpBody, Fixtures.data("pair_request.json"))
    }

    func testPairDoesNotSendExistingTokenEvenIfPresent() async throws {
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        _ = try await client(token: "kd_old").pair(PairRequestBody(code: "c", deviceName: "d"))
        XCTAssertNil(stub.requests[0].value(forHTTPHeaderField: "Authorization"))
    }

    func testUpdateDevice() async throws {
        stub.on("PUT", "/v1/devices/me", status: 200, body: Data(#"{"device":{"id":"dev_01","name":"iPhone 16","platform":"ios","created_at":"2026-11-15T13:59:00.000Z"}}"#.utf8))
        let device = try await client().updateDevice(DeviceUpdateBody(pushToken: .set("abcd"), pushEnvironment: .development))

        XCTAssertEqual(device.id, "dev_01")
        let sent = stub.requests[0]
        XCTAssertEqual(sent.httpMethod, "PUT")
        XCTAssertEqual(sent.url?.absoluteString, "https://relay.example/v1/devices/me")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        assertJSONEqual(sent.httpBody, Data(#"{"push_token":"abcd","push_environment":"development"}"#.utf8))
    }

    func testDeleteDeviceAccepts204WithEmptyBody() async throws {
        stub.on("DELETE", "/v1/devices/me", status: 204)
        try await client().deleteDevice()
        let sent = stub.requests[0]
        XCTAssertEqual(sent.httpMethod, "DELETE")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        XCTAssertNil(sent.httpBody)
        XCTAssertNil(sent.value(forHTTPHeaderField: "Content-Type"))
    }

    func testListRequestsWithQuery() async throws {
        let list = [Fixtures.request("request_pending.json"), Fixtures.request("request_notification.json")]
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope(list))
        let result = try await client().listRequests(status: .pending, limit: 50)

        XCTAssertEqual(result, list)
        let sent = stub.requests[0]
        XCTAssertEqual(sent.httpMethod, "GET")
        XCTAssertEqual(sent.url?.absoluteString, "https://relay.example/v1/requests?status=pending&limit=50")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        XCTAssertNil(sent.httpBody)
    }

    func testListRequestsWithoutQueryAndEmptyResult() async throws {
        stub.on("GET", "/v1/requests", status: 200, body: Data(#"{"requests":[]}"#.utf8))
        let result = try await client().listRequests()
        XCTAssertEqual(result, [])
        XCTAssertEqual(stub.requests[0].url?.absoluteString, "https://relay.example/v1/requests")
        XCTAssertNil(stub.requests[0].url?.query, "トークンをクエリに載せない")
    }

    func testGetRequest() async throws {
        stub.on("GET", "/v1/requests/req_01JCXYZ", status: 200, body: Fixtures.data("create_request_response.json"))
        let request = try await client().getRequest(id: "req_01JCXYZ")
        XCTAssertEqual(request, Fixtures.request("request_pending.json"))
        XCTAssertEqual(stub.requests[0].httpMethod, "GET")
    }

    func testRequestIDIsPercentEncodedAsSinglePathSegment() async throws {
        stub.onAny { _ in .init(200, requestEnvelope(makeRequest())) }
        _ = try await client().getRequest(id: "a/b?c#d e%")
        XCTAssertEqual(stub.requests[0].url?.absoluteString, "https://relay.example/v1/requests/a%2Fb%3Fc%23d%20e%25")
    }

    func testAnswer() async throws {
        stub.on("POST", "/v1/requests/req_01JCXYZ/answer", status: 200, body: requestEnvelope(Fixtures.request("request_answered.json")))
        let result = try await client().answer(requestID: "req_01JCXYZ", body: AnswerBody(text: "はい", choiceIndex: 0, inputMethod: .choice))

        XCTAssertEqual(result.status, .answered)
        XCTAssertEqual(result.answer?.text, "はい")
        let sent = stub.requests[0]
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.absoluteString, "https://relay.example/v1/requests/req_01JCXYZ/answer")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json; charset=utf-8")
        assertJSONEqual(sent.httpBody, Fixtures.data("answer_request.json"))
    }

    func testHealth() async throws {
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"version":"0.1.0"}"#.utf8))
        let health = try await client(token: nil).health()
        XCTAssertEqual(health, HealthResponse(ok: true, version: "0.1.0"))
        XCTAssertNil(stub.requests[0].value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: Base URL shapes

    func testBaseURLVariants() async throws {
        stub.onAny { _ in .init(200, requestEnvelope(makeRequest())) }
        let cases: [(String, String)] = [
            ("https://relay.example", "https://relay.example/v1/requests/x"),
            ("https://relay.example/", "https://relay.example/v1/requests/x"),
            ("https://relay.example///", "https://relay.example/v1/requests/x"),
            ("https://relay.example/oyobidashi", "https://relay.example/oyobidashi/v1/requests/x"),
            ("https://relay.example/oyobidashi/", "https://relay.example/oyobidashi/v1/requests/x"),
            ("http://192.168.1.10:8787", "http://192.168.1.10:8787/v1/requests/x"),
            ("HTTPS://Relay.Example:8443/a/b/?x=1#frag", "https://Relay.Example:8443/a/b/v1/requests/x"),
            ("  https://relay.example \n", "https://relay.example/v1/requests/x"),
        ]
        for (base, expected) in cases {
            _ = try await client(base).getRequest(id: "x")
            XCTAssertEqual(stub.requests.last?.url?.absoluteString, expected, base)
        }
    }

    func testEndpointRejectsInvalidBaseURLs() {
        XCTAssertThrowsError(try RelayEndpoint("")) { XCTAssertEqual($0 as? RelayEndpointError, .malformed) }
        XCTAssertThrowsError(try RelayEndpoint("   ")) { XCTAssertEqual($0 as? RelayEndpointError, .malformed) }
        XCTAssertThrowsError(try RelayEndpoint("ftp://relay.example")) { XCTAssertEqual($0 as? RelayEndpointError, .unsupportedScheme) }
        XCTAssertThrowsError(try RelayEndpoint("relay.example")) { XCTAssertEqual($0 as? RelayEndpointError, .unsupportedScheme) }
        XCTAssertThrowsError(try RelayEndpoint("javascript:alert(1)")) { XCTAssertEqual($0 as? RelayEndpointError, .unsupportedScheme) }
        XCTAssertThrowsError(try RelayEndpoint("https://")) { XCTAssertEqual($0 as? RelayEndpointError, .missingHost) }
        XCTAssertThrowsError(try RelayEndpoint("https:///path")) { XCTAssertEqual($0 as? RelayEndpointError, .missingHost) }
    }

    func testEventsURL() throws {
        XCTAssertEqual(try RelayEndpoint("https://relay.example").eventsURL.absoluteString, "wss://relay.example/v1/events")
        XCTAssertEqual(try RelayEndpoint("http://10.0.0.2:8787/").eventsURL.absoluteString, "ws://10.0.0.2:8787/v1/events")
        XCTAssertEqual(try RelayEndpoint("https://relay.example/p/").eventsURL.absoluteString, "wss://relay.example/p/v1/events")
    }

    // MARK: Error mapping

    func testContractErrorCodesMapToTypedErrors() async throws {
        let cases: [(Int, String, RelayError)] = [
            (400, "invalid_request", .invalidRequest(message: "msg")),
            (401, "unauthorized", .unauthorized),
            (401, "pairing_code_invalid", .pairingCodeInvalid),
            (403, "forbidden", .forbidden),
            (404, "not_found", .notFound),
            (409, "already_resolved", .alreadyResolved),
            (413, "payload_too_large", .payloadTooLarge),
            (429, "rate_limited", .rateLimited),
            (500, "internal", .server(message: "msg")),
        ]
        for (status, code, expected) in cases {
            stub.onAny { _ in .init(status, errorBody(code)) }
            await assertThrows(expected) { _ = try await self.client().getRequest(id: "x") }
            await assertThrows(expected) { _ = try await self.client().answer(requestID: "x", body: AnswerBody(text: "a", inputMethod: .text)) }
            await assertThrows(expected) { try await self.client().deleteDevice() }
        }
    }

    func testErrorFixtures() async throws {
        stub.onAny { _ in .init(409, Fixtures.data("error_already_resolved.json")) }
        await assertThrows(.alreadyResolved) { _ = try await self.client().answer(requestID: "x", body: AnswerBody(text: "a", inputMethod: .text)) }
        stub.onAny { _ in .init(401, Fixtures.data("error_unauthorized.json")) }
        await assertThrows(.unauthorized) { _ = try await self.client().listRequests() }
    }

    func test401DistinguishesUnauthorizedFromPairingCodeInvalid() async throws {
        stub.on("POST", "/v1/pair", status: 401, body: errorBody("pairing_code_invalid"))
        await assertThrows(.pairingCodeInvalid) { _ = try await self.client(token: nil).pair(PairRequestBody(code: "bad", deviceName: "d")) }
        stub.on("POST", "/v1/pair", status: 401, body: errorBody("unauthorized"))
        await assertThrows(.unauthorized) { _ = try await self.client(token: nil).pair(PairRequestBody(code: "bad", deviceName: "d")) }
    }

    func testUnknownErrorCodeFallsBackToStatus() async throws {
        let cases: [(Int, RelayError)] = [
            (400, .invalidRequest(message: "msg")), (401, .unauthorized), (403, .forbidden), (404, .notFound),
            (409, .alreadyResolved), (413, .payloadTooLarge), (429, .rateLimited), (503, .server(message: "msg")),
            (418, .unexpectedResponse(status: 418, code: "teapot", message: "msg")),
        ]
        for (status, expected) in cases {
            stub.onAny { _ in .init(status, errorBody("teapot")) }
            await assertThrows(expected) { _ = try await self.client().getRequest(id: "x") }
        }
    }

    func testKnownCodeWinsOverMismatchedStatus() async throws {
        stub.onAny { _ in .init(400, errorBody("already_resolved")) }
        await assertThrows(.alreadyResolved) { _ = try await self.client().getRequest(id: "x") }
    }

    func testErrorWithoutMessageField() async throws {
        stub.onAny { _ in .init(400, Data(#"{"error":{"code":"invalid_request"}}"#.utf8)) }
        await assertThrows(.invalidRequest(message: nil)) { _ = try await self.client().getRequest(id: "x") }
    }

    func testNonContractErrorBodiesBecomeUnexpectedResponse() async throws {
        let bodies: [Data] = [
            Data("<html><body>Tunnel not found</body></html>".utf8),
            Data(),
            Data(#"{"message":"nope"}"#.utf8),
            Data(#"{"error":"string instead of object"}"#.utf8),
            Data(#"["error"]"#.utf8),
        ]
        for status in [400, 401, 403, 404, 409, 413, 429, 500, 502] {
            for body in bodies {
                stub.onAny { _ in .init(status, body) }
                await assertThrows(.unexpectedResponse(status: status, code: nil, message: nil)) {
                    _ = try await self.client().getRequest(id: "x")
                }
            }
        }
    }

    func testRedirectStatusIsUnexpected() async throws {
        stub.onAny { _ in .init(302) }
        await assertThrows(.unexpectedResponse(status: 302, code: nil, message: nil)) { _ = try await self.client().listRequests() }
    }

    func testSuccessWithUndecodableBodyIsDecodingError() async throws {
        for body in [Data("<html>ok</html>".utf8), Data(), Data(#"{"request":{"id":"only"}}"#.utf8), Data(#"{"unexpected":1}"#.utf8)] {
            stub.onAny { _ in .init(200, body) }
            do {
                _ = try await client().getRequest(id: "x")
                XCTFail("expected decoding error")
            } catch let error as RelayError {
                guard case .decoding = error else { return XCTFail("got \(error)") }
            }
        }
    }

    func testNetworkFailureAndTimeout() async throws {
        stub.onAny { _ in throw URLError(.timedOut) }
        await assertThrows(.timeout) { _ = try await self.client().listRequests() }

        stub.onAny { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await client().listRequests()
            XCTFail("expected network error")
        } catch let error as RelayError {
            guard case .network(let code, _) = error else { return XCTFail("got \(error)") }
            XCTAssertEqual(code, URLError.Code.notConnectedToInternet.rawValue)
        }

        stub.onAny { _ in throw URLError(.cancelled) }
        await assertThrows(.cancelled) { _ = try await self.client().listRequests() }

        stub.onAny { _ in throw CancellationError() }
        await assertThrows(.cancelled) { _ = try await self.client().listRequests() }

        struct Odd: Error {}
        stub.onAny { _ in throw Odd() }
        do {
            _ = try await client().listRequests()
            XCTFail("expected network error")
        } catch let error as RelayError {
            guard case .network = error else { return XCTFail("got \(error)") }
        }
    }

    func testAuthorizedCallWithoutTokenFailsWithoutSending() async throws {
        await assertThrows(.unauthorized) { _ = try await self.client(token: nil).listRequests() }
        await assertThrows(.unauthorized) { _ = try await self.client(token: "").getRequest(id: "x") }
        XCTAssertTrue(stub.requests.isEmpty)
    }

    func testEveryErrorHasAUserMessage() {
        let errors: [RelayError] = [
            .invalidRequest(message: "m"), .invalidRequest(message: nil), .unauthorized, .pairingCodeInvalid, .forbidden, .notFound,
            .alreadyResolved, .payloadTooLarge, .rateLimited, .server(message: nil), .unexpectedResponse(status: 502, code: nil, message: nil),
            .network(code: -1009, message: "offline"), .timeout, .cancelled, .decoding("x"),
        ]
        for error in errors { XCTAssertFalse(error.userMessage.isEmpty) }
    }
}
