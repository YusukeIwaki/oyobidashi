import Foundation
import Observation

/// 回答画面の状態 (下書き・入力手段の判定・送信状態)。
@MainActor
@Observable
public final class AnswerViewModel {
    public enum Phase: Equatable, Sendable {
        case editing
        case submitting
        /// 送信失敗。下書きは保持しているので再送できる。
        case failed(RelayError)
        /// 中継サーバーに届かなかった (圏外)。下書きは保持しているので、LAN に戻ってから再送できる。
        case unreachable
        /// 409 / 404: 他の端末で回答済み・取消・期限切れ。
        case resolvedElsewhere
        case answered
        /// 401: ペアリングが無効になった。
        case signedOut
    }

    public let requestID: String
    public private(set) var draft: String = ""
    /// 下書きが音声入力に由来するか。音声入力後に手で修正しても true のまま。下書きを空にすると false に戻る。
    public private(set) var draftUsedVoice = false
    public private(set) var phase: Phase = .editing

    @ObservationIgnored private let submitter: any AnswerSubmitting
    @ObservationIgnored private let drafts: DraftStore?

    /// `drafts` に保存済みの下書き (通知から送れなかった返信など) があれば、それを初期値にする。
    public init(requestID: String, submitter: any AnswerSubmitting, drafts: DraftStore? = nil) {
        self.requestID = requestID
        self.submitter = submitter
        self.drafts = drafts
        if let saved = drafts?.draft(for: requestID) {
            draft = saved.text
            draftUsedVoice = saved.usedVoice
        }
    }

    private func persistDraft() {
        drafts?.set(AnswerDraft(text: draft, usedVoice: draftUsedVoice), for: requestID)
    }

    private func backToEditingIfFailed() {
        switch phase {
        case .failed, .unreachable: phase = .editing
        default: break
        }
    }

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var isDraftTooLong: Bool { trimmedDraft.count > AnswerBody.maxTextLength }

    public var isFinished: Bool {
        switch phase {
        case .answered, .resolvedElsewhere, .signedOut: return true
        case .editing, .submitting, .failed, .unreachable: return false
        }
    }

    public var canSubmitText: Bool {
        !isFinished && phase != .submitting && !trimmedDraft.isEmpty && !isDraftTooLong
    }

    public var canSubmitChoice: Bool { !isFinished && phase != .submitting }

    /// テキスト欄をユーザーが編集した。
    public func userEdited(_ text: String) {
        draft = text
        if trimmedDraft.isEmpty { draftUsedVoice = false }
        persistDraft()
        backToEditingIfFailed()
    }

    /// 音声認識の結果で下書きを置き換えた。
    public func applyDictation(_ text: String) {
        draft = text
        if !trimmedDraft.isEmpty { draftUsedVoice = true }
        persistDraft()
        backToEditingIfFailed()
    }

    /// 送信時の `input_method` (テキスト欄から送る場合)。
    public var textInputMethod: InputMethod { draftUsedVoice ? .voice : .text }

    /// テキスト欄の内容を送信する。
    public func submitText() async {
        guard canSubmitText else { return }
        await submit(AnswerBody(text: trimmedDraft, choiceIndex: nil, inputMethod: textInputMethod), clearsDraft: true)
    }

    /// 選択肢で回答する (`text` = 選択肢の文字列, `input_method` = `choice`)。
    public func submitChoice(index: Int, choices: [String]) async {
        guard canSubmitChoice, choices.indices.contains(index) else { return }
        await submit(AnswerBody(text: choices[index], choiceIndex: index, inputMethod: .choice), clearsDraft: false)
    }

    private func submit(_ body: AnswerBody, clearsDraft: Bool) async {
        phase = .submitting
        switch await submitter.submitAnswer(requestID: requestID, body: body) {
        case .answered:
            if clearsDraft {
                draft = ""
                draftUsedVoice = false
            }
            drafts?.remove(requestID)
            phase = .answered
        case .alreadyResolved, .notFound:
            drafts?.remove(requestID)
            phase = .resolvedElsewhere
        case .unreachable:
            phase = .unreachable
        case .unauthorized:
            phase = .signedOut
        case .failed(let error):
            phase = .failed(error)
        }
    }
}
