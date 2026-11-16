import type { DeliveryMode, Presence, Priority, RequestedMode } from "./types.ts";

/** Calls are opt-in, exceptional, and respect the human's explicitly shared availability. */
export function deliveryMode(input: { requested: RequestedMode; priority: Priority; choices: string[] | null; question: string; context: string | null; presence: Presence[]; anotherCall: boolean }): DeliveryMode {
  const shortActions = (input.choices?.length ?? 0) > 0 && input.choices!.length <= 3 && input.question.length <= 160 && (input.context?.length ?? 0) <= 160;
  if (input.requested === "call") {
    if (!["high", "urgent"].includes(input.priority) || input.anotherCall || input.presence.some(p => p.availability !== "available")) return "text";
    return "call";
  }
  if (input.requested === "text") return "text";
  if (input.requested === "actions") return shortActions ? "actions" : "text";
  return shortActions ? "actions" : "text";
}
