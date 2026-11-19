/**
 * Push credentials baked into a self-built single binary (`standalone/build.ts`).
 * The build replaces `__OYOBIDASHI_EMBEDDED_PUSH__` with an object literal; when running
 * from source the identifier does not exist and nothing is embedded.
 *
 * Anything embedded can be read back out of the binary, so such a binary is as secret
 * as the key files themselves: never distribute or commit it.
 */
export interface EmbeddedApns {
  key_pem: string;
  key_id: string;
  team_id: string;
  bundle_id?: string;
}
export interface EmbeddedFcm {
  service_account_json: string;
}
export interface EmbeddedPush {
  apns?: EmbeddedApns;
  fcm?: EmbeddedFcm;
}

declare const __OYOBIDASHI_EMBEDDED_PUSH__: EmbeddedPush | undefined;

export function embeddedPush(): EmbeddedPush | null {
  if (typeof __OYOBIDASHI_EMBEDDED_PUSH__ === "undefined") return null;
  return __OYOBIDASHI_EMBEDDED_PUSH__ ?? null;
}
