import Foundation
import XCTest
@testable import OyobidashiKit

private actor AccountSwitchTransport: HTTPTransport {
    private var waiting: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var oldURL: URL?
    var hasWaitingRequest: Bool { waiting != nil }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        if request.httpMethod == "POST", url.path == "/v1/pair" {
            return (Fixtures.data("pair_response.json"), HTTPURLResponse(url: url, statusCode: 201, httpVersion: nil, headerFields: nil)!)
        }
        if request.httpMethod == "DELETE" {
            return (Data(), HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil)!)
        }
        oldURL = url
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func finish(status: Int, body: Data) {
        guard let waiting, let oldURL else { return }
        self.waiting = nil
        waiting.resume(returning: (body, HTTPURLResponse(url: oldURL, statusCode: status, httpVersion: nil, headerFields: nil)!))
    }
}

@MainActor
final class AccountBoundaryTests: XCTestCase {
    func testOldAccountReadSuccessAndUnauthorizedResponsesCannotPopulateOrSignOutNewAccount() async throws {
        for isList in [false, true] {
            for status in [200, 401] {
                let transport = AccountSwitchTransport()
                let endpoint = try RelayEndpoint("https://relay.example")
                let credentials = InMemoryCredentialStore(Credentials(endpoint: endpoint, deviceToken: "kd_old_account", deviceID: "dev_old"))
                let model = AppModel(credentialStore: credentials, transport: transport,
                                     configuration: AppModelConfiguration(deviceName: "test", pushEnvironment: .development))
                model.drafts.set(AnswerDraft(text: "old account draft"), for: "old")
                let oldRead = Task { if isList { await model.refresh() } else { _ = await model.refreshRequest(id: "old") } }
                let began = await eventually { await transport.hasWaitingRequest }
                XCTAssertTrue(began)
                let paired = await model.pair(PairingInfo(endpoint: endpoint, code: "synthetic-pairing-code"))
                XCTAssertTrue(paired)
                let newCredentials = try XCTUnwrap(model.credentials)
                XCTAssertNotEqual(newCredentials.deviceID, "dev_old")
                let old = makeRequest(id: "old")
                let body = status == 401 ? errorBody("unauthorized") : isList ? listEnvelope([old]) : requestEnvelope(old)
                await transport.finish(status: status, body: body)
                await oldRead.value
                XCTAssertEqual(model.credentials, newCredentials)
                XCTAssertTrue(model.isPaired)
                XCTAssertTrue(model.store.requests.isEmpty)
                XCTAssertTrue(model.drafts.drafts.isEmpty)
                XCTAssertNil(model.signedOutReason)
            }
        }
    }
}
