import Foundation

public struct RequestItem: Codable, Equatable, Identifiable, Sendable {
    public struct Condition: Codable, Equatable, Sendable {
        public let itemID: String
        public let choiceIndex: Int

        enum CodingKeys: String, CodingKey {
            case itemID = "item_id"
            case choiceIndex = "choice_index"
        }
    }

    public let id: String
    public let question: String
    public let context: String?
    public let choices: [String]?
    public let appliesWhen: Condition?

    enum CodingKeys: String, CodingKey {
        case id, question, context, choices
        case appliesWhen = "applies_when"
    }
}

public struct ItemAnswer: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case answered, deferred
        case notApplicable = "not_applicable"
    }

    public let itemID: String
    public let status: Status
    public let text: String?
    public let choiceIndex: Int?
    public let inputMethod: InputMethod?

    enum CodingKeys: String, CodingKey {
        case itemID = "item_id"
        case status, text
        case choiceIndex = "choice_index"
        case inputMethod = "input_method"
    }
}

public struct ItemReply: Codable, Equatable, Sendable {
    public static let maxTextLength = 1_000
    public let itemID: String
    public var text: String?
    public var choiceIndex: Int?

    public init(itemID: String, text: String? = nil, choiceIndex: Int? = nil) {
        self.itemID = itemID
        self.text = text
        self.choiceIndex = choiceIndex
    }

    enum CodingKeys: String, CodingKey {
        case itemID = "item_id"
        case text
        case choiceIndex = "choice_index"
    }
}

public struct ItemAnswerForm {
    public struct Row: Identifiable {
        public let item: RequestItem
        public let answer: ItemAnswer?
        public var id: String { item.id }
    }

    public let rows: [Row]
    public let submission: AnswerBody?

    public init(request: AgentRequest, drafts: [String: ItemReply]) {
        let saved = Dictionary((request.itemAnswers ?? []).map { ($0.itemID, $0) }, uniquingKeysWith: { first, _ in first })
        var selected: [String: Int] = [:]
        var rows: [Row] = []
        var replies: [ItemReply] = []
        var ready = true

        for item in request.items ?? [] {
            let answer = saved[item.id]
            if let condition = item.appliesWhen,
               selected[condition.itemID] != condition.choiceIndex,
               answer?.status != .notApplicable { continue }
            rows.append(Row(item: item, answer: answer))
            if answer?.status == .notApplicable { continue }
            if answer?.status == .answered {
                selected[item.id] = answer?.choiceIndex
                continue
            }
            let draft = drafts[item.id]
            if let choices = item.choices, !choices.isEmpty {
                guard let index = draft?.choiceIndex, choices.indices.contains(index) else {
                    ready = false
                    continue
                }
                selected[item.id] = index
                replies.append(ItemReply(itemID: item.id, choiceIndex: index))
            } else {
                let text = draft?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if text.isEmpty || text.utf16.count > ItemReply.maxTextLength { ready = false }
                else { replies.append(ItemReply(itemID: item.id, text: text)) }
            }
        }
        self.rows = rows
        self.submission = ready && !replies.isEmpty && request.isAnswerable
            ? AnswerBody(text: "", inputMethod: .text, itemAnswers: replies) : nil
    }
}
