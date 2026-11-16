import Foundation
import XCTest
@testable import OyobidashiKit

@MainActor
final class PresenceSynchronizationTests: XCTestCase {
    func testDelayedRefreshDoesNotReplaceNewSelection() async {
        let transport = DelayedPresenceTransport()
        let credentials = InMemoryCredentialStore()
        try! credentials.save(Credentials(endpoint: try! RelayEndpoint("http://localhost:8787"), deviceToken: "test-device-token", deviceID: "dev_01"))
        let model = AppModel(credentialStore: credentials, transport: transport,
                             configuration: AppModelConfiguration(deviceName: "Test", pushEnvironment: .development))
        let refresh = Task { await model.refreshPresence() }
        let waiting = await eventually { await transport.waitingForRefresh }
        XCTAssertTrue(waiting)

        let saved = await model.updatePresence(availability: .away)
        XCTAssertTrue(saved)
        await transport.completeRefresh()
        await refresh.value

        XCTAssertEqual(model.presenceAvailability, .away, "操作前の取得結果で、新しい選択を上書きしない")
    }

    func testRefreshPreservesUnsavedSelectionAfterNetworkFailure() async {
        let transport = StubTransport()
        transport.on("PUT", "/v1/presence") { _ in throw URLError(.notConnectedToInternet) }
        transport.on("GET", "/v1/presence", status: 200, body: Data(#"{"devices":[{"device_id":"dev_01","availability":"available"}]}"#.utf8))
        let credentials = InMemoryCredentialStore()
        try! credentials.save(Credentials(endpoint: try! RelayEndpoint("http://localhost:8787"), deviceToken: "test-device-token", deviceID: "dev_01"))
        let model = AppModel(credentialStore: credentials, transport: transport,
                             configuration: AppModelConfiguration(deviceName: "Test", pushEnvironment: .development))

        let saved = await model.updatePresence(availability: .busy)
        XCTAssertFalse(saved)
        await model.refreshPresence()

        XCTAssertEqual(model.presenceAvailability, .busy)
        XCTAssertNotNil(model.presenceError, "送信できなかった状態の再送信を案内する")

        transport.on("PUT", "/v1/presence", status: 200)
        let retried = await model.updatePresence(availability: .busy)
        XCTAssertTrue(retried)
        XCTAssertNil(model.presenceError)
    }
}

private actor DelayedPresenceTransport: HTTPTransport {
    private var refresh: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    var waitingForRefresh: Bool { refresh != nil }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if request.httpMethod == "GET" {
            return try await withCheckedThrowingContinuation { refresh = $0 }
        }
        return (Data(), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    func completeRefresh() {
        let data = Data(#"{"devices":[{"device_id":"dev_01","availability":"available"}]}"#.utf8)
        let response = HTTPURLResponse(url: URL(string: "http://localhost:8787/v1/presence")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        refresh?.resume(returning: (data, response))
        refresh = nil
    }
}
