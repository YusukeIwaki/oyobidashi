# Oyobidashi v0.2 native/relay contract

Cloud deployments additionally use [CLOUD_PROTOCOL.md](CLOUD_PROTOCOL.md) for per-user authentication, durable asynchronous turns, and restart recovery. Native clients accept both LAN synchronous responses and cloud asynchronous responses.

Keep the existing v1 protocol; the following fields and endpoints extend it.

Request JSON adds `priority: low|normal|high|urgent` (default normal), `delivery_mode: actions|text|call` (effective mode), `requested_mode: auto|actions|text|call`, `call: Call|null`. Absent fields must decode with defaults for old fixtures. Existing urgency remains normal/high for compatibility.

POST /v1/requests accepts priority and delivery_mode (auto default). Auto: short choice-only requests with <=3 choices and context <=160 characters use actions; others text. Calls require explicit call mode and high/urgent priority; busy/away/snoozed presence downgrades to text. New calls ring immediately. Only one ringing/active call per relay; other calls fall back to text. A call is a genuine VoIP interaction: native OS call interface and on-device speech recognition / speech synthesis, turn text transported over authenticated network to relay's CLI-backed conversation.

`Call = {id: UUID, request_id, state: ringing|active|ended, outcome: null|resolved|declined|hangup|missed|cancelled|expired|failed, device_id: string|null, started_at: ISO8601, updated_at: ISO8601, transcript:[{role:user|assistant,text:string}]}`.

GET /v1/requests/{id} contains latest call.
POST /v1/requests/{id}/call authenticated as device, body {event: answer|decline|hangup|turn|failed, text?: string}. Response {request,call,reply?:string,resolved?:boolean}. Answer claims call for device and returns initial spoken question in reply. Turn invokes CLI and returns conversational reply/resolved. A resolved turn creates the normal Answer(input_method voice), ends the call, emits updated request. Decline/hangup/missed/failed retain pending request and fall back to text (no automatic redial). Requests expire as before; call ring timeout 45s. Remote cancel or resolution ends native call.

Call changes are sent through existing `request.updated` events with the full request. `hello.pending` includes live calls. Clients must reconcile incoming calls, answered on other devices, remote ended calls, missed fallback, and remove notifications on terminal states.

PUT /v1/devices/me accepts `voip_token: string|null` independently of normal push_token (iOS PushKit). Environment reuses push_environment. APNs VoIP pushes include request_id, call_id, question, optional subject and agent_name; they are ONLY used for a new ringing call and must immediately report CallKit. Call cancellation travels via authenticated websocket, never VoIP push.

Requests and POST /v1/requests accept optional `subject: string|null` (at most 40 Unicode code points before whitespace normalization). Whitespace is collapsed to one line; blank means absent. MCP ask_human accepts the same optional subject. iOS appends it to the caller name (`Codex：本番デプロイの承認`), including the initial PushKit report without waiting for a network request. Android shows it above the question in the call screen. Older requests and pushes without a subject retain their existing display. Subjects are intended to be visible on the lock screen; keep sensitive details in question/context.

PUT /v1/presence (device auth) body {availability: available|busy|away, until?:ISO8601|null, note?:string|null}; GET /v1/presence (agent: all devices and feedback; device: own presence only) => {devices:[{device_id,availability,until,note,updated_at,last_seen_at}],recent_events:[{request_id,device_id,event,at}], now}. Default available; expired busy/away becomes available. User-controlled availability UI in settings/home. Agent feedback includes call declined/hangup/missed/failed; no inference of private OS activity.

PATCH /v1/requests/{id} (agent auth) body {priority?,delivery_mode?}; recalculates delivery policy and broadcasts. POST cancel works for pending questions AND notified one-way notifications. Terminal transitions dispatch silent ordinary push to reconcile stale delivered notifications. PushKit is never used to cancel.

Notifications: actions mode has choice buttons that POST answer(choice_index), text mode opens detail, call mode native call. A regular launch always loads outstanding requests. Reconcile on foreground/websocket reconnect. iOS remote APNs identifier may differ from request_id: scan delivered notification userInfo.request_id when removing. Show stale requests as closed with no submit button. Keep drafts on transport failure; never pretend success. Low priority uses passive notification; normal active; high/urgent timeSensitive. Android uses quiet/default/high channels accordingly.

Conversation implementation on relay: OYOBIDASHI_CONVERSATION_PROVIDER=claude (automated tests inject a provider; no fake production fallback). A trusted fixed executable receives user data via stdin without shell interpolation, no tools, constrained structured output {reply:string,resolved:boolean,answer:string|null}. Native speech APIs require mic/speech permission. Never auto-resolve merely from a partial transcript. Structured result must explicitly resolve and have a nonempty answer. Provider failure returns error, allowing retry or text fallback.

For integration use real relay and native UI pairing deep links. Do not add fake request data/screens to production. iOS Bundle ID me.oyobidashi.ios; Android application ID and Kotlin package me.oyobidashi.android. UI Japanese, pager theme: warm cream, dark ink, orange accent and tiny green LCD motif. Icons native/vector: pager with three keys and small AI sparkle; Android adaptive foreground/background/monochrome.


Remote device access: default is private LAN. An explicit `serve --public-url https://YOUR_HOST --host 127.0.0.1` trusts a TLS reverse proxy on loopback only when X-Forwarded-Host exactly matches YOUR_HOST and X-Forwarded-Proto=https. Forwarded agent-token traffic is rejected for every agent endpoint. This requires the owner to configure DNS, a trusted TLS certificate and proxy (docs/Caddyfile.example); the repository does not publish a public endpoint automatically. Native apps support HTTPS/WSS. Pairing is still one-time-code + per-device token. Never bypass TLS validation.


MCP resource `human://status` exposes the same presence/feedback JSON as GET /v1/presence. Clients can subscribe and receive notifications/resources/updated when the content changes (5-second polling, only while subscribed). Unsubscribe and transport close stop polling. No availability is fabricated when the relay is unreachable.


## 複数項目の質問

`ask_human` と `POST /v1/requests` は任意の `items` を受け取る。対応するサーバー・MCP・アプリの組み合わせで利用する。`items` を省略した既存の質問は従来の形式で回答する。

```json
{
  "question": "発送方法を確認します。",
  "items": [
    { "id": "route", "question": "通常便と速達のどちらですか？", "choices": ["通常便", "速達"] },
    { "id": "date", "question": "速達の期限はいつですか？", "applies_when": { "item_id": "route", "choice_index": 1 } },
    { "id": "label", "question": "ラベルの版はどれですか？", "ask_on_call": false }
  ]
}
```

- 対応アプリは質問一覧を取得するときに `X-Oyobidashi-Request-Items: 1` を送る。ペアリング済みの全端末が対応を通知したら、エージェントの `GET /v1/presence` に `request_items_supported: true` が含まれる。それまではMCPが番号付きのテキスト質問に変換し、従来の回答欄から返信できるようにする。
- `items` は2〜8件。トップレベルの `question` は用件の要約（160文字以内）、`context` は共通の補足。トップレベルの `choices` は省略する。
- 各項目に一意の `id`（英数字・`_`・`-`、最大40文字）と `question`（最大500文字）を付ける。`context`（最大1000文字）と `choices`（最大5件、各200文字）は任意。`choices` がある場合、回答はその選択肢のいずれか。
- `applies_when` は先行項目の `item_id` と0始まりの `choice_index`。先行項目でその選択肢が回答されたときに表示・質問し、別の選択肢が回答された場合や先行項目自体が対象外の場合は対象外になる。
- 通話では最初に用件と1問目を読み、以降は回答・条件を見て次の1問を選ぶ。会話モデルは直近の発話に根拠がある回答を項目IDで抽出し、サーバーが受理した回答をターンごとに保存する。`ask_on_call: false` の項目は電話から聞かず、通話で保留した項目とともにアプリで回答できる。通話で選択肢や判断に必要な前提を読み上げる場合は各項目の `question` に含める。
- 通話で聞く項目が残っていない場合や利用者が切り替えを求めた場合、ターン応答は `end_call: true` と `resolved: false` を返す。アプリは案内を読んだ後で `hangup` を送信する。送信されなければサーバーが60秒後に通話を閉じる。リクエストは未回答の項目がある間 `pending` のまま。
- `item_answers` は項目ID付きの結果。保存済みの回答は `answered`、通話で後回しにした項目は `deferred`、条件から外れた項目は `not_applicable`。未回答で保留されていない項目は配列に含まれない。状態の例は [request_item_progress.json](fixtures/request_item_progress.json)。
- アプリは `POST /v1/requests/{id}/answer` に残りの `item_answers: [{item_id, text} | {item_id, choice_index}]` をまとめて送る。自由記述は項目ごとに最大1000文字。保存済みの通話回答と合わせて、適用対象の全項目が回答済みになった時点で `answered` になる。MCP は `item_answers` で項目ごとの回答と入力方法を返し、従来の `answer` でも回答済み項目の要約を返す。
