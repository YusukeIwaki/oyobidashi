import DeviceCheck
import Foundation
import OyobidashiKit

enum AppAttestorError: Error, LocalizedError {
    case unsupported
    case missingResult

    var errorDescription: String? {
        switch self {
        case .unsupported: return "この端末では端末の確認に対応していません"
        case .missingResult: return "端末の確認に失敗しました"
        }
    }
}

/// `DCAppAttestService` による `AppAttesting` の実装。
final class AppAttestor: AppAttesting, @unchecked Sendable {
    private let service = DCAppAttestService.shared

    var isSupported: Bool { service.isSupported }

    func generateKey() async throws -> String {
        guard service.isSupported else { throw AppAttestorError.unsupported }
        return try await withCheckedThrowingContinuation { continuation in
            service.generateKey { keyID, error in
                if let error { continuation.resume(throwing: error); return }
                guard let keyID else { continuation.resume(throwing: AppAttestorError.missingResult); return }
                continuation.resume(returning: keyID)
            }
        }
    }

    func attest(keyID: String, clientDataHash: Data) async throws -> Data {
        guard service.isSupported else { throw AppAttestorError.unsupported }
        return try await withCheckedThrowingContinuation { continuation in
            service.attestKey(keyID, clientDataHash: clientDataHash) { attestation, error in
                if let error { continuation.resume(throwing: error); return }
                guard let attestation else { continuation.resume(throwing: AppAttestorError.missingResult); return }
                continuation.resume(returning: attestation)
            }
        }
    }

    func assert(keyID: String, clientDataHash: Data) async throws -> Data {
        guard service.isSupported else { throw AppAttestorError.unsupported }
        return try await withCheckedThrowingContinuation { continuation in
            service.generateAssertion(keyID, clientDataHash: clientDataHash) { assertion, error in
                if let error { continuation.resume(throwing: error); return }
                guard let assertion else { continuation.resume(throwing: AppAttestorError.missingResult); return }
                continuation.resume(returning: assertion)
            }
        }
    }
}

/// 鍵 ID (秘密ではない) を relay ホストごとに UserDefaults へ保存する。
struct UserDefaultsAttestKeyStore: AttestKeyStoring {
    private func key(host: String) -> String { "attest-key-id.\(host)" }

    func loadKeyID(host: String) -> String? {
        UserDefaults.standard.string(forKey: key(host: host))
    }

    func saveKeyID(_ keyID: String, host: String) {
        UserDefaults.standard.set(keyID, forKey: key(host: host))
    }

    func clearKeyID(host: String) {
        UserDefaults.standard.removeObject(forKey: key(host: host))
    }
}
