import Foundation
import Security

/// ペアリングで得た接続情報。
public struct Credentials: Codable, Equatable, Sendable {
    public var endpoint: RelayEndpoint
    public var deviceToken: String
    public var deviceID: String?

    enum CodingKeys: String, CodingKey {
        case endpoint = "url"
        case deviceToken = "device_token"
        case deviceID = "device_id"
    }

    public init(endpoint: RelayEndpoint, deviceToken: String, deviceID: String? = nil) {
        self.endpoint = endpoint
        self.deviceToken = deviceToken
        self.deviceID = deviceID
    }
}

public protocol CredentialStore: Sendable {
    func load() throws -> Credentials?
    func save(_ credentials: Credentials) throws
    func clear() throws
}

/// テスト・プレビュー用。
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Credentials?
    public var failure: Error?

    public init(_ credentials: Credentials? = nil) {
        stored = credentials
    }

    public var current: Credentials? { lock.withLock { stored } }

    public func load() throws -> Credentials? {
        try lock.withLock {
            if let failure { throw failure }
            return stored
        }
    }

    public func save(_ credentials: Credentials) throws {
        try lock.withLock {
            if let failure { throw failure }
            stored = credentials
        }
    }

    public func clear() throws {
        try lock.withLock {
            if let failure { throw failure }
            stored = nil
        }
    }
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}

/// Keychain (generic password) に JSON として保存する。
/// 通知からのバックグラウンド返信でも読めるよう `AfterFirstUnlockThisDeviceOnly`。
public struct KeychainCredentialStore: CredentialStore {
    private let service: String
    private let account: String

    public init(service: String = "io.github.yusukeiwaki.oyobidashi", account: String = "relay-credentials") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() throws -> Credentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { return nil }
        // 壊れたデータは「未ペアリング」として扱う。
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        SecItemDelete(baseQuery as CFDictionary)
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
