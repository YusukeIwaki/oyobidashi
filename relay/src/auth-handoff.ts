/** Shared browser/CLI envelope. Secrets travel in a fragment and POST body only. */
export const ACCOUNT_PROVIDERS = ["google", "apple", "github"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export interface AuthHandoff {
  version: 1;
  mode: "signin" | "link";
  callbackUrl: string;
  state: string;
  provider?: AccountProvider;
  uid?: string;
  customToken?: string;
}

export function parseAuthHandoff(value: unknown): AuthHandoff {
  const fail = (): never => {
    throw new Error("invalid authentication handoff");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    !["signin", "link"].includes(String(v.mode)) ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state) ||
    typeof v.callbackUrl !== "string" ||
    (v.provider !== undefined &&
      !ACCOUNT_PROVIDERS.includes(v.provider as AccountProvider))
  )
    return fail();
  let callback: URL;
  try {
    callback = new URL(v.callbackUrl);
  } catch {
    return fail();
  }
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    !callback.port ||
    Number(callback.port) < 1 ||
    callback.pathname !== "/callback" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    return fail();
  if (v.mode === "link") {
    if (
      typeof v.uid !== "string" ||
      !v.uid ||
      v.uid.length > 128 ||
      /[\r\n]/.test(v.uid) ||
      typeof v.customToken !== "string" ||
      v.customToken.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.customToken)
    )
      return fail();
  } else if (v.uid !== undefined || v.customToken !== undefined) return fail();
  return {
    version: 1,
    mode: v.mode as "signin" | "link",
    callbackUrl: callback.href,
    state: v.state,
    ...(v.provider ? { provider: v.provider as AccountProvider } : {}),
    ...(v.mode === "link"
      ? { uid: v.uid as string, customToken: v.customToken as string }
      : {}),
  };
}

export function decodeAuthFragment(fragment: string): AuthHandoff {
  const raw = fragment.replace(/^#/, "");
  if (!raw || raw.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new Error("invalid authentication handoff");
  try {
    const bytes = Uint8Array.from(
      atob(raw.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    return parseAuthHandoff(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error("invalid authentication handoff");
  }
}
