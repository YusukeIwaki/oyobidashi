import XCTest
@testable import OyobidashiKit

final class CallSubjectTests: XCTestCase {
    func testRequestSubjectSurvivesEncodingAndBuildsCallerName() throws {
        var request = try Fixtures.decode(AgentRequest.self, "request_pending.json")
        XCTAssertNil(request.subject)
        XCTAssertEqual(request.incomingCallerName, "claude-code")
        request.subject = "本番デプロイの承認"
        let decoded = try OyobidashiJSON.makeDecoder().decode(AgentRequest.self, from: encodeJSON(request))
        XCTAssertEqual(decoded.subject, request.subject)
        XCTAssertEqual(decoded.incomingCallerName, "claude-code：本番デプロイの承認")
        request.agent = nil
        request.subject = nil
        XCTAssertEqual(request.incomingCallerName, "エージェント")
    }

    func testVoIPSubjectIsAvailableBeforeFetchingTheRequest() throws {
        let payload = try XCTUnwrap(VoIPPayload(userInfo: [
            "request_id": "r", "call_id": "c",
            "agent_name": "Codex", "subject": "本番デプロイの承認",
        ]))
        XCTAssertEqual(payload.subject, "本番デプロイの承認")
        XCTAssertEqual(payload.incomingCallerName, "Codex：本番デプロイの承認")
        let cloud = try XCTUnwrap(VoIPPayload(userInfo: [
            "request_id": "r", "call_id": "c", "subject": "本番デプロイの承認",
        ]))
        XCTAssertEqual(cloud.incomingCallerName, "お呼び出し：本番デプロイの承認")
    }

    func testLegacyAndMalformedPushesKeepTheDefaultCallerName() throws {
        for subject: Any in [NSNull(), 42, "", " \n\t "] {
            let payload = try XCTUnwrap(VoIPPayload(userInfo: ["request_id": "r", "call_id": "c", "subject": subject]))
            XCTAssertEqual(payload.incomingCallerName, "お呼び出し")
        }
        XCTAssertEqual(VoIPPayload(userInfo: ["request_id": "r", "call_id": "c"])?.incomingCallerName, "お呼び出し")
        XCTAssertEqual(CallPresentation.callerName(agentName: " Codex ", subject: " 承認\n の確認 "), "Codex：承認 の確認")
    }
}
