import { expect, test } from "bun:test";
import { authorizationParams, pairedDevices, pairingUrl, qrPath } from "../src/oauth-browser-flow.ts";

test("only known authorization fields are forwarded", () => {
  const out = authorizationParams("?client_id=kmc_1&state=s&decision=approve&uid=mallory&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=second");
  expect(out).toEqual({ client_id: "kmc_1", state: "s", redirect_uri: "http://127.0.0.1/cb" });
  expect(authorizationParams(`?state=${"x".repeat(4001)}`)).toEqual({});
});
test("the pairing URL matches the terminal command's format", () => {
  expect(pairingUrl("https://api.example.test", "a_b-c")).toBe("oyobidashi://pair?url=https%3A%2F%2Fapi.example.test&code=a_b-c");
});
test("a pairing URL fits a QR code with a quiet zone and finder patterns", () => {
  const { size, path } = qrPath(pairingUrl("https://api.oyobidashi.me", "A".repeat(43)));
  const modules = size - 8;
  expect(modules).toBeGreaterThanOrEqual(21);
  expect((modules - 21) % 4).toBe(0);
  // Finder patterns start at the three corners, inside the quiet zone.
  expect(path).toContain("M4 4h1v1h-1z");
  expect(path).toContain(`M${size - 5} 4h1v1h-1z`);
  expect(path).toContain(`M4 ${size - 5}h1v1h-1z`);
  expect(path).not.toMatch(/M[0-3] /);
});
test("presence responses are counted defensively", () => {
  expect(pairedDevices({ devices: [{}, {}] })).toBe(2);
  expect(() => pairedDevices({})).toThrow();
  expect(() => pairedDevices(null)).toThrow();
});
