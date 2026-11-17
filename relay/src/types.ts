export const VERSION = "0.2.0";
export const IOS_APP_ID = "me.oyobidashi.ios";
export const ANDROID_APP_ID = "me.oyobidashi.android";

export type Kind = "question" | "notification";
export type Urgency = "normal" | "high";
export type Status = "pending" | "answered" | "cancelled" | "expired" | "notified";
export type InputMethod = "text" | "voice" | "choice";
export type Platform = "ios" | "android";
export type PushEnvironment = "development" | "production";

export const KINDS: readonly Kind[] = ["question", "notification"];
export const URGENCIES: readonly Urgency[] = ["normal", "high"];
export const STATUSES: readonly Status[] = ["pending", "answered", "cancelled", "expired", "notified"];
export const INPUT_METHODS: readonly InputMethod[] = ["text", "voice", "choice"];
export const PLATFORMS: readonly Platform[] = ["ios", "android"];
export const PUSH_ENVIRONMENTS: readonly PushEnvironment[] = ["development", "production"];

export interface Answer {
  text: string;
  choice_index: number | null;
  input_method: InputMethod;
  device_id: string;
  answered_at: string;
}

export interface AgentInfo {
  name: string | null;
  cwd: string | null;
}

export type Priority = "low" | "normal" | "high" | "urgent";
export type DeliveryMode = "actions" | "text" | "call";
export type RequestedMode = DeliveryMode | "auto";
export interface Call {
  id: string;
  request_id: string;
  state: "ringing" | "active" | "ended";
  outcome: "resolved" | "declined" | "hangup" | "missed" | "cancelled" | "expired" | "failed" | null;
  device_id: string | null;
  started_at: string;
  updated_at: string;
  transcript: { role: "user" | "assistant"; text: string }[];
}
export interface Presence {
  device_id: string;
  availability: "available" | "busy" | "away";
  until: string | null;
  note: string | null;
  updated_at: string;
  last_seen_at: string;
}
export interface FeedbackEvent { request_id: string; device_id: string | null; event: string; at: string }

export interface RequestObject {
  /** Cloud only: lets native clients reject stale pushes from a former pairing. */
  recipient_device_id?: string;
  preview_url?:string;
  preview_token?:string;
  priority?: Priority;
  delivery_mode?: DeliveryMode;
  requested_mode?: RequestedMode;
  call?: Call | null;
  id: string;
  kind: Kind;
  question: string;
  /** Short, optional call subject (at most 40 characters). */
  subject?: string | null;
  context: string | null;
  choices: string[] | null;
  urgency: Urgency;
  status: Status;
  answer: Answer | null;
  agent: AgentInfo | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface DeviceObject {
  id: string;
  name: string;
  platform: Platform;
  created_at: string;
}

export interface Delivery {
  paired_devices: number;
  websocket_delivered: number;
  push_attempted: number;
}

export type ServerEvent =
  | { type: "hello"; pending: RequestObject[] }
  | { type: "request.created"; request: RequestObject }
  | { type: "request.updated"; request: RequestObject }
  | { type: "pong" };
