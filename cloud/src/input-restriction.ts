// The FREE plan input restriction of the hosted service.
//
// It applies to exactly one combination: an owner without an active subscription
// on a deployment whose FREE voice model accepts no personal or confidential
// input. Subscribers and every self-hosted deployment are never restricted.
//
// The owner accepts it once, in the browser, while linking an agent. Nothing is
// asked during a call. This module has no runtime dependencies because the
// browser bundle shares it.

/** Raised whenever the wording below changes in a way that needs a new acceptance. */
export const INPUT_RESTRICTION_VERSION = 1;

export interface InputRestriction {
  /** The restriction applies to this owner right now. */
  restricted: boolean;
  /** The owner accepted the current version. Always false when not restricted. */
  accepted: boolean;
  version: number;
}

export const UNRESTRICTED_INPUT: InputRestriction = {
  restricted: false,
  accepted: false,
  version: INPUT_RESTRICTION_VERSION,
};

export const INPUT_RESTRICTION_TERMS = {
  heading: "FREEプランの入力制限",
  summary:
    "FREEプランの音声通話では、質問や会話の内容がAIモデルの学習に使われる場合があります。そのため、個人情報や機密情報を扱えません。",
  rules: [
    "エージェントから届く質問・補足・選択肢に、個人情報や機密情報を含めさせません。",
    "通話で、個人情報や機密情報を話しません。",
  ],
  alternative: "個人情報や機密情報を扱う場合は、PLUSプランをご利用ください。PLUSプランにこの制限はありません。",
  accept: "個人情報・機密情報を送らないことに同意する",
} as const;

/** Shown on the phone when a call cannot use voice because the acceptance is missing. */
export const INPUT_CONSENT_MISSING_MESSAGE =
  "FREEプランの入力制限への同意がまだのため、音声では応答できません。文字で返信できます。";

/** Reads the status response without trusting its shape. */
export function parseInputRestriction(value: unknown): InputRestriction {
  const v = value as Partial<InputRestriction> | null;
  if (!v || typeof v.restricted !== "boolean" || typeof v.accepted !== "boolean" || typeof v.version !== "number")
    throw new Error("invalid input restriction response");
  return { restricted: v.restricted, accepted: v.accepted, version: v.version };
}

/** The acceptance step is shown only to a restricted owner who has not accepted yet. */
export function needsInputConsent(state: InputRestriction): boolean {
  return state.restricted && !state.accepted;
}
