import CryptoKit
import Foundation
import OyobidashiKit

/// App Attest の秘密鍵は OS が保持し、ここには key ID だけを保存する。
actor VoiceAccessManager {
    private let attestor = AppAttestor()
    private var cached: (scope: String, token: String, expires: Date)?

    func token(for credentials: Credentials) async throws -> String? {
        let client = RelayClient(endpoint: credentials.endpoint, deviceToken: credentials.deviceToken)
        guard let status = try await client.voiceStatus() else { return nil } // LAN relay
        guard status.enabled && status.supported && status.platform == "ios" else { throw RelayError.forbidden }
        let scope = credentials.endpoint.description + ":" + status.uid + ":" + status.deviceID
        if let cached, cached.scope == scope, cached.expires > Date().addingTimeInterval(30) {
            return cached.token
        }
        let storageKey = "voice-attest-key-id." + scope
        var keyID = UserDefaults.standard.string(forKey: storageKey)
        if keyID == nil {
            keyID = try await enroll(client: client, status: status, storageKey: storageKey)
        }
        do {
            let access = try await issue(client: client, status: status, keyID: keyID!)
            cached = (scope, access.accessToken, access.expiresAt)
            return access.accessToken
        } catch let error as RelayError {
            guard error == .alreadyResolved || error == .forbidden else { throw error }
            keyID = try await enroll(client: client, status: status, storageKey: storageKey)
            let access = try await issue(client: client, status: status, keyID: keyID!)
            cached = (scope, access.accessToken, access.expiresAt)
            return access.accessToken
        }
    }

    private func enroll(client: RelayClient, status: VoiceStatus, storageKey: String) async throws -> String {
        let keyID = try await attestor.generateKey()
        let challenge = try await client.voiceChallenge("apple_enroll").challenge
        let message = VoiceProofMessage.enrollment(uid: status.uid, deviceID: status.deviceID, challenge: challenge)
        let proof = try await attestor.attest(keyID: keyID, clientDataHash: digest(message))
        try await client.voiceAppleAttest(challenge: challenge, keyID: keyID, attestation: proof)
        UserDefaults.standard.set(keyID, forKey: storageKey)
        return keyID
    }

    private func issue(client: RelayClient, status: VoiceStatus, keyID: String) async throws -> VoiceAccess {
        let challenge = try await client.voiceChallenge("token").challenge
        let message = VoiceProofMessage.token(uid: status.uid, deviceID: status.deviceID, challenge: challenge)
        let proof = try await attestor.assert(keyID: keyID, clientDataHash: digest(message))
        return try await client.voiceToken(challenge: challenge, keyID: keyID, signature: proof)
    }

    private func digest(_ message: String) -> Data {
        Data(SHA256.hash(data: Data(message.utf8)))
    }
}
