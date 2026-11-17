import Network
import XCTest
@testable import OyobidashiKit

/// URLSession 実装 (HTTP / WebSocket) を、ループバック上の最小限の平文サーバーに対して確認する。
/// relay 本体ではなく「契約どおりの応答を返すだけの TCP サーバー」であり、結合テストではない。
final class URLSessionIntegrationTests: XCTestCase {
    /// 受け取ったリクエスト (ヘッダーまで) に対して固定の応答を返して閉じる HTTP/1.1 サーバー。
    private final class RawServer: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var received: [String] = []
        private let respond: @Sendable (String) -> Data

        var requests: [String] { lock.withLock { received } }
        var port: UInt16 { listener.port?.rawValue ?? 0 }

        init(respond: @escaping @Sendable (String) -> Data) throws {
            self.respond = respond
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: parameters)
        }

        func start() async throws {
            let ready = AsyncStream<Result<Void, Error>>.makeStream()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: ready.continuation.yield(.success(()))
                case .failed(let error): ready.continuation.yield(.failure(error))
                default: break
                }
            }
            listener.newConnectionHandler = { [self] connection in
                connection.start(queue: .global())
                read(connection, buffer: Data())
            }
            listener.start(queue: .global())
            for await result in ready.stream {
                try result.get()
                return
            }
        }

        private func read(_ connection: NWConnection, buffer: Data) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
                var buffer = buffer
                if let data { buffer.append(data) }
                let text = String(decoding: buffer, as: UTF8.self)
                if text.contains("\r\n\r\n") {
                    lock.withLock { received.append(text) }
                    connection.send(content: respond(text), completion: .contentProcessed { _ in connection.cancel() })
                } else if isComplete || error != nil {
                    connection.cancel()
                } else {
                    read(connection, buffer: buffer)
                }
            }
        }

        func stop() { listener.cancel() }
    }

    private func http(_ status: String, json: String) -> Data {
        Data("HTTP/1.1 \(status)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(json.utf8.count)\r\nConnection: close\r\n\r\n\(json)".utf8)
    }

    private func startServer(_ respond: @escaping @Sendable (String) -> Data) async throws -> RawServer {
        let server = try RawServer(respond: respond)
        do {
            try await server.start()
        } catch {
            throw XCTSkip("cannot listen on loopback in this environment: \(error)")
        }
        return server
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        return URLSession(configuration: configuration)
    }

    func testURLSessionTransportOverPlainHTTPSendsBearerAndMapsContractError() async throws {
        let body = Fixtures.string("error_already_resolved.json")
        let server = try await startServer { [http] _ in http("409 Conflict", body) }
        defer { server.stop() }
        let client = RelayClient(
            endpoint: try RelayEndpoint("http://127.0.0.1:\(server.port)"), deviceToken: "kd_token",
            transport: URLSessionTransport(session: session())
        )
        do {
            _ = try await client.answer(requestID: "req_01JCXYZ", body: AnswerBody(text: "はい", choiceIndex: 0, inputMethod: .choice))
            XCTFail("expected alreadyResolved")
        } catch let error as RelayError {
            XCTAssertEqual(error, .alreadyResolved)
        }
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertTrue(request.hasPrefix("POST /v1/requests/req_01JCXYZ/answer HTTP/1.1\r\n"), request)
        XCTAssertTrue(request.contains("Authorization: Bearer kd_token\r\n"), request)
        XCTAssertTrue(request.lowercased().contains("content-type: application/json; charset=utf-8\r\n"), request)
    }

    func testURLSessionTransportConnectionRefusedIsUnreachable() async throws {
        let server = try await startServer { _ in Data() }
        let port = server.port
        server.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        let client = RelayClient(
            endpoint: try RelayEndpoint("http://127.0.0.1:\(port)"), deviceToken: "kd_token",
            transport: URLSessionTransport(session: session())
        )
        do {
            _ = try await client.listRequests()
            XCTFail("expected a network error")
        } catch let error as RelayError {
            XCTAssertTrue(error.isUnreachable, "\(error)")
        }
    }

    func testCommittedVoiceTurnIsRecoveredAfterRealTCPResponseTruncation() async throws {
        let turnID = "f353b77b-94f0-44d3-85b2-87602f70b938"
        let requestID = "req_01JCXYZ"
        let requestJSON = Fixtures.string("request_pending.json")
        let complete = "{\"request\":\(requestJSON),\"turn\":{\"id\":\"\(turnID)\",\"state\":\"completed\",\"reply\":\"受け取りました\",\"resolved\":false,\"error\":null}}"
        let server = try await startServer { [http] request in
            if request.hasPrefix("POST ") {
                // The server committed the job but its response was cut off mid-body.
                return Data("HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 2048\r\nConnection: close\r\n\r\n{\"request\":".utf8)
            }
            return http("200 OK", complete)
        }
        defer { server.stop() }
        let client = RelayClient(endpoint: try RelayEndpoint("http://127.0.0.1:\(server.port)"), deviceToken: "kd_test",
                                 transport: URLSessionTransport(session: session()), voiceTurnPolicy: VoiceTurnPolicy(overallTimeout: 5))
        let response = try await client.sendCallTurn(requestID: requestID, text: "はい", turnID: turnID)
        XCTAssertEqual(response.reply, "受け取りました")
        XCTAssertEqual(server.requests.filter { $0.hasPrefix("POST ") }.count, 1)
        XCTAssertEqual(server.requests.filter { $0.hasPrefix("GET /v1/requests/\(requestID)/turns/\(turnID) ") }.count, 1)
    }

    func testPreviewTransportDoesNotFollowRealHTTPRedirect() async throws {
        let server = try await startServer { request in
            if request.hasPrefix("GET /preview ") {
                return Data("HTTP/1.1 302 Found\r\nLocation: /must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
            }
            return Data("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
        }
        defer { server.stop() }
        // HTTP is used only for this loopback transport test. Production preview
        // descriptors require HTTPS before the transport is invoked.
        let request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/preview")!)
        let (_, response) = try await NotificationPreviewTransport().send(request)
        XCTAssertEqual(response.statusCode, 302)
        XCTAssertEqual(server.requests.count, 1)
    }

    func testPreviewTransportRejectsOversizedRealResponseBeforeBuffering() async throws {
        let server = try await startServer { _ in
            let size = NotificationPreviewClient.maxBytes + 1
            return Data("HTTP/1.1 200 OK\r\nContent-Length: \(size)\r\nConnection: close\r\n\r\n".utf8) + Data(repeating: 0x20, count: size)
        }
        defer { server.stop() }
        do {
            _ = try await NotificationPreviewTransport().send(URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/preview")!))
            XCTFail("oversized preview accepted")
        } catch { XCTAssertEqual(error as? NotificationPreviewError, .invalidResponse) }
    }

    func testWebSocketUpgradeRejectedWith401IsReportedAsUnauthorized() async throws {
        let body = Fixtures.string("error_unauthorized.json")
        let server = try await startServer { [http] _ in http("401 Unauthorized", body) }
        defer { server.stop() }
        var request = URLRequest(url: try RelayEndpoint("http://127.0.0.1:\(server.port)").eventsURL)
        request.setValue("Bearer kd_bad", forHTTPHeaderField: "Authorization")

        let connection = try await URLSessionWebSocketConnector(session: session()).connect(request)
        defer { connection.close() }
        do {
            _ = try await connection.receive()
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? RelayError, .unauthorized, "\(error)")
        }
        let received = try XCTUnwrap(server.requests.first)
        XCTAssertTrue(received.hasPrefix("GET /v1/events HTTP/1.1\r\n"), received)
        XCTAssertTrue(received.contains("Authorization: Bearer kd_bad\r\n"), received)
        XCTAssertTrue(received.lowercased().contains("upgrade: websocket"), received)
    }

    func testWebSocketUpgradeRejectedWithOtherStatusIsNotUnauthorized() async throws {
        let server = try await startServer { [http] _ in http("403 Forbidden", #"{"error":{"code":"forbidden","message":"x"}}"#) }
        defer { server.stop() }
        let request = URLRequest(url: try RelayEndpoint("http://127.0.0.1:\(server.port)").eventsURL)
        let connection = try await URLSessionWebSocketConnector(session: session()).connect(request)
        defer { connection.close() }
        do {
            _ = try await connection.receive()
            XCTFail("expected an error")
        } catch {
            XCTAssertNotEqual(error as? RelayError, .unauthorized)
        }
    }

    func testEventStreamClientStopsOnReal401() async throws {
        let body = Fixtures.string("error_unauthorized.json")
        let server = try await startServer { [http] _ in http("401 Unauthorized", body) }
        defer { server.stop() }
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        let client = EventStreamClient(
            endpoint: try RelayEndpoint("http://127.0.0.1:\(server.port)"), deviceToken: "kd_bad",
            connector: URLSessionWebSocketConnector(session: session()), sleeper: sleeper, pingInterval: nil
        )
        await client.run(handler: collector.handler())
        XCTAssertEqual(collector.signals, [.state(.connecting), .state(.unauthorized)])
        XCTAssertEqual(sleeper.delays, [])
        XCTAssertEqual(server.requests.count, 1)
    }
}
