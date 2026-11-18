import CryptoKit
import XCTest
@testable import OyobidashiKit

final class BillingTests: XCTestCase {
    private let stub = StubTransport()
    private let attestor = FakeAttestor()
    private let keyStore = FakeKeyStore()

    private func makeClient() throws -> RelayClient {
        RelayClient(endpoint: try RelayEndpoint("https://api.oyobidashi.me"), deviceToken: "kd_token", transport: stub)
    }

    private func makeSync() throws -> BillingSync {
        BillingSync(client: try makeClient(), attestor: attestor, keyStore: keyStore)
    }

    private func stubEnabled(active: Bool = false) {
        let body = active
            ? #"{"enabled":true,"active":true,"expires_at":"2027-01-01T00:00:00.000Z","apple":{"product_ids":["me.oyobidashi.ios.voice.monthly"]}}"#
            : #"{"enabled":true,"active":false,"expires_at":null,"apple":{"product_ids":["me.oyobidashi.ios.voice.monthly"]}}"#
        stub.on("GET", "/v1/billing", status: 200, body: Data(body.utf8))
    }

    @discardableResult
    private func stubChallenges() -> Counter {
        let counter = Counter()
        stub.on("POST", "/v1/billing/challenge") { _ in
            let n = counter.next()
            return .init(200, Data(#"{"challenge":"ch-\#(n)","expires_at":"2026-11-15T14:05:00.000Z"}"#.utf8))
        }
        return counter
    }

    private func sentPayload(request: URLRequest?) throws -> String {
        let body = try XCTUnwrap(request?.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        return try XCTUnwrap(object["payload"] as? String)
    }

    // MARK: Happy path with an existing attested key

    func testSyncWithExistingKey() async throws {
        keyStore.saveKeyID("key-1", host: "api.oyobidashi.me")
        stubEnabled()
        stubChallenges()
        stub.on("POST", "/v1/billing/apple", status: 200, body: Data(#"{"enabled":true,"active":true,"purchase_account_id":"98765432-1234-5678-9abc-123456789abc","expires_at":"2027-01-01T00:00:00.000Z","apple":{"product_ids":["me.oyobidashi.ios.voice.monthly"]}}"#.utf8))

        let status = try await makeSync().sync(transactions: ["jws-1"])

        XCTAssertTrue(status.enabled)
        XCTAssertTrue(status.active)
        XCTAssertEqual(status.purchaseAccountID?.uuidString.lowercased(), "98765432-1234-5678-9abc-123456789abc")
        XCTAssertEqual(attestor.generateCount, 0)
        XCTAssertEqual(attestor.attestCalls.count, 0)
        XCTAssertEqual(attestor.assertHashes.count, 1)
        XCTAssertEqual(stub.requests("POST", "/v1/billing/apple/attest").count, 0)
        XCTAssertEqual(stub.requests.map { $0.url?.path }, ["/v1/billing", "/v1/billing/challenge", "/v1/billing/apple"])

        let payload = try sentPayload(request: stub.requests("POST", "/v1/billing/apple").first)
        XCTAssertEqual(Data(SHA256.hash(data: Data(payload.utf8))), attestor.assertHashes.first)
        let payloadObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        XCTAssertEqual(payloadObject["challenge"] as? String, "ch-1")
        XCTAssertEqual(payloadObject["transactions"] as? [String], ["jws-1"])
    }

    // MARK: First-run attestation

    func testFirstRunAttestation() async throws {
        stubEnabled()
        stubChallenges()
        stub.on("POST", "/v1/billing/apple/attest", status: 204)
        stub.on("POST", "/v1/billing/apple", status: 200, body: Data(#"{"enabled":true,"active":true,"expires_at":null,"apple":{"product_ids":["me.oyobidashi.ios.voice.monthly"]}}"#.utf8))

        let status = try await makeSync().sync(transactions: ["jws-1"])

        XCTAssertTrue(status.active)
        XCTAssertEqual(attestor.generateCount, 1)
        XCTAssertEqual(attestor.attestCalls.count, 1)
        XCTAssertEqual(attestor.attestCalls.first?.keyID, "key-new")
        XCTAssertEqual(attestor.attestCalls.first?.hash, Data(SHA256.hash(data: Data("ch-1".utf8))))
        XCTAssertEqual(keyStore.loadKeyID(host: "api.oyobidashi.me"), "key-new")
        XCTAssertEqual(
            stub.requests.map { $0.url?.path },
            ["/v1/billing", "/v1/billing/challenge", "/v1/billing/apple/attest", "/v1/billing/challenge", "/v1/billing/apple"]
        )
        let attestBody = try XCTUnwrap(stub.requests("POST", "/v1/billing/apple/attest").first?.httpBody)
        let attestObject = try XCTUnwrap(JSONSerialization.jsonObject(with: attestBody) as? [String: Any])
        XCTAssertEqual(attestObject["key_id"] as? String, "key-new")
        XCTAssertEqual(attestObject["challenge"] as? String, "ch-1")
        XCTAssertEqual(attestObject["attestation"] as? String, Data("attestation-bytes".utf8).base64EncodedString())
        let payload = try sentPayload(request: stub.requests("POST", "/v1/billing/apple").first)
        let payloadObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        XCTAssertEqual(payloadObject["challenge"] as? String, "ch-2")
    }

    // MARK: 409 re-attestation exactly once

    func testAttestationRequiredTriggersOneReAttestation() async throws {
        keyStore.saveKeyID("key-old", host: "api.oyobidashi.me")
        stubEnabled()
        stubChallenges()
        stub.on("POST", "/v1/billing/apple/attest", status: 204)
        let appleCalls = Counter()
        stub.on("POST", "/v1/billing/apple") { _ in
            if appleCalls.next() == 1 {
                return .init(409, Data(#"{"error":{"code":"attestation_required","message":"attest first"}}"#.utf8))
            }
            return .init(200, Data(#"{"enabled":true,"active":true,"expires_at":null,"apple":{"product_ids":["me.oyobidashi.ios.voice.monthly"]}}"#.utf8))
        }

        let status = try await makeSync().sync(transactions: ["jws-1"])

        XCTAssertTrue(status.active)
        XCTAssertEqual(appleCalls.value, 2)
        XCTAssertEqual(attestor.generateCount, 1)
        XCTAssertEqual(attestor.attestCalls.count, 1)
        XCTAssertEqual(attestor.assertHashes.count, 2)
        XCTAssertEqual(stub.requests("POST", "/v1/billing/apple/attest").count, 1)
        XCTAssertEqual(stub.requests("POST", "/v1/billing/challenge").count, 3)
        XCTAssertEqual(keyStore.clearCount, 1)
        XCTAssertEqual(keyStore.loadKeyID(host: "api.oyobidashi.me"), "key-new")
    }

    func testSecondAttestationRequiredDoesNotRetryAgain() async throws {
        keyStore.saveKeyID("key-old", host: "api.oyobidashi.me")
        stubEnabled()
        stubChallenges()
        stub.on("POST", "/v1/billing/apple/attest", status: 204)
        stub.on("POST", "/v1/billing/apple", status: 409, body: Data(#"{"error":{"code":"attestation_required","message":"attest first"}}"#.utf8))

        do {
            _ = try await makeSync().sync(transactions: ["jws-1"])
            XCTFail("expected attestationRequired")
        } catch let error as BillingError {
            XCTAssertEqual(error, .attestationRequired)
        }
        XCTAssertEqual(stub.requests("POST", "/v1/billing/apple").count, 2)
        XCTAssertEqual(attestor.attestCalls.count, 1)
    }

    // MARK: Disabled server

    func testOtherOriginsCannotStartOrSyncBilling() async throws {
        for url in [
            "https://relay.example",
            "https://oyobidashi.up.railway.app",
            "https://api.oyobidashi.me.example",
            "http://api.oyobidashi.me",
            "https://api.oyobidashi.me:8443",
            "https://api.oyobidashi.me/custom",
        ] {
            let client = RelayClient(endpoint: try RelayEndpoint(url), deviceToken: "kd_token", transport: stub)
            let status = try await BillingSync(client: client, attestor: attestor, keyStore: keyStore)
                .sync(transactions: ["fixture"])
            XCTAssertEqual(status, .disabled, url)
            do {
                _ = try await client.syncApple(keyID: "key", assertion: Data(), payload: "fixture")
                XCTFail("Unexpected billing sync for \(url)")
            } catch let error as RelayError {
                XCTAssertEqual(error, .forbidden)
            }
        }
        XCTAssertTrue(stub.requests.isEmpty)
        XCTAssertTrue(try RelayEndpoint("https://API.OYOBIDASHI.ME:443/").isOfficialCloud)
    }

    func testDisabledBillingMakesNoFurtherCalls() async throws {
        stub.on("GET", "/v1/billing", status: 200, body: Data(#"{"enabled":false}"#.utf8))

        let status = try await makeSync().sync(transactions: ["jws-1"])

        XCTAssertEqual(status, .disabled)
        XCTAssertEqual(stub.requests.count, 1)
        XCTAssertEqual(attestor.generateCount, 0)
        XCTAssertEqual(attestor.attestCalls.count, 0)
        XCTAssertEqual(attestor.assertHashes.count, 0)
    }

    func testBillingStatus404IsDisabled() async throws {
        stub.on("GET", "/v1/billing", status: 404, body: Data(#"{"error":{"code":"not_found","message":"nope"}}"#.utf8))

        let status = try await makeClient().billingStatus()
        XCTAssertEqual(status, .disabled)

        let synced = try await makeSync().sync(transactions: ["jws-1"])
        XCTAssertEqual(synced, .disabled)
        XCTAssertEqual(stub.requests.count, 2)
        XCTAssertTrue(stub.requests.allSatisfy { $0.url?.path == "/v1/billing" })
        XCTAssertEqual(attestor.generateCount, 0)
    }

    // MARK: Payload integrity and cap

    func testPayloadIsCappedAt20Transactions() async throws {
        keyStore.saveKeyID("key-1", host: "api.oyobidashi.me")
        stubEnabled()
        stubChallenges()
        stub.on("POST", "/v1/billing/apple", status: 200, body: Data(#"{"enabled":true,"active":false,"expires_at":null}"#.utf8))

        _ = try await makeSync().sync(transactions: (0..<25).map { "jws-\($0)" })

        let payload = try sentPayload(request: stub.requests("POST", "/v1/billing/apple").first)
        let payloadObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        XCTAssertEqual((payloadObject["transactions"] as? [String])?.count, 20)
        XCTAssertEqual(Data(SHA256.hash(data: Data(payload.utf8))), attestor.assertHashes.first)
        // Sorted keys: "challenge" is serialized before "transactions".
        let challengeRange = try XCTUnwrap(payload.range(of: "\"challenge\""))
        let transactionsRange = try XCTUnwrap(payload.range(of: "\"transactions\""))
        XCTAssertTrue(challengeRange.lowerBound < transactionsRange.lowerBound)
    }
}

// MARK: - Fakes

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    @discardableResult
    func next() -> Int { lock.withLock { count += 1; return count } }
}

final class FakeAttestor: AppAttesting, @unchecked Sendable {
    struct AttestCall {
        var keyID: String
        var hash: Data
    }

    private let lock = NSLock()
    private var generated = 0
    private var attests: [AttestCall] = []
    private var asserts: [Data] = []

    var isSupported: Bool { true }
    var generateCount: Int { lock.withLock { generated } }
    var attestCalls: [AttestCall] { lock.withLock { attests } }
    var assertHashes: [Data] { lock.withLock { asserts } }

    func generateKey() async throws -> String {
        lock.withLock { generated += 1 }
        return "key-new"
    }

    func attest(keyID: String, clientDataHash: Data) async throws -> Data {
        lock.withLock { attests.append(AttestCall(keyID: keyID, hash: clientDataHash)) }
        return Data("attestation-bytes".utf8)
    }

    func assert(keyID: String, clientDataHash: Data) async throws -> Data {
        lock.withLock { asserts.append(clientDataHash) }
        return Data("assertion-bytes".utf8)
    }
}

final class FakeKeyStore: AttestKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    private var clears = 0

    var clearCount: Int { lock.withLock { clears } }

    func loadKeyID(host: String) -> String? { lock.withLock { values[host] } }
    func saveKeyID(_ keyID: String, host: String) { lock.withLock { values[host] = keyID } }
    func clearKeyID(host: String) { lock.withLock { values[host] = nil; clears += 1 } }
}
