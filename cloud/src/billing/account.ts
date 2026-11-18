import { createHash } from "node:crypto";

// Keep this namespace stable: the stores echo the UUID on future renewals.
const namespace = Buffer.from("1db944207dc14f1fa70b683526a43055", "hex");

/** A stable UUIDv5 for the store purchase flow, containing no raw Firebase UID. */
export function purchaseAccountId(uid: string): string {
  const bytes = createHash("sha1").update(namespace).update(uid, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const id = bytes.toString("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** The store binding and every previously recorded owner must agree. */
export function resolvePurchaseOwner(
  owners: readonly string[],
  uid: string | null,
  accountId?: string,
): string | null {
  const owner = uid ?? owners[0];
  if (!owner || owners.some((known) => known !== owner)) return null;
  if (accountId !== undefined && accountId !== purchaseAccountId(owner)) return null;
  return owner;
}
