import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactSign } from "jose";

/** Test-only certificate authorities built with the openssl CLI. Never used by production code. */
function openssl(dir: string, ...args: string[]) {
  const result = Bun.spawnSync(["openssl", ...args], { cwd: dir, stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`openssl ${args[0]} failed: ${result.stderr.toString().slice(0, 300)}`);
}
function authority(dir: string, name: string) {
  openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl(dir, "req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-days", "30",
    "-out", `${name}.pem`, "-addext", "basicConstraints=critical,CA:TRUE");
}
function issue(dir: string, name: string, issuer: string, extensions: string, key?: string) {
  if (key) writeFileSync(join(dir, `${name}.key`), key);
  else openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  writeFileSync(join(dir, `${name}.cnf`), extensions);
  openssl(dir, "req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`);
  openssl(dir, "x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`,
    "-CAcreateserial", "-days", "30", "-out", `${name}.pem`, "-extfile", `${name}.cnf`);
}
const der = (dir: string, name: string) => {
  const pem = readFileSync(join(dir, `${name}.pem`), "utf8");
  return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
};
const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

function head(major: number, n: number) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
export function cborEncode(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  const entries = Object.entries(value as Record<string, unknown>);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])]);
}

/** A fake App Store: signs transactions the way StoreKit 2 does. */
export function fakeAppStore() {
  const dir = mkdtempSync(join(tmpdir(), "oyobidashi-store-"));
  try {
    authority(dir, "root");
    issue(dir, "intermediate", "root", "basicConstraints=critical,CA:TRUE\n1.2.840.113635.100.6.2.1=DER:0500\n");
    issue(dir, "leaf", "intermediate", "1.2.840.113635.100.6.11.1=DER:0500\n");
    const key = createPrivateKey(readFileSync(join(dir, "leaf.key"), "utf8"));
    const x5c = ["leaf", "intermediate", "root"].map((n) => der(dir, n).toString("base64"));
    return {
      rootPem: readFileSync(join(dir, "root.pem"), "utf8"),
      sign: (payload: Record<string, unknown>, chain = x5c) =>
        new CompactSign(Buffer.from(JSON.stringify(payload)))
          .setProtectedHeader({ alg: "ES256", x5c: chain })
          .sign(key),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake Secure Enclave: one App Attest key with its attestation and assertions. */
export function fakeAppAttest(appId: string) {
  const dir = mkdtempSync(join(tmpdir(), "oyobidashi-attest-"));
  authority(dir, "root");
  issue(dir, "intermediate", "root", "basicConstraints=critical,CA:TRUE\n");
  const rootPem = readFileSync(join(dir, "root.pem"), "utf8");
  let serial = 0;
  const device = (environment: "production" | "development" = "production") => {
    const name = `device${serial++}`;
    openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
    const keyPem = readFileSync(join(dir, `${name}.key`), "utf8");
    const key = createPrivateKey(keyPem);
    const jwk = createPublicKey(key).export({ format: "jwk" });
    const keyId = sha256(
      Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]),
    );
    let counter = 0;
    return {
      keyId: keyId.toString("base64"),
      attestation(challenge: string, forAppId = appId) {
        const aaguid =
          environment === "production"
            ? Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)])
            : Buffer.from("appattestdevelop");
        const length = Buffer.alloc(2);
        length.writeUInt16BE(keyId.length);
        const authData = Buffer.concat([sha256(forAppId), Buffer.from([0x40]), Buffer.alloc(4), aaguid, length, keyId]);
        const nonce = sha256(authData, sha256(challenge));
        issue(dir, name, "intermediate", `1.2.840.113635.100.8.2=DER:3024a1220420${nonce.toString("hex")}\n`, keyPem);
        return cborEncode({
          fmt: "apple-appattest",
          attStmt: { x5c: [der(dir, name), der(dir, "intermediate")], receipt: Buffer.alloc(4) },
          authData,
        }).toString("base64");
      },
      assertion(payload: string, options: { counter?: number; appId?: string } = {}) {
        const count = Buffer.alloc(4);
        count.writeUInt32BE(options.counter ?? ++counter);
        const authenticatorData = Buffer.concat([sha256(options.appId ?? appId), Buffer.from([0]), count]);
        const signature = sign("sha256", sha256(authenticatorData, sha256(payload)), key);
        return cborEncode({ signature, authenticatorData }).toString("base64");
      },
    };
  };
  return { rootPem, device, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
