import Foundation

/// relay との通信で起こりうるエラー。`RelayClient` は必ずこの型を throw する。
public enum RelayError: Error, Equatable, Sendable {
    case invalidRequest(message: String?)
    case unauthorized
    case pairingCodeInvalid
    case forbidden
    case notFound
    case alreadyResolved
    case payloadTooLarge
    case rateLimited
    /// 500 `internal` (および契約のエラー形式を持つその他の 5xx)。
    case server(message: String?)
    /// 契約のエラー形式でないレスポンス (HTML のエラーページ等)、または未知の code + 未知のステータス。
    case unexpectedResponse(status: Int, code: String?, message: String?)
    case network(code: Int, message: String)
    case timeout
    case cancelled
    case turnInProgress
    /// この端末で、音声会話の内容をAIへ送ることに同意していない。
    case voiceAIConsentRequired
    case turnFailed
    case turnCancelled
    case voiceHandoff
    /// The server may have accepted the utterance. Reuse its ID when recovering.
    case turnPending
    case idempotencyConflict
    /// 2xx だがボディを解釈できなかった。
    case decoding(String)

    /// 非 2xx レスポンスを型付きエラーに変換する。
    ///
    /// - 契約のエラー形式 (`{"error":{"code":…}}`) で既知の code → code に対応するエラー (HTTP ステータスより code を優先)。
    /// - 契約のエラー形式だが未知の code → HTTP ステータスから推定。
    /// - 契約のエラー形式でない (非JSON・別形式) → `.unexpectedResponse`。
    ///   同じIPの別サーバーやプロキシが返す 401/404 を「トークン失効」「request が無い」と誤認しないため。
    public static func from(status: Int, body: Data) -> RelayError {
        guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body) else {
            return .unexpectedResponse(status: status, code: nil, message: nil)
        }
        let message = envelope.error.message
        switch envelope.error.code {
        case "invalid_request": return .invalidRequest(message: message)
        case "unauthorized": return .unauthorized
        case "pairing_code_invalid": return .pairingCodeInvalid
        case "forbidden": return .forbidden
        case "not_found": return .notFound
        case "already_resolved": return .alreadyResolved
        case "payload_too_large": return .payloadTooLarge
        case "rate_limited": return .rateLimited
        case "internal": return .server(message: message)
        case "turn_in_progress": return .turnInProgress
        case "idempotency_conflict": return .idempotencyConflict
        case "call_ended": return .turnCancelled
        case "voice_handoff": return .voiceHandoff
        case "conversation_failed", "voice_unavailable", "turn_failed": return .turnFailed
        default: break
        }
        switch status {
        case 400: return .invalidRequest(message: message)
        case 401: return .unauthorized
        case 403: return .forbidden
        case 404: return .notFound
        case 409: return .alreadyResolved
        case 413: return .payloadTooLarge
        case 429: return .rateLimited
        case 500...599: return .server(message: message)
        default: return .unexpectedResponse(status: status, code: envelope.error.code, message: message)
        }
    }

    /// 任意のエラーを `RelayError` に正規化する。
    public static func wrap(_ error: Error) -> RelayError {
        if let relayError = error as? RelayError { return relayError }
        if error is CancellationError { return .cancelled }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut: return .timeout
            case .cancelled: return .cancelled
            default: return .network(code: urlError.code.rawValue, message: urlError.localizedDescription)
            }
        }
        let nsError = error as NSError
        return .network(code: nsError.code, message: nsError.localizedDescription)
    }

    /// 中継サーバーに到達できなかった (圏外・別のネットワーク・relay 停止)。
    /// LAN 専用なので外出先では普通に起こる状態であり、ペアリング解除や一般のエラーとは区別して扱う。
    public var isUnreachable: Bool {
        switch self {
        case .network, .timeout: return true
        default: return false
        }
    }

    public static let unreachableMessage = "中継サーバーに接続できません。ネットワーク接続を確認してください"

    /// 画面に出す日本語メッセージ。
    public var userMessage: String {
        switch self {
        case .invalidRequest(let message):
            return "リクエストが不正です" + (message.map { " (\($0))" } ?? "")
        case .unauthorized:
            return "認証に失敗しました。ペアリングし直してください"
        case .pairingCodeInvalid:
            return "ペアリングコードが正しくないか、期限切れ・使用済みです。コードを再発行してください"
        case .forbidden:
            return "この操作は許可されていません"
        case .notFound:
            return "見つかりませんでした"
        case .alreadyResolved:
            return "この質問はすでに回答済みか、取り消されています"
        case .payloadTooLarge:
            return "送信内容が大きすぎます"
        case .rateLimited:
            return "試行回数が多すぎます。しばらく待ってからやり直してください"
        case .server(let message):
            return "サーバーでエラーが発生しました" + (message.map { " (\($0))" } ?? "")
        case .unexpectedResponse(let status, _, _):
            return "サーバーから想定外の応答がありました (HTTP \(status))。MacのIPアドレスが変わっていないか確認してください"
        case .network, .timeout:
            return Self.unreachableMessage
        case .cancelled:
            return "キャンセルされました"
        case .voiceAIConsentRequired:
            return "AIへの送信に同意していないため、音声では応答できません。アプリを開いて確認するか、文字で返信してください"
        case .turnInProgress:
            return "前の発話を処理しています。しばらく待ってから確認してください"
        case .turnFailed:
            return "音声の応答を取得できませんでした。もう一度送信するか、文字で返信できます"
        case .turnCancelled:
            return "通話が終了しました。必要であれば文字で返信してください"
        case .voiceHandoff:
            return "残りの質問に回答してください"
        case .turnPending:
            return "発話の処理結果を確認できませんでした。入力内容は保存されています。通信が戻ったら再確認するか、文字で返信してください"
        case .idempotencyConflict:
            return "送信内容を確認できませんでした。文字で返信してください"
        case .decoding:
            return "サーバーの応答を解釈できませんでした"
        }
    }
}
