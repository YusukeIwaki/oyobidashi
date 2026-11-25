import XCTest
@testable import OyobidashiKit

final class RequestItemsTests: XCTestCase {
    func testHandoffDisplaysVoiceAnswerAndSendsOnlyRemainingItems() throws {
        let request = try Fixtures.decode(AgentRequest.self, "request_item_progress.json")
        let empty = ItemAnswerForm(request: request, drafts: [:])
        XCTAssertEqual(empty.rows.map(\.id), ["route", "notice", "label"])
        XCTAssertEqual(empty.rows.first?.answer?.inputMethod, .voice)
        XCTAssertEqual(empty.rows[1].answer?.status, .deferred)
        XCTAssertNil(empty.submission)

        let form = ItemAnswerForm(request: request, drafts: [
            "route": ItemReply(itemID: "route", choiceIndex: 0),
            "notice": ItemReply(itemID: "notice", choiceIndex: 1),
            "channel": ItemReply(itemID: "channel", text: "以前の下書き"),
            "label": ItemReply(itemID: "label", text: " 第2版\n"),
        ])
        XCTAssertEqual(form.rows.map(\.id), ["route", "notice", "label"])
        let body = try XCTUnwrap(form.submission)
        XCTAssertEqual(body.itemAnswers, [
            ItemReply(itemID: "notice", choiceIndex: 1),
            ItemReply(itemID: "label", text: "第2版"),
        ])
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(wire["item_answers"] as? [[String: AnyHashable]], [
            ["item_id": "notice", "choice_index": 1],
            ["item_id": "label", "text": "第2版"],
        ])
    }

    func testNewlyApplicableItemIsRequiredAndClosedRequestCannotSend() throws {
        var request = try Fixtures.decode(AgentRequest.self, "request_item_progress.json")
        var drafts = [
            "notice": ItemReply(itemID: "notice", choiceIndex: 0),
            "label": ItemReply(itemID: "label", text: "新版"),
        ]
        let missing = ItemAnswerForm(request: request, drafts: drafts)
        XCTAssertEqual(missing.rows.map(\.id), ["route", "notice", "channel", "label"])
        XCTAssertNil(missing.submission)

        drafts["channel"] = ItemReply(itemID: "channel", text: String(repeating: "😀", count: 501))
        XCTAssertNil(ItemAnswerForm(request: request, drafts: drafts).submission)
        drafts["channel"] = ItemReply(itemID: "channel", text: "開発")
        XCTAssertNotNil(ItemAnswerForm(request: request, drafts: drafts).submission)
        request.status = .cancelled
        XCTAssertNil(ItemAnswerForm(request: request, drafts: drafts).submission)
    }
}
