import CryptoKit
import Foundation

// MARK: - Billing models

/// `GET /v1/billing` のボディ。billing 未設定のデプロイでは `{"enabled":false}` のみが返る。
public struct BillingStatus: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var active: Bool
    public var expiresAt: Date?
    public var activeStores: Set<String>?
    public var purchaseAccountID: UUID?
    public var apple: BillingStoreProducts?
    public var google: BillingStoreProducts?
    public var voiceTraining: BillingVoiceTraining?
    public var voiceProvider: String?

    enum CodingKeys: String, CodingKey {
        case enabled, active, apple, google
        case expiresAt = "expires_at"
        case activeStores = "active_stores"
        case purchaseAccountID = "purchase_account_id"
        case voiceTraining = "voice_training"
        case voiceProvider = "voice_provider"
    }

    public init(enabled: Bool, active: Bool = false, expiresAt: Date? = nil, apple: BillingStoreProducts? = nil, google: BillingStoreProducts? = nil, activeStores: Set<String>? = nil, purchaseAccountID: UUID? = nil, voiceTraining: BillingVoiceTraining? = nil, voiceProvider: String? = nil) {
        self.enabled = enabled
        self.active = active
        self.expiresAt = expiresAt
        self.activeStores = activeStores
        self.purchaseAccountID = purchaseAccountID
        self.apple = apple
        self.google = google
        self.voiceTraining = voiceTraining
        self.voiceProvider = voiceProvider
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
        activeStores = try c.decodeIfPresent(Set<String>.self, forKey: .activeStores)
        purchaseAccountID = try c.decodeIfPresent(UUID.self, forKey: .purchaseAccountID)
        apple = try c.decodeIfPresent(BillingStoreProducts.self, forKey: .apple)
        google = try c.decodeIfPresent(BillingStoreProducts.self, forKey: .google)
        voiceTraining = try c.decodeIfPresent(BillingVoiceTraining.self, forKey: .voiceTraining)
        voiceProvider = try c.decodeIfPresent(String.self, forKey: .voiceProvider)
    }

    public static let disabled = BillingStatus(enabled: false)
}

public struct BillingVoiceTraining: Codable, Equatable, Sendable {
    public var free: Bool?
    public var plus: Bool?

    public init(free: Bool?, plus: Bool?) {
        self.free = free
        self.plus = plus
    }
}

public struct BillingStoreProducts: Codable, Equatable, Sendable {
    public var productIDs: [String]

    enum CodingKeys: String, CodingKey {
        case productIDs = "product_ids"
    }

    public init(productIDs: [String] = []) {
        self.productIDs = productIDs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        productIDs = try c.decodeIfPresent([String].self, forKey: .productIDs) ?? []
    }
}

/// `POST /v1/billing/challenge` のボディ。
public struct BillingChallenge: Codable, Equatable, Sendable {
    public var challenge: String
    public var expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case challenge
        case expiresAt = "expires_at"
    }

    public init(challenge: String, expiresAt: Date? = nil) {
        self.challenge = challenge
        self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        challenge = try c.decode(String.self, forKey: .challenge)
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
    }
}

public enum BillingError: Error, Equatable, Sendable {
    /// 409 `attestation_required`: 先に (再) アテステーションが必要。
    case attestationRequired
}

// MARK: - Attestation abstractions

/// App Attest の抽象。Kit は DeviceCheck に依存せず、実装はアプリ側が差し込む。
public protocol AppAttesting: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attest(keyID: String, clientDataHash: Data) async throws -> Data
    func assert(keyID: String, clientDataHash: Data) async throws -> Data
}

/// アテステーション鍵 ID の保存先。鍵 ID 自体は秘密ではない。
public protocol AttestKeyStoring: Sendable {
    func loadKeyID(host: String) -> String?
    func saveKeyID(_ keyID: String, host: String)
    func clearKeyID(host: String)
}

// MARK: - Billing sync

/// 契約どおりの同期フロー: チャレンジ取得、アテステーション (初回/再)、
/// payload 文字列を一度だけ組み立てて署名と送信で共用する。
public actor BillingSync {
    private let client: RelayClient
    private let attestor: any AppAttesting
    private let keyStore: any AttestKeyStoring

    public init(client: RelayClient, attestor: any AppAttesting, keyStore: any AttestKeyStoring) {
        self.client = client
        self.attestor = attestor
        self.keyStore = keyStore
    }

    private var host: String { client.endpoint.host }

    public func sync(transactions: [String]) async throws -> BillingStatus {
        let status = try await client.billingStatus()
        guard status.enabled else { return status }
        let capped = Array(transactions.prefix(20))
        do {
            return try await performSync(transactions: capped)
        } catch BillingError.attestationRequired {
            keyStore.clearKeyID(host: host)
            _ = try await attestNewKey()
            return try await performSync(transactions: capped)
        }
    }

    private func performSync(transactions: [String]) async throws -> BillingStatus {
        var keyID = keyStore.loadKeyID(host: host)
        if keyID == nil {
            keyID = try await attestNewKey()
        }
        guard let keyID else { throw BillingError.attestationRequired }
        let challenge = try await client.billingChallenge()
        let payload = try Self.makePayload(challenge: challenge.challenge, transactions: transactions)
        let assertion: Data
        do {
            assertion = try await attestor.assert(keyID: keyID, clientDataHash: Self.sha256(Data(payload.utf8)))
        } catch {
            // 再インストールや復元で鍵が失われた端末は、保存した鍵 ID では署名できない。作り直す。
            throw BillingError.attestationRequired
        }
        return try await client.syncApple(keyID: keyID, assertion: assertion, payload: payload)
    }

    @discardableResult
    private func attestNewKey() async throws -> String {
        let keyID = try await attestor.generateKey()
        let challenge = try await client.billingChallenge()
        let attestation = try await attestor.attest(keyID: keyID, clientDataHash: Self.sha256(Data(challenge.challenge.utf8)))
        try await client.attestApple(keyID: keyID, attestation: attestation, challenge: challenge.challenge)
        keyStore.saveKeyID(keyID, host: host)
        return keyID
    }

    private struct SyncPayload: Encodable {
        var challenge: String
        var transactions: [String]
    }

    static func makePayload(challenge: String, transactions: [String]) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(SyncPayload(challenge: challenge, transactions: transactions))
        return String(decoding: data, as: UTF8.self)
    }

    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }
}
