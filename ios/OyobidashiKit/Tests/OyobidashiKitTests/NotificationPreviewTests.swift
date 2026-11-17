import Foundation
import XCTest
@testable import OyobidashiKit

final class NotificationPreviewTests: XCTestCase {
    private let stub = StubTransport()
    private let token = "kp_synthetic_preview_token_0123456789"
    private var info: [AnyHashable: Any] {
        ["request_id": "r", "recipient_device_id": "dev_current", "preview_url": "https://relay.example/v1/previews/r", "preview_token": token]
    }
    private func descriptor() throws -> NotificationPreviewDescriptor { try XCTUnwrap(NotificationPreviewDescriptor(userInfo: info)) }
    private func envelope(requestID: String = "r", recipient: String = "dev_current") -> Data {
        Data("{\"request\":".utf8) + encodeJSON(makeRequest(id: requestID)) + Data(",\"recipient_device_id\":\"\(recipient)\"}".utf8)
    }

    func testPreviewUsesAuthorizationHeaderOnlyAndThreeSecondRequestDeadline() async throws {
        stub.onAny { _ in .init(200, self.envelope()) }
        let request = try await NotificationPreviewClient(transport: stub).fetch(descriptor())
        XCTAssertEqual(request.id, "r")
        let sent = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(sent.httpMethod, "GET")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertNil(sent.url?.query)
        XCTAssertEqual(sent.timeoutInterval, 3)
        XCTAssertFalse(sent.httpShouldHandleCookies)
    }

    func testDescriptorRejectsHTTPRedirectCredentialsAndTokensInURL() {
        for url in ["http://relay.example/v1/previews/r", "https://user:password@relay.example/v1/previews/r", "https://relay.example/v1/previews/r?token=hidden", "https://relay.example/v1/previews/r#fragment", "https://relay.example/v1/previews/other", "file:///v1/previews/r"] {
            var payload = info; payload["preview_url"] = url
            XCTAssertNil(NotificationPreviewDescriptor(userInfo: payload))
        }
        for field in ["request_id", "recipient_device_id", "preview_url", "preview_token"] {
            var payload = info; payload.removeValue(forKey: field)
            XCTAssertNil(NotificationPreviewDescriptor(userInfo: payload))
        }
        var payload = info; payload["preview_token"] = "not-a-preview-capability"
        XCTAssertNil(NotificationPreviewDescriptor(userInfo: payload))
    }

    func testPreviewMustMatchBothRequestAndRecipient() async throws {
        for data in [envelope(requestID: "other"), envelope(recipient: "dev_other"), Data(#"{"request":null,"recipient_device_id":"dev_current"}"#.utf8)] {
            stub.onAny { _ in .init(200, data) }
            do { _ = try await NotificationPreviewClient(transport: stub).fetch(descriptor()); XCTFail("wrong preview accepted") }
            catch { XCTAssertEqual(error as? NotificationPreviewError, .invalidResponse) }
        }
    }

    func testExpiredRevokedAndServerErrorsFailSafelyWithoutReturningPrivateResponseBody() async throws {
        for status in [401, 403, 404, 429, 500, 503] {
            stub.onAny { _ in .init(status, Data("private provider error".utf8)) }
            do { _ = try await NotificationPreviewClient(transport: stub).fetch(descriptor()); XCTFail("unexpected success") }
            catch { XCTAssertEqual(error as? NotificationPreviewError, .invalidResponse) }
        }
    }

    func testOversizedBodyAndMalformedJSONAreRejected() async throws {
        for data in [Data(repeating: 0x20, count: NotificationPreviewClient.maxBytes + 1), Data("{\"request\":".utf8)] {
            stub.onAny { _ in .init(200, data) }
            do { _ = try await NotificationPreviewClient(transport: stub).fetch(descriptor()); XCTFail("invalid preview accepted") }
            catch { XCTAssertEqual(error as? NotificationPreviewError, .invalidResponse) }
        }
    }

    func testTransportFailureReturnsGenericError() async throws {
        stub.onAny { _ in throw URLError(.timedOut) }
        do { _ = try await NotificationPreviewClient(transport: stub).fetch(descriptor()); XCTFail("unexpected success") }
        catch { XCTAssertEqual(error as? NotificationPreviewError, .unavailable) }
    }

    func testRedirectedResponseCannotRestoreContent() async throws {
        struct Redirected: HTTPTransport {
            let body: Data
            func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                (body, HTTPURLResponse(url: URL(string: "https://other.example/v1/previews/r")!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
            }
        }
        do { _ = try await NotificationPreviewClient(transport: Redirected(body: envelope())).fetch(descriptor()); XCTFail("redirect accepted") }
        catch { XCTAssertEqual(error as? NotificationPreviewError, .invalidResponse) }
    }

    func testCloudFallbackRemovesEmbeddedPrivateContentAndCapabilitySecrets() {
        var payload = info
        payload["question"] = "private question"
        payload["context"] = "private context"
        payload["choices"] = ["private action"]
        payload["aps"] = ["alert": ["title": "private name", "body": "private body"], "category": "OYOBIDASHI_ACTIONS_1"]
        let safe = NotificationPreviewPrivacy.safeUserInfo(payload)
        for key in ["preview_token", "preview_url", "question", "context", "choices"] { XCTAssertNil(safe[key]) }
        XCTAssertEqual(safe["request_id"] as? String, "r")
        XCTAssertEqual(safe["recipient_device_id"] as? String, "dev_current")
        let aps = safe["aps"] as? [AnyHashable: Any]
        let alert = aps?["alert"] as? [String: String]
        XCTAssertEqual(alert?["title"], NotificationPreviewPrivacy.title)
        XCTAssertEqual(alert?["body"], NotificationPreviewPrivacy.body)
        XCTAssertEqual(aps?["category"] as? String, PushCategory.notification)
        let silent: [AnyHashable: Any] = ["recipient_device_id": "dev_current", "aps": ["content-available": 1]]
        XCTAssertNil((NotificationPreviewPrivacy.safeUserInfo(silent)["aps"] as? [AnyHashable: Any])?["alert"], "Do not turn a silent update into an alert")
    }

    func testLegacyFallbackRetainsExistingLANChoices() {
        let legacy: [AnyHashable: Any] = ["request_id": "r", "choices": ["はい", "いいえ"]]
        let safe = NotificationPreviewPrivacy.safeUserInfo(legacy)
        XCTAssertEqual(safe["choices"] as? [String], ["はい", "いいえ"])
    }
}
