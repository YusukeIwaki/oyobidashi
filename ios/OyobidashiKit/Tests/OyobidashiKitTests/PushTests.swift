import XCTest
@testable import OyobidashiKit

final class PushTests: XCTestCase {
    private func fixtureUserInfo() throws -> [AnyHashable: Any] {
        let object = try JSONSerialization.jsonObject(with: Fixtures.data("apns_payload.json"))
        return try XCTUnwrap(object as? [AnyHashable: Any])
    }

    func testAPNsFixture() throws {
        let payload = try XCTUnwrap(PushPayload(userInfo: fixtureUserInfo()))
        XCTAssertEqual(payload.requestID, "req_01JCXYZ")
        XCTAssertEqual(payload.kind, .question)
        XCTAssertEqual(payload.title, "claude-code からの質問")
        XCTAssertEqual(payload.body, "本番DBのマイグレーションを実行してよいですか?\n1: はい / 2: いいえ")
        XCTAssertEqual(payload.category, "OYOBIDASHI_ACTIONS_2")
    }

    func testNotificationKind() {
        let payload = PushPayload(userInfo: ["aps": ["alert": ["title": "t", "body": "b"], "category": "OYOBIDASHI_NOTIFICATION"], "request_id": "r", "kind": "notification"])
        XCTAssertEqual(payload?.kind, .notification)
        XCTAssertEqual(payload?.category, PushCategory.notification)
    }

    func testKindFallsBackToCategoryThenQuestion() {
        XCTAssertEqual(PushPayload(userInfo: ["aps": ["category": "OYOBIDASHI_NOTIFICATION"], "request_id": "r"])?.kind, .notification)
        XCTAssertEqual(PushPayload(userInfo: ["aps": ["category": "OYOBIDASHI_QUESTION"], "request_id": "r"])?.kind, .question)
        XCTAssertEqual(PushPayload(userInfo: ["request_id": "r"])?.kind, .question)
        XCTAssertEqual(PushPayload(userInfo: ["request_id": "r", "kind": ""])?.kind, .question)
        XCTAssertEqual(PushPayload(userInfo: ["request_id": "r", "kind": 5])?.kind, .question)
        XCTAssertEqual(PushPayload(userInfo: ["request_id": "r", "kind": "poll"])?.kind, .unknown("poll"))
    }

    func testMalformedPayloadsReturnNil() {
        XCTAssertNil(PushPayload(userInfo: [:]))
        XCTAssertNil(PushPayload(userInfo: ["aps": ["alert": "hi"]]))
        XCTAssertNil(PushPayload(userInfo: ["request_id": ""]))
        XCTAssertNil(PushPayload(userInfo: ["request_id": 42]))
        XCTAssertNil(PushPayload(userInfo: ["request_id": NSNull()]))
        XCTAssertNil(PushPayload(userInfo: ["request_id": ["req"]]))
        XCTAssertNil(PushPayload(userInfo: ["REQUEST_ID": "r"]))
    }

    func testOddButUsablePayloads() {
        let noAps = PushPayload(userInfo: ["request_id": "r", "kind": "question"])
        XCTAssertEqual(noAps, PushPayload(requestID: "r", kind: .question))

        let stringAlert = PushPayload(userInfo: ["aps": ["alert": "only body"], "request_id": "r"])
        XCTAssertNil(stringAlert?.title)
        XCTAssertEqual(stringAlert?.body, "only body")

        let wrongTypes = PushPayload(userInfo: ["aps": "nope", "request_id": "r", "extra": [1, 2]])
        XCTAssertEqual(wrongTypes, PushPayload(requestID: "r", kind: .question))

        let partialAlert = PushPayload(userInfo: ["aps": ["alert": ["title": 1, "body": "b"], "category": 9], "request_id": "r"])
        XCTAssertNil(partialAlert?.title)
        XCTAssertEqual(partialAlert?.body, "b")
        XCTAssertNil(partialAlert?.category)
    }

    func testUserInfoForLocalNotificationRoundTrips() {
        let request = Fixtures.request("request_notification.json")
        let payload = PushPayload(userInfo: PushPayload.userInfo(for: request))
        XCTAssertEqual(payload, PushPayload(requestID: "req_01JCNTF", kind: .notification))
    }

    func testAPNsTokenHex() {
        XCTAssertEqual(APNsToken.hexString(from: Data()), "")
        XCTAssertEqual(APNsToken.hexString(from: Data([0x00, 0x0f, 0xa1, 0xff])), "000fa1ff")
        let bytes = Data((0..<32).map { UInt8($0 * 8 % 256) })
        let hex = APNsToken.hexString(from: bytes)
        XCTAssertEqual(hex.count, 64)
        XCTAssertEqual(hex, hex.lowercased())
        XCTAssertTrue(hex.hasPrefix("0008101820"))
    }

    func testNotificationTextFollowsContract() {
        XCTAssertEqual(NotificationText.title(for: Fixtures.request("request_pending.json")), "claude-code からの質問")
        XCTAssertEqual(NotificationText.title(for: Fixtures.request("request_notification.json")), "codex からのお知らせ")
        XCTAssertEqual(NotificationText.title(for: Fixtures.request("request_minimal_voice_answered.json")), "エージェントからの質問")
        var anonymous = Fixtures.request("request_notification.json")
        anonymous.agent = AgentInfo(name: "", cwd: nil)
        XCTAssertEqual(NotificationText.title(for: anonymous), "エージェントからのお知らせ")

        var long = Fixtures.request("request_pending.json")
        long.question = String(repeating: "あ", count: 1500)
        XCTAssertEqual(NotificationText.body(for: long).count, 1000)
        XCTAssertEqual(NotificationText.body(for: Fixtures.request("request_pending.json")), "本番DBのマイグレーションを実行してよいですか?")
    }
}
