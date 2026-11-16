import XCTest
@testable import OyobidashiKit

final class PairingTests: XCTestCase {
    private func assertParseError(_ uri: String, _ expected: PairingParseError, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try PairingInfo.parse(uri: uri), uri, file: file, line: line) {
            XCTAssertEqual($0 as? PairingParseError, expected, uri, file: file, line: line)
        }
    }

    func testFixture() throws {
        let info = try PairingInfo.parse(uri: Fixtures.string("pairing_uri.txt"))
        XCTAssertEqual(info.endpoint.baseURL.absoluteString, "http://192.168.1.10:8787")
        XCTAssertEqual(info.endpoint.host, "192.168.1.10")
        XCTAssertEqual(info.endpoint.baseURL.port, 8787)
        XCTAssertEqual(info.endpoint.eventsURL.absoluteString, "ws://192.168.1.10:8787/v1/events")
        XCTAssertEqual(info.code, "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21")
    }

    func testPlainHTTPWithIPLiteralsLocalNamesAndPorts() throws {
        let cases: [(String, String)] = [
            ("http%3A%2F%2F10.0.0.5%3A8787", "http://10.0.0.5:8787"),
            ("http%3A%2F%2F172.16.3.4%3A9000%2F", "http://172.16.3.4:9000"),
            ("http%3A%2F%2F192.168.1.10", "http://192.168.1.10"),
            ("http%3A%2F%2F%5Bfe80%3A%3A1%5D%3A8787", "http://[fe80::1]:8787"),
            ("http%3A%2F%2Fmy-mac.local%3A8787", "http://my-mac.local:8787"),
            ("https%3A%2F%2Frelay.example", "https://relay.example"),
        ]
        for (encoded, expected) in cases {
            let info = try PairingInfo.parse(uri: "oyobidashi://pair?url=\(encoded)&code=abc")
            XCTAssertEqual(info.endpoint.baseURL.absoluteString, expected, encoded)
        }
    }

    func testFixtureAsURL() throws {
        let url = try XCTUnwrap(URL(string: Fixtures.string("pairing_uri.txt").trimmingCharacters(in: .whitespacesAndNewlines)))
        XCTAssertEqual(try PairingInfo.parse(url: url), try PairingInfo.parse(uri: Fixtures.string("pairing_uri.txt")))
    }

    func testPercentEncodedURLWithPortPathAndTrailingSlash() throws {
        let info = try PairingInfo.parse(uri: "oyobidashi://pair?url=http%3A%2F%2F192.168.1.20%3A8787%2Fbase%2F&code=abc%20123")
        XCTAssertEqual(info.endpoint.baseURL.absoluteString, "http://192.168.1.20:8787/base")
        XCTAssertEqual(info.code, "abc 123")
    }

    func testUnencodedURLParameterIsAccepted() throws {
        let info = try PairingInfo.parse(uri: "oyobidashi://pair?url=https://relay.example&code=c1")
        XCTAssertEqual(info.endpoint.baseURL.absoluteString, "https://relay.example")
    }

    func testParameterOrderExtraParamsDuplicatesAndCase() throws {
        let info = try PairingInfo.parse(uri: "OYOBIDASHI://PAIR/?v=2&code=first&url=https%3A%2F%2Fa.example&code=second&utm=x")
        XCTAssertEqual(info.endpoint.host, "a.example")
        XCTAssertEqual(info.code, "first")
    }

    func testMissingOrEmptyParams() {
        assertParseError("oyobidashi://pair", .missingURL)
        assertParseError("oyobidashi://pair?", .missingURL)
        assertParseError("oyobidashi://pair?code=abc", .missingURL)
        assertParseError("oyobidashi://pair?url=&code=abc", .missingURL)
        assertParseError("oyobidashi://pair?url&code=abc", .missingURL)
        assertParseError("oyobidashi://pair?url=%20&code=abc", .missingURL)
        assertParseError("oyobidashi://pair?url=https%3A%2F%2Fa.example", .missingCode)
        assertParseError("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=", .missingCode)
        assertParseError("oyobidashi://pair?url=https%3A%2F%2Fa.example&code=%20%20", .missingCode)
        assertParseError("oyobidashi://pair?URL=https%3A%2F%2Fa.example&CODE=abc", .missingURL)
    }

    func testWrongSchemeOrHost() {
        assertParseError("https://pair?url=https%3A%2F%2Fa.example&code=abc", .wrongScheme)
        assertParseError("https://example.com/pair?url=https%3A%2F%2Fa.example&code=abc", .wrongScheme)
        assertParseError("oyobidashi2://pair?url=https%3A%2F%2Fa.example&code=abc", .wrongScheme)
        assertParseError("oyobidashi://unpair?url=https%3A%2F%2Fa.example&code=abc", .wrongHost)
        assertParseError("oyobidashi://pair/extra?url=https%3A%2F%2Fa.example&code=abc", .wrongHost)
        assertParseError("oyobidashi:pair?url=https%3A%2F%2Fa.example&code=abc", .wrongHost)
        assertParseError("oyobidashi:///pair?url=https%3A%2F%2Fa.example&code=abc", .wrongHost)
    }

    func testMalformedInput() {
        assertParseError("", .malformed)
        assertParseError("   \n", .malformed)
        assertParseError("hello world", .malformed)
        assertParseError("3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21", .malformed)
    }

    func testNonHTTPRelayURL() {
        assertParseError("oyobidashi://pair?url=ftp%3A%2F%2Fa.example&code=abc", .invalidRelayURL)
        assertParseError("oyobidashi://pair?url=javascript%3Aalert(1)&code=abc", .invalidRelayURL)
        assertParseError("oyobidashi://pair?url=a.example&code=abc", .invalidRelayURL)
        assertParseError("oyobidashi://pair?url=https%3A%2F%2F&code=abc", .invalidRelayURL)
        assertParseError("oyobidashi://pair?url=oyobidashi%3A%2F%2Fpair&code=abc", .invalidRelayURL)
    }

    func testSurroundingWhitespaceIsTrimmed() throws {
        let info = try PairingInfo.parse(uri: "\n  " + Fixtures.string("pairing_uri.txt") + "  \n")
        XCTAssertEqual(info.code, "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21")
    }

    // MARK: Manual input

    func testManualInput() throws {
        let info = try PairingInfo.manual(url: "  http://192.168.1.10:8787/ ", code: " 3f9a 1c0e\n")
        XCTAssertEqual(info.endpoint.baseURL.absoluteString, "http://192.168.1.10:8787")
        XCTAssertEqual(info.code, "3f9a1c0e")
    }

    func testManualInputAddsHTTPWhenSchemeIsOmitted() throws {
        XCTAssertEqual(try PairingInfo.manual(url: "192.168.1.10:8787", code: "c").endpoint.baseURL.absoluteString, "http://192.168.1.10:8787")
        XCTAssertEqual(try PairingInfo.manual(url: "my-mac.local:8787", code: "c").endpoint.baseURL.absoluteString, "http://my-mac.local:8787")
        XCTAssertEqual(try PairingInfo.manual(url: "https://relay.example", code: "c").endpoint.baseURL.absoluteString, "https://relay.example")
    }

    func testManualInputAcceptsPastedPairingURI() throws {
        let info = try PairingInfo.manual(url: Fixtures.string("pairing_uri.txt"), code: "")
        XCTAssertEqual(info, try PairingInfo.parse(uri: Fixtures.string("pairing_uri.txt")))
    }

    func testManualInputErrors() {
        XCTAssertThrowsError(try PairingInfo.manual(url: "", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .missingURL) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "  ", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .missingURL) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "https://a.example", code: "")) { XCTAssertEqual($0 as? PairingParseError, .missingCode) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "https://a.example", code: " \n ")) { XCTAssertEqual($0 as? PairingParseError, .missingCode) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "ftp://a.example", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .invalidRelayURL) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "https://", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .invalidRelayURL) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "a b c", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .invalidRelayURL) }
        XCTAssertThrowsError(try PairingInfo.manual(url: "oyobidashi://pair?code=abc", code: "abc")) { XCTAssertEqual($0 as? PairingParseError, .missingURL) }
    }

    // MARK: Credentials

    func testCredentialsCodableRoundTrip() throws {
        let credentials = Credentials(endpoint: try RelayEndpoint("https://a.example/base/"), deviceToken: "kd_x", deviceID: "dev_1")
        let data = try JSONEncoder().encode(credentials)
        assertJSONEqual(data, Data(#"{"url":"https://a.example/base","device_token":"kd_x","device_id":"dev_1"}"#.utf8))
        XCTAssertEqual(try JSONDecoder().decode(Credentials.self, from: data), credentials)
        XCTAssertThrowsError(try JSONDecoder().decode(Credentials.self, from: Data(#"{"url":"ftp://x","device_token":"t"}"#.utf8)))
    }

    func testInMemoryCredentialStore() throws {
        let store = InMemoryCredentialStore()
        XCTAssertNil(try store.load())
        let credentials = Credentials(endpoint: try RelayEndpoint("https://a.example"), deviceToken: "kd_x")
        try store.save(credentials)
        XCTAssertEqual(try store.load(), credentials)
        try store.clear()
        XCTAssertNil(try store.load())
    }
}
