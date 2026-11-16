import XCTest
@testable import OyobidashiKit

final class ModelsTests: XCTestCase {
    // MARK: Fixtures

    func testDecodePendingRequestFixture() throws {
        let r = try Fixtures.decode(AgentRequest.self, "request_pending.json")
        XCTAssertEqual(r.id, "req_01JCXYZ")
        XCTAssertEqual(r.kind, .question)
        XCTAssertEqual(r.question, "本番DBのマイグレーションを実行してよいですか?")
        XCTAssertEqual(r.context, "users テーブルに列を追加します")
        XCTAssertEqual(r.choices, ["はい", "いいえ"])
        XCTAssertEqual(r.urgency, .normal)
        XCTAssertEqual(r.status, .pending)
        XCTAssertNil(r.answer)
        XCTAssertEqual(r.agent, AgentInfo(name: "claude-code", cwd: "/path/to/project"))
        XCTAssertEqual(r.createdAt, Date(timeIntervalSince1970: 1_794_751_200))
        XCTAssertEqual(r.updatedAt, r.createdAt)
        XCTAssertEqual(r.expiresAt, r.createdAt.addingTimeInterval(3600))
        XCTAssertTrue(r.isAnswerable)
    }

    func testDecodeAnsweredRequestFixture() throws {
        let r = try Fixtures.decode(AgentRequest.self, "request_answered.json")
        XCTAssertEqual(r.status, .answered)
        XCTAssertFalse(r.isAnswerable)
        let answer = try XCTUnwrap(r.answer)
        XCTAssertEqual(answer.text, "はい")
        XCTAssertEqual(answer.choiceIndex, 0)
        XCTAssertEqual(answer.inputMethod, .choice)
        XCTAssertEqual(answer.deviceID, "dev_01")
        XCTAssertEqual(answer.answeredAt, r.createdAt.addingTimeInterval(60))
    }

    func testDecodeMinimalVoiceAnsweredFixture() throws {
        let r = try Fixtures.decode(AgentRequest.self, "request_minimal_voice_answered.json")
        XCTAssertNil(r.context)
        XCTAssertNil(r.choices)
        XCTAssertNil(r.agent)
        XCTAssertEqual(r.urgency, .high)
        XCTAssertEqual(r.answer?.inputMethod, .voice)
        XCTAssertNil(r.answer?.choiceIndex)
        // ミリ秒 (.250) が保持される
        XCTAssertEqual(r.answer?.answeredAt, date("2026-11-15T14:05:30.000Z").addingTimeInterval(0.25))
        XCTAssertEqual(r.updatedAt.timeIntervalSince(r.createdAt), 30.25, accuracy: 0.0001)
    }

    func testDecodeNotificationFixture() throws {
        let r = try Fixtures.decode(AgentRequest.self, "request_notification.json")
        XCTAssertEqual(r.kind, .notification)
        XCTAssertEqual(r.status, .notified)
        XCTAssertTrue(r.status.isTerminal)
        XCTAssertFalse(r.isAnswerable)
        XCTAssertEqual(r.agent, AgentInfo(name: "codex", cwd: nil))
    }

    func testDecodeCreateRequestResponseFixtureIgnoringDelivery() throws {
        let envelope = try Fixtures.decode(RequestEnvelope.self, "create_request_response.json")
        XCTAssertEqual(envelope.request, Fixtures.request("request_pending.json"))
    }

    func testDecodePairResponseFixture() throws {
        let r = try Fixtures.decode(PairResponse.self, "pair_response.json")
        XCTAssertEqual(r.deviceToken, "test-device-token")
        XCTAssertEqual(r.device, Device(id: "dev_01", name: "iPhone 16", platform: .ios, createdAt: date("2026-11-15T13:59:00.000Z")))
    }

    func testDecodeErrorFixtures() throws {
        let resolved = try Fixtures.decode(ErrorEnvelope.self, "error_already_resolved.json")
        XCTAssertEqual(resolved.error.code, "already_resolved")
        XCTAssertEqual(resolved.error.message, "request is already answered")
        let unauthorized = try Fixtures.decode(ErrorEnvelope.self, "error_unauthorized.json")
        XCTAssertEqual(unauthorized.error.code, "unauthorized")
    }

    func testDecodeEventFixtures() throws {
        XCTAssertEqual(
            try Fixtures.decode(RelayEvent.self, "event_hello.json"),
            .hello(pending: [Fixtures.request("request_pending.json")])
        )
        guard case .updated(let r) = try Fixtures.decode(RelayEvent.self, "event_request_updated.json") else {
            return XCTFail("expected request.updated")
        }
        XCTAssertEqual(r.status, .cancelled)
        XCTAssertEqual(r.updatedAt, date("2026-11-15T14:02:00.000Z"))
    }

    func testFCMFixtureIsAFlatStringMap() throws {
        // iOS では使わないが、契約のフィクスチャとして読めることだけ確認する。
        let data = try Fixtures.decode([String: String].self, "fcm_data.json")
        XCTAssertEqual(data["request_id"], "req_01JCXYZ")
    }

    // MARK: Request bodies

    func testPairRequestBodyMatchesFixture() throws {
        let body = PairRequestBody(
            code: "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21", deviceName: "iPhone 16", platform: .ios,
            pushToken: "0000000000000000000000000000000000000000000000000000000000000000", pushEnvironment: .development
        )
        assertJSONEqual(encodeJSON(body), Fixtures.data("pair_request.json"))
        XCTAssertEqual(try Fixtures.decode(PairRequestBody.self, "pair_request.json"), body)
    }

    func testPairRequestBodyOmitsNilPushFields() throws {
        let body = PairRequestBody(code: "c", deviceName: "d")
        assertJSONEqual(encodeJSON(body), Data(#"{"code":"c","device_name":"d","platform":"ios"}"#.utf8))
    }

    func testAnswerBodyMatchesFixture() throws {
        let body = AnswerBody(text: "はい", choiceIndex: 0, inputMethod: .choice)
        assertJSONEqual(encodeJSON(body), Fixtures.data("answer_request.json"))
        XCTAssertEqual(try Fixtures.decode(AnswerBody.self, "answer_request.json"), body)
    }

    func testAnswerBodyOmitsChoiceIndexForTextAndVoice() {
        assertJSONEqual(encodeJSON(AnswerBody(text: "a", inputMethod: .text)), Data(#"{"text":"a","input_method":"text"}"#.utf8))
        assertJSONEqual(encodeJSON(AnswerBody(text: "a", inputMethod: .voice)), Data(#"{"text":"a","input_method":"voice"}"#.utf8))
    }

    func testDeviceUpdateBodyEncodesOnlySpecifiedFields() {
        assertJSONEqual(encodeJSON(DeviceUpdateBody()), Data("{}".utf8))
        assertJSONEqual(
            encodeJSON(DeviceUpdateBody(pushToken: .set("abc"), pushEnvironment: .development)),
            Data(#"{"push_token":"abc","push_environment":"development"}"#.utf8)
        )
        assertJSONEqual(encodeJSON(DeviceUpdateBody(pushToken: .clear)), Data(#"{"push_token":null}"#.utf8))
        assertJSONEqual(
            encodeJSON(DeviceUpdateBody(pushEnvironment: .production, deviceName: "x")),
            Data(#"{"push_environment":"production","device_name":"x"}"#.utf8)
        )
    }

    // MARK: Tolerance

    private func decodeRequest(_ json: String) throws -> AgentRequest {
        try OyobidashiJSON.makeDecoder().decode(AgentRequest.self, from: Data(json.utf8))
    }

    func testUnknownFieldsAreIgnored() throws {
        let r = try decodeRequest("""
        {"id":"r","kind":"question","question":"q","status":"pending","urgency":"normal","future":{"a":[1,2]},
         "agent":{"name":"n","pid":123},"created_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z",
         "answer":null,"another_new_field":true}
        """)
        XCTAssertEqual(r.id, "r")
        XCTAssertEqual(r.agent?.name, "n")
    }

    func testMissingOptionalsEqualNulls() throws {
        let missing = try decodeRequest(#"{"id":"r","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#)
        let nulls = try decodeRequest("""
        {"id":"r","kind":null,"question":"q","context":null,"choices":null,"urgency":null,"status":"pending","answer":null,
         "agent":null,"created_at":"2026-11-15T14:00:00.000Z","updated_at":null,"expires_at":null}
        """)
        XCTAssertEqual(missing, nulls)
        XCTAssertEqual(missing.kind, .question)
        XCTAssertEqual(missing.urgency, .normal)
        XCTAssertEqual(missing.updatedAt, missing.createdAt)
        XCTAssertNil(missing.expiresAt)
        XCTAssertEqual(missing.effectiveChoices, [])
    }

    func testUnknownEnumValuesArePreservedAndNotAnswerable() throws {
        let r = try decodeRequest("""
        {"id":"r","kind":"poll","question":"q","status":"snoozed","urgency":"critical","created_at":"2026-11-15T14:00:00.000Z",
         "answer":{"text":"t","input_method":"gesture"}}
        """)
        XCTAssertEqual(r.kind, .unknown("poll"))
        XCTAssertEqual(r.status, .unknown("snoozed"))
        XCTAssertEqual(r.urgency, .unknown("critical"))
        XCTAssertEqual(r.answer?.inputMethod, .unknown("gesture"))
        XCTAssertFalse(r.isAnswerable)
        XCTAssertFalse(r.status.isTerminal)
        // 再エンコードしても生の値が保たれる
        let reencoded = try decodeRequest(String(decoding: encodeJSON(r), as: UTF8.self))
        XCTAssertEqual(reencoded, r)
    }

    func testUnknownKindWithPendingStatusIsNotAnswerable() throws {
        let r = try decodeRequest(#"{"id":"r","kind":"poll","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#)
        XCTAssertFalse(r.isAnswerable)
    }

    func testMissingRequiredFieldsFailDecoding() {
        XCTAssertThrowsError(try decodeRequest(#"{"question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#))
        XCTAssertThrowsError(try decodeRequest(#"{"id":"r","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#))
        XCTAssertThrowsError(try decodeRequest(#"{"id":"r","question":"q","created_at":"2026-11-15T14:00:00.000Z"}"#))
        XCTAssertThrowsError(try decodeRequest(#"{"id":"r","question":"q","status":"pending"}"#))
        XCTAssertThrowsError(try decodeRequest(#"{"id":null,"question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#))
        XCTAssertThrowsError(try decodeRequest(#"{"id":"r","question":"q","status":"pending","created_at":"yesterday"}"#))
        XCTAssertThrowsError(try decodeRequest("[]"))
        XCTAssertThrowsError(try decodeRequest("not json"))
    }

    func testWrongTypedOptionalFieldsBecomeNil() throws {
        let r = try decodeRequest("""
        {"id":"r","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z",
         "context":42,"choices":"はい","agent":"claude","expires_at":"soon","answer":{"no_text":true}}
        """)
        XCTAssertNil(r.context)
        XCTAssertNil(r.choices)
        XCTAssertNil(r.agent)
        XCTAssertNil(r.expiresAt)
        XCTAssertNil(r.answer)
    }

    func testAnswerDecodingDefaults() throws {
        let a = try OyobidashiJSON.makeDecoder().decode(Answer.self, from: Data(#"{"text":"t"}"#.utf8))
        XCTAssertEqual(a, Answer(text: "t", choiceIndex: nil, inputMethod: .text, deviceID: nil, answeredAt: nil))
    }

    func testDeviceDecodingTolerance() throws {
        let d = try OyobidashiJSON.makeDecoder().decode(Device.self, from: Data(#"{"id":"dev","platform":"watchos","extra":1}"#.utf8))
        XCTAssertEqual(d, Device(id: "dev", name: nil, platform: .unknown("watchos"), createdAt: nil))
        XCTAssertThrowsError(try OyobidashiJSON.makeDecoder().decode(Device.self, from: Data(#"{"name":"x"}"#.utf8)))
    }

    func testRequestListSkipsUndecodableElements() throws {
        let json = """
        {"requests":[{"id":"a","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"},
                     {"id":"broken"}, 42,
                     {"id":"b","question":"q","status":"answered","created_at":"2026-11-15T14:00:01.000Z"}]}
        """
        let list = try OyobidashiJSON.makeDecoder().decode(RequestListEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(list.requests.map(\.id), ["a", "b"])
        XCTAssertThrowsError(try OyobidashiJSON.makeDecoder().decode(RequestListEnvelope.self, from: Data("{}".utf8)))
    }

    // MARK: Dates

    func testDateParsing() throws {
        let base = Date(timeIntervalSince1970: 1_794_751_200) // 2026-11-15T14:00:00Z
        XCTAssertEqual(OyobidashiJSON.parseDate("2026-11-15T14:00:00.000Z"), base)
        XCTAssertEqual(try XCTUnwrap(OyobidashiJSON.parseDate("2026-11-15T14:00:00.123Z")).timeIntervalSince(base), 0.123, accuracy: 0.0001)
        XCTAssertEqual(OyobidashiJSON.parseDate("2026-11-15T14:00:00Z"), base)
        XCTAssertEqual(OyobidashiJSON.parseDate("2026-11-15T23:00:00.000+09:00"), base)
        XCTAssertNil(OyobidashiJSON.parseDate(""))
        XCTAssertNil(OyobidashiJSON.parseDate("2026-11-15"))
        XCTAssertNil(OyobidashiJSON.parseDate("1794751200"))
    }

    func testDateFormattingUsesUTCMilliseconds() {
        XCTAssertEqual(OyobidashiJSON.formatDate(Date(timeIntervalSince1970: 1_794_751_200)), "2026-11-15T14:00:00.000Z")
        XCTAssertEqual(OyobidashiJSON.formatDate(Date(timeIntervalSince1970: 1_794_751_200.25)), "2026-11-15T14:00:00.250Z")
    }

    func testRequestRoundTripsThroughEncoder() throws {
        for name in ["request_pending.json", "request_answered.json", "request_minimal_voice_answered.json", "request_notification.json"] {
            let original = Fixtures.request(name)
            let decoded = try OyobidashiJSON.makeDecoder().decode(AgentRequest.self, from: encodeJSON(original))
            XCTAssertEqual(decoded, original, name)
        }
    }
}
