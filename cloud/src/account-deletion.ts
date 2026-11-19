import { SignJWT } from "jose";
import type { AccountAuth } from "./account-auth.ts";
import { invalid, string, unauthorized, unavailable } from "./errors.ts";
import { hash, type CloudService } from "./service.ts";
import type { IdentityVerifier } from "./types.ts";

const googleTokenURL = "https://oauth2.googleapis.com/token";
const toolkit = "https://identitytoolkit.googleapis.com";
const ticketLifetime = 10 * 60_000;

interface DirectoryResponse {
  error?: { message?: string };
  users?: { localId: string; providerUserInfo?: { providerId: string }[] }[];
}

export interface AccountDirectory {
  hasApple(uid: string): Promise<boolean>;
  revokeApple(idToken: string, appleToken: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export function firebaseAccountDirectory(
  project: string,
  apiKey: string,
  email: string,
  key: Parameters<SignJWT["sign"]>[0],
  now = Date.now,
  send = fetch,
): AccountDirectory {
  let access: { value: string; expires: number } | undefined;
  async function post(url: string, body: unknown, bearer?: string) {
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }).catch(() => { throw unavailable(); });
    const data = await response.json().catch(() => { throw unavailable(); });
    return { response, data };
  }
  async function admin(operation: string, uid: string) {
    if (!access || access.expires <= now()) {
      const iat = Math.floor(now() / 1000);
      const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/identitytoolkit" })
        .setProtectedHeader({ alg: "RS256" }).setIssuer(email).setAudience(googleTokenURL)
        .setIssuedAt(iat).setExpirationTime(iat + 3600).sign(key);
      const result = await send(googleTokenURL, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }).catch(() => { throw unavailable(); });
      const data = await result.json().catch(() => { throw unavailable(); }) as { access_token?: string; expires_in?: number };
      if (!result.ok || typeof data.access_token !== "string" || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) throw unavailable();
      access = { value: data.access_token, expires: now() + data.expires_in * 1000 - 60_000 };
    }
    const { response, data } = await post(
      `${toolkit}/v1/projects/${project}/accounts:${operation}`,
      { localId: operation === "lookup" ? [uid] : uid },
      access.value,
    );
    if (!data || typeof data !== "object") throw unavailable();
    const result = data as DirectoryResponse;
    if (!response.ok && result.error?.message !== "USER_NOT_FOUND") throw unavailable();
    return result;
  }
  return {
    async hasApple(uid) {
      const data = await admin("lookup", uid);
      if (data.users === undefined && !data.error) return false;
      if (data.error?.message === "USER_NOT_FOUND") return false;
      if (!Array.isArray(data.users)) throw unavailable();
      const user = data.users.find(user => user?.localId === uid);
      if (!user || user.providerUserInfo === undefined) return false;
      if (!Array.isArray(user.providerUserInfo)) throw unavailable();
      return user.providerUserInfo.some(provider => provider?.providerId === "apple.com");
    },
    async revokeApple(idToken, appleToken) {
      const { response } = await post(`${toolkit}/v2/accounts:revokeToken?key=${encodeURIComponent(apiKey)}`, {
        providerId: "apple.com", tokenType: "ACCESS_TOKEN", token: appleToken, idToken,
      });
      if (!response.ok) throw unavailable();
    },
    async deleteUser(uid) { await admin("delete", uid); },
  };
}

export class AccountDeletion {
  constructor(
    private readonly service: CloudService,
    private readonly verifier: IdentityVerifier,
    private readonly auth?: AccountAuth,
  ) {}
  async start(req: Request) {
    const directory = this.auth?.directory;
    if (!directory) throw unavailable();
    const credential = /^Bearer (kd_[A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!credential) throw unauthorized();
    const digest = hash(credential);
    const found = await this.service.db.findDevice(digest);
    if (!found || found.device.platform !== "ios") throw unauthorized();
    const { uid, device } = found;
    const pending = await this.service.db.transaction(uid, async tx => {
      if ((await tx.get("device", device.id))?.tokenHash !== digest) throw unauthorized();
      await this.service.accountDeletionAttempt(tx);
      return !!await tx.get("account_deletion", "current");
    });
    if (!pending && await directory.hasApple(uid)) {
      const ticket = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
      await this.service.db.transaction(uid, async tx => {
        await this.service.ensureAccount(tx);
        if ((await tx.get("device", device.id))?.tokenHash !== digest) throw unauthorized();
        const expires = this.service.now() + ticketLifetime;
        await tx.put("account_delete_ticket", hash(ticket), { deviceId: device.id, expires }, expires);
      });
      return { status: "reauthentication", ticket };
    }
    await this.service.db.transaction(uid, async tx => {
      if ((await tx.get("device", device.id))?.tokenHash !== digest) throw unauthorized();
      await tx.put("account_deletion", "current", { started: this.service.now() });
    });
    await this.finish(uid, directory);
    return { status: "deleted" };
  }
  async verifyApple(body: Record<string, unknown>) {
    const directory = this.auth?.directory;
    if (!directory || !this.verifier.identify) throw unavailable();
    const ticket = string(body, "ticket", 43, true)!;
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw invalid("invalid account deletion ticket");
    const key = hash(ticket);
    const uid = await this.service.db.findAccountDeletion(key);
    if (!uid) throw unauthorized();
    const idToken = string(body, "identity_token", 8192, true)!;
    const identity = await this.verifier.identify(idToken);
    if (identity.uid !== uid || identity.provider !== "apple.com" || !identity.authenticatedAt || identity.authenticatedAt > this.service.now() ||
        this.service.now() - identity.authenticatedAt >= ticketLifetime) throw unauthorized();
    const check = () => this.service.db.transaction(uid, async tx => {
      const grant = await tx.get("account_delete_ticket", key);
      if (!grant || grant.expires <= this.service.now() || !await tx.get("device", grant.deviceId)) throw unauthorized();
      return !!await tx.get("account_deletion", "current");
    });
    if (!await check()) {
      await directory.revokeApple(idToken, string(body, "apple_token", 8192, true)!);
      await this.service.db.transaction(uid, async tx => {
        const grant = await tx.get("account_delete_ticket", key);
        if (!grant || grant.expires <= this.service.now() || !await tx.get("device", grant.deviceId)) throw unauthorized();
        await tx.put("account_deletion", "current", { started: this.service.now() });
      });
    }
    await this.finish(uid, directory);
    return uid;
  }
  private async finish(uid: string, directory: AccountDirectory) {
    await directory.deleteUser(uid);
    await this.service.db.transaction(uid, async tx => {
      if (!await tx.accountDeleted()) await tx.eraseAccount();
    });
    await this.service.wake(uid);
  }
}
