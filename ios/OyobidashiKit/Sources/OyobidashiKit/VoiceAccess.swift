import Foundation

public struct VoiceStatus: Decodable, Sendable {
    public let enabled: Bool
    public let supported: Bool
    public let platform: String
    public let uid: String
    public let deviceID: String

    enum CodingKeys: String, CodingKey {
        case enabled, supported, platform, uid
        case deviceID = "device_id"
    }
}

public struct VoiceChallenge: Decodable, Sendable {
    public let challenge: String
}

public struct VoiceAccess: Decodable, Sendable {
    public let accessToken: String
    public let expiresAt: Date

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token", expiresAt = "expires_at"
    }
}

struct VoiceChallengeRequest: Encodable { let purpose: String }

struct VoiceAppleAttestRequest: Encodable {
    let challenge: String
    let keyID: String
    let attestation: String
    enum CodingKeys: String, CodingKey {
        case challenge, attestation
        case keyID = "key_id"
    }
}

struct VoiceTokenRequest: Encodable {
    let challenge: String
    let keyID: String
    let signature: String
    enum CodingKeys: String, CodingKey {
        case challenge, signature
        case keyID = "key_id"
    }
}

public enum VoiceProofMessage {
    public static func enrollment(uid: String, deviceID: String, challenge: String) -> String {
        "voice-enroll\n\(uid)\n\(deviceID)\n\(challenge)"
    }

    public static func token(uid: String, deviceID: String, challenge: String) -> String {
        "voice-token\n\(uid)\n\(deviceID)\n\(challenge)"
    }
}
