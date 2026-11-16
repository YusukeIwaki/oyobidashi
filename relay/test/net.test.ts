import { describe, expect, test } from "bun:test";
import { classifyAddress, isLanIPv4, isLoopbackAddress, isPrivateAddress } from "../src/net.ts";

describe("address classifier", () => {
  const loopback = ["127.0.0.1", "127.0.0.0", "127.255.255.255", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:127.0.0.1", "0:0:0:0:0:ffff:127.0.0.1"];
  const privateOnly = [
    "10.0.0.0", "10.0.0.1", "10.255.255.255",
    "172.16.0.0", "172.16.0.1", "172.20.10.2", "172.31.255.255",
    "192.168.0.0", "192.168.1.5", "192.168.255.255",
    "169.254.0.0", "169.254.10.20", "169.254.255.255",
    "fc00::", "fc00::1", "fd12:3456:789a::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::", "fe80::1", "fe80::1%en0", "febf:ffff::1", "FE80::ABCD",
    "::ffff:192.168.1.5", "::ffff:10.0.0.1", "::ffff:172.16.0.1", "::ffff:169.254.1.1", "::ffff:c0a8:0105", "::ffff:a00:1",
  ];
  const publicAddrs = [
    "0.0.0.0", "1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "11.1.2.3",
    "126.255.255.255", "128.0.0.1",
    "172.15.255.255", "172.15.0.1", "172.32.0.0", "172.32.0.1", "171.16.0.1", "173.16.0.1",
    "192.167.255.255", "192.169.0.0", "192.169.1.1", "191.168.1.1", "193.168.1.1",
    "169.253.255.255", "169.255.0.0", "168.254.1.1",
    "100.64.0.1", // CGNAT / Tailscale
    "203.0.113.7", "255.255.255.255",
    "::", "::2", "2001:db8::1", "2606:4700:4700::1111", "fbff::1", "fe00::1", "fe7f::1", "fec0::1", "ff02::1",
    "::ffff:8.8.8.8", "::ffff:172.32.0.1", "::ffff:11.0.0.1", "::ffff:192.169.0.1", "::ffff:808:808",
    "::127.0.0.1", "::192.168.1.5", // deprecated IPv4-compatible form is not the mapped form
    "64:ff9b::192.168.1.5", "1::ffff:192.168.1.5",
  ];
  const malformed: unknown[] = [
    "", " ", "localhost", "example.com", "192.168.1", "192.168.1.5.6", "192.168.1.256", "192.168.01.5", "192.168.1.5 ",
    " 192.168.1.5", "192.168.1.-5", "0x7f.0.0.1", "127.0.0.1:8787", "10.0.0.1/8", "1e1.0.0.1", "１０.0.0.1",
    "192.168.1.5, 8.8.8.8", "10..0.1", ".10.0.0.1", "10.0.0.1.",
    ":", ":::", "::1::", "1::2::3", "fe80:::1", "fe80::1%", "fe80::1%en0;x", "12345::1", "fe80::g", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9",
    "::ffff:192.168.1", "::ffff:192.168.1.256", "::ffff:192.168.1.5.5", "1:2:3:4:5:6:7:192.168.1.5", "[::1", "::1]", "192.168.1.5%en0",
    "a".repeat(200), null, undefined, 42, {}, ["127.0.0.1"],
  ];

  for (const a of loopback) {
    test(`loopback: ${a}`, () => {
      expect(classifyAddress(a)).toBe("loopback");
      expect(isLoopbackAddress(a)).toBe(true);
      expect(isPrivateAddress(a)).toBe(true);
    });
  }
  for (const a of privateOnly) {
    test(`private (not loopback): ${a}`, () => {
      expect(classifyAddress(a)).toBe("private");
      expect(isPrivateAddress(a)).toBe(true);
      expect(isLoopbackAddress(a)).toBe(false);
    });
  }
  for (const a of publicAddrs) {
    test(`public: ${a}`, () => {
      expect(classifyAddress(a)).toBe("public");
      expect(isPrivateAddress(a)).toBe(false);
      expect(isLoopbackAddress(a)).toBe(false);
    });
  }
  for (const a of malformed) {
    test(`malformed → not private: ${JSON.stringify(a)?.slice(0, 40)}`, () => {
      expect(classifyAddress(a)).toBe("invalid");
      expect(isPrivateAddress(a)).toBe(false);
      expect(isLoopbackAddress(a)).toBe(false);
    });
  }

  test("isLanIPv4 accepts RFC 1918 only", () => {
    for (const a of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.10"]) expect(isLanIPv4(a)).toBe(true);
    for (const a of ["127.0.0.1", "169.254.1.1", "100.64.0.1", "8.8.8.8", "172.32.0.1", "fe80::1", "::ffff:192.168.1.5", "nope"]) {
      expect(isLanIPv4(a)).toBe(false);
    }
  });
});
