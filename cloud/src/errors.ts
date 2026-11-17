export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const invalid = (message: string) =>
  new CloudError(400, "invalid_request", message);
export const conflict = (code: string, message: string) =>
  new CloudError(409, code, message);
export const missing = () =>
  new CloudError(404, "not_found", "resource not found");
export const unauthorized = () =>
  new CloudError(401, "unauthorized", "invalid or missing credentials");
export const unavailable = () =>
  new CloudError(
    503,
    "temporarily_unavailable",
    "一時的に接続できません。通信を確認して、もう一度お試しください。",
  );
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > 65536)
    throw new CloudError(413, "payload_too_large", "body exceeds 64KB");
  const reader = req.body?.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536) {
          await reader.cancel();
          throw new CloudError(413, "payload_too_large", "body exceeds 64KB");
        }
        chunks.push(value);
      }
  } finally {
    reader?.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("body must be a JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("body must be a JSON object");
  return value as Record<string, unknown>;
}
export function string(
  body: Record<string, unknown>,
  key: string,
  max: number,
  required = false,
): string | null {
  const v = body[key];
  if (v === null || v === undefined) {
    if (required) throw invalid(`${key} is required`);
    return null;
  }
  if (
    typeof v !== "string" ||
    Array.from(v).length > max ||
    (required && !v.trim())
  )
    throw invalid(
      `${key} must be a string of ${required ? "1" : "0"}-${max} characters`,
    );
  return v;
}
export function enumeration<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const v = body[key];
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string" || !values.includes(v as T))
    throw invalid(`${key} is invalid`);
  return v as T;
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw invalid(`value must be an integer between ${min} and ${max}`);
  return value;
}
