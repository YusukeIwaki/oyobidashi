import {
  X509Certificate,
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { compactVerify, decodeProtectedHeader } from "jose";

/** https://www.apple.com/certificateauthority/ — Apple Root CA - G3 (signs App Store JWS). */
export const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** Apple App Attestation Root CA (signs App Attest credential certificates). */
export const APPLE_APP_ATTEST_ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** Any failure is reported as this one error; details never reach clients or logs. */
export class VerificationError extends Error {
  constructor() {
    super("verification failed");
  }
}
const fail = (): never => {
  throw new VerificationError();
};
const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.compare(a, b) === 0;

// DER encodings of the marker extensions Apple puts on its certificates.
const OID_STORE_LEAF = Buffer.from("060a2a864886f76364060b01", "hex");
const OID_STORE_INTERMEDIATE = Buffer.from("060a2a864886f76364060201", "hex");
const OID_ATTEST_NONCE = Buffer.from("06092a864886f763640802", "hex");

/**
 * Validates `chain` (leaf first) up to the pinned root and returns the leaf.
 * The last element may be the root itself or be signed by it.
 */
function verifyChain(chain: Buffer[], rootPem: string, at: number) {
  if (chain.length < 2 || chain.length > 4) fail();
  const root = new X509Certificate(rootPem);
  let certs: X509Certificate[];
  try {
    certs = chain.map((der) => new X509Certificate(der));
  } catch {
    return fail();
  }
  if (!equal(certs.at(-1)!.raw, root.raw)) certs.push(root);
  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i]!;
    // A freshly issued certificate may be a little ahead of this server's clock.
    if (at + 300_000 < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo)) fail();
    const issuer = certs[i + 1] ?? root;
    if (i > 0 && !cert.ca) fail();
    if (!cert.verify(issuer.publicKey)) fail();
  }
  return certs;
}

/**
 * Verifies an App Store signed JWS (transaction, renewal info or notification)
 * offline against Apple Root CA - G3 and returns its payload.
 */
export async function verifyAppleJws(
  jws: string,
  now: number,
  rootPem = APPLE_ROOT_CA_G3,
  maxLength = 16_384,
): Promise<Record<string, unknown>> {
  try {
    if (typeof jws !== "string" || jws.length > maxLength) fail();
    const header = decodeProtectedHeader(jws);
    if (header.alg !== "ES256" || !Array.isArray(header.x5c)) fail();
    const chain = (header.x5c as string[]).map((c) => Buffer.from(c, "base64"));
    if (chain.length !== 3) fail();
    const certs = verifyChain(chain, rootPem, now);
    if (!certs[0]!.raw.includes(OID_STORE_LEAF)) fail();
    if (!certs[1]!.raw.includes(OID_STORE_INTERMEDIATE)) fail();
    const { payload } = await compactVerify(jws, certs[0]!.publicKey);
    const value: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return value as Record<string, unknown>;
  } catch {
    return fail();
  }
}

/** Minimal CBOR reader for the definite-length subset App Attest emits. */
function cbor(input: Uint8Array): unknown {
  let at = 0;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const length = (info: number) => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8((at += 1) - 1);
    if (info === 25) return view.getUint16((at += 2) - 2);
    if (info === 26) return view.getUint32((at += 4) - 4);
    return fail();
  };
  const read = (depth: number): unknown => {
    if (depth > 8 || at >= input.length) fail();
    const first = input[at++]!,
      major = first >> 5,
      n = length(first & 31);
    if (major === 0) return n;
    if (major === 2 || major === 3) {
      if (at + n > input.length) fail();
      const bytes = input.subarray(at, (at += n));
      return major === 2 ? Buffer.from(bytes) : Buffer.from(bytes).toString("utf8");
    }
    if (major === 4) {
      if (n > 16) fail();
      return Array.from({ length: n }, () => read(depth + 1));
    }
    if (major === 5) {
      if (n > 16) fail();
      const map: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = read(depth + 1);
        if (typeof key !== "string") fail();
        map[key as string] = read(depth + 1);
      }
      return map;
    }
    return fail();
  };
  const value = read(0);
  if (at !== input.length) fail();
  return value;
}

function uncompressedPoint(cert: X509Certificate) {
  const jwk = cert.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) fail();
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
}

export interface AttestOptions {
  /** `<Team ID>.<Bundle ID>` */
  appId: string;
  /** Which App Attest environments this deployment accepts. */
  environments: readonly ("production" | "development")[];
  now: number;
  rootPem?: string;
}
const AAGUID = {
  production: Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]),
  development: Buffer.from("appattestdevelop"),
};

/**
 * Validates a DCAppAttestService attestation object for `clientDataHash` and
 * returns the attested public key (PEM) for later assertions.
 * https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 */
export function verifyAttestation(
  attestation: Uint8Array,
  keyId: Uint8Array,
  clientDataHash: Uint8Array,
  options: AttestOptions,
): { publicKeyPem: string; environment: "production" | "development" } {
  try {
    const object = cbor(attestation) as {
      fmt?: unknown;
      attStmt?: { x5c?: unknown };
      authData?: unknown;
    };
    const x5c = object.attStmt?.x5c;
    const authData = object.authData;
    if (
      object.fmt !== "apple-appattest" ||
      !Array.isArray(x5c) ||
      !x5c.every((c) => Buffer.isBuffer(c)) ||
      !Buffer.isBuffer(authData)
    )
      fail();
    const data = authData as Buffer;
    const certs = verifyChain(
      x5c as Buffer[],
      options.rootPem ?? APPLE_APP_ATTEST_ROOT,
      options.now,
    );
    const leaf = certs[0]!;
    // The nonce is the only value in this extension: OCTET STRING{SEQUENCE{[1]{OCTET STRING(32)}}}.
    const at = leaf.raw.indexOf(OID_ATTEST_NONCE);
    if (at < 0) fail();
    const ext = leaf.raw.subarray(at + OID_ATTEST_NONCE.length, at + OID_ATTEST_NONCE.length + 40);
    const prefix = Buffer.from("04263024a1220420", "hex");
    if (!equal(ext.subarray(0, prefix.length), prefix)) fail();
    const nonce = sha256(data, clientDataHash);
    if (!equal(ext.subarray(prefix.length, prefix.length + 32), nonce)) fail();
    if (!equal(sha256(uncompressedPoint(leaf)), keyId)) fail();
    // authData: rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId
    if (data.length < 55 + keyId.length) fail();
    if (!equal(data.subarray(0, 32), sha256(options.appId))) fail();
    if (data.readUInt32BE(33) !== 0) fail();
    const aaguid = data.subarray(37, 53);
    const environment = options.environments.find((e) => equal(aaguid, AAGUID[e]));
    if (!environment) fail();
    const idLength = data.readUInt16BE(53);
    if (idLength !== keyId.length || !equal(data.subarray(55, 55 + idLength), keyId)) fail();
    return {
      publicKeyPem: leaf.publicKey.export({ type: "spki", format: "pem" }) as string,
      environment: environment!,
    };
  } catch {
    return fail();
  }
}

/** Validates an assertion and returns its counter, which must exceed `previousCounter`. */
export function verifyAssertion(
  assertion: Uint8Array,
  clientDataHash: Uint8Array,
  publicKeyPem: string,
  appId: string,
  previousCounter: number,
): number {
  try {
    const object = cbor(assertion) as { signature?: unknown; authenticatorData?: unknown };
    if (!Buffer.isBuffer(object.signature) || !Buffer.isBuffer(object.authenticatorData)) fail();
    const data = object.authenticatorData as Buffer;
    if (data.length < 37) fail();
    const nonce = sha256(data, clientDataHash);
    if (!verifySignature("sha256", nonce, createPublicKey(publicKeyPem), object.signature as Buffer)) fail();
    if (!equal(data.subarray(0, 32), sha256(appId))) fail();
    const counter = data.readUInt32BE(33);
    if (counter <= previousCounter) fail();
    return counter;
  } catch {
    return fail();
  }
}
