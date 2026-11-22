# Cloud protocol and recovery contract

The cloud deployment preserves the v1 request/device/presence/event shapes and the
LAN relay remains available. Cloud authorization and asynchronous voice turns are
additive. This document is the implementation contract for all components.

## Identity and pairing

Agent requests use a Firebase Authentication ID token in `Authorization: Bearer`.
The server verifies the signature, issuer, audience, expiry and subject; it never
uses a UID supplied by the client as authorization. The local stdio MCP bridge
authenticates this way. MCP clients that connect by URL use the hosted endpoint
and its own OAuth tokens instead; see "Hosted MCP endpoint" below.

`POST /v1/pairing-codes` (agent auth) returns `{code, expires_at}`. Codes are random,
single-use, valid for ten minutes and stored hashed. Existing `POST /v1/pair` binds
the device to the code owner's UID and returns the usual device token. Device
tokens remain separate from Firebase credentials. A device can only read/reply to
its owner's requests. Other users' resource IDs return 404. Credentials and pairing
codes must never appear in logs or repository artifacts.

The stdio login starts with a Firebase anonymous account. Re-running login with
the same credential file refreshes that account instead of creating another UID.
Anonymous refresh credentials are the only way back to an unlinked account;
Firebase's automatic anonymous-user cleanup must remain disabled. Linking an
external identity retains the UID and all device pairings. Recovery with that
identity restores the UID even without the original credential file. A normal
sign-in refuses to replace a different saved account; explicit `--recover` backs
up that file with mode 0600 before replacement. A concurrent account change aborts
the save instead of overwriting it.

`GET /v1/auth/config` exposes Firebase's public web configuration, enabled
providers (`google`, `apple`, `github`) and `canLinkExisting`, without signer keys.
`GET /auth` and `/auth.js` serve the browser handoff. Providers need their own
Firebase console configuration before being advertised. The current deployment
enables anonymous, Google, Apple and GitHub. Linking and independent recovery
have been verified live for all three external providers with the same UID and
existing paired device. Firebase manages standard authentication attributes;
application records authorize by UID without copying email/profile attributes.

`POST /v1/auth/link-token` requires agent authentication, accepts an empty object
only and is limited to ten attempts per UID per minute. It issues a five-minute
Firebase custom token for the verified caller's UID; callers cannot choose a UID.
Device credentials cannot use it. Optional `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`
is an API-only signer, validated against `FIREBASE_PROJECT_ID`. Without it, new
external sign-ins still work but linking an existing anonymous account is disabled.
Signing and provider interactions occur outside database transactions.

The CLI binds a one-use `127.0.0.1` callback with a random port and state, then opens
the HTTPS auth page. Handoff fields travel in a fragment which the page clears
before configuration/provider requests. A separate in-memory Firebase session
prevents adopting another browser tab's account. Link checks the UID before and
after the provider popup. A form POST returns credentials to the loopback listener;
credentials never travel in a URL. The listener checks exact cloud Origin, loopback
Host, path, state, project, expected UID and linked provider. It bounds body size,
verification time and total login time. Cancellation, timeout, rejected accounts
and network failures preserve the original credential file.

## Hosted MCP endpoint

`/v1/mcp` serves the stdio server's six tools over Streamable HTTP. It is
stateless: POST only, no session ID, no server-initiated stream (GET and DELETE
return 405), and `resources/subscribe` is not offered. Any replica can answer
any request. `wait_seconds` is capped at 300; the reply stream carries keep-alive
comments while a tool waits. A client disconnect ends the wait, not the request.

The API is also the OAuth 2.1 authorization server for this one resource. It is
enabled only when the Firebase web configuration is present.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource[/v1/mcp]` | RFC 9728 metadata; `resource` is `<origin>/v1/mcp` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST /oauth/register` | RFC 7591 registration of public clients (no secret) |
| `GET /oauth/authorize` | Consent page; `POST` records the decision from that page |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | RFC 7009; either token withdraws the whole approval |
| `GET /oauth/connections` | Human-facing page to inspect and withdraw MCP approvals |
| `GET /oauth/grants`, `DELETE /oauth/grants/{id}` | Authenticated approval list and owner-scoped revocation from that page |
| `GET /pair` | Sign in and pair a phone without an MCP client |
| `GET /v1/input-restriction`, `POST /v1/input-restriction` | The signed-in owner's FREE plan input restriction and its acceptance (see below) |

An unauthenticated `/v1/mcp` request gets 401 with
`WWW-Authenticate: Bearer resource_metadata="..."`. Issuer and resource are the
origin the client used (`PUBLIC_URL` when the host matches; always HTTPS except on
loopback). PKCE with S256 is mandatory. Redirect URIs must be registered and match
exactly, except that an HTTP loopback redirect may use any port. Allowed targets
are HTTPS, HTTP on loopback and app-specific schemes other than `oyobidashi:`; an unknown client or a
mismatched redirect is shown as an error page and never redirected. A `resource`
parameter must name this endpoint. Authorization responses carry `iss`.

The consent page signs the human in with Google, Apple or GitHub in an in-memory
Firebase session and posts the decision with that ID token. The server verifies
the token and the page's `Origin`, and accepts only a direct Google, Apple or
GitHub sign-in for ordinary accounts. On the official host, an optional
`MCP_REVIEW_FIREBASE` configuration accepts a password-authenticated session
from a separate Firebase project with one allowlisted UID. The reviewer
session is mapped to a dedicated owner and can only approve or manage MCP
connections, accept input restrictions, read presence, and prepare device
pairing. The ordinary API verifier continues to trust the primary Firebase
project. Removing the review configuration disables exchange and use of its
MCP grants. Anonymous and custom-token sessions cannot approve an MCP client.
An owner under the FREE plan input restriction first sees that
restriction on its own screen and accepts it with a dedicated button; approval
is refused with 409 `input_consent_required` until then. The page displays a
separate, explicit approval button after sign-in;
the registered client name is marked as unverified. An account
without an external identity could not be recovered once the client lost its
tokens. If the account has no paired phone, the page obtains a pairing code
and waits for the device before returning to the client. On a computer it shows
the code as a QR code. The app's "Oyobidashiクラウドに接続" button opens
`/pair?from=app&state=<one-time value>`; there the page leads with a link that
opens the app with the same `oyobidashi://pair` URL plus that `state`. The app
pairs from a link only when the link returns the `state` it issued for the same
server within 30 minutes, once: anyone can open an `oyobidashi://pair` link on
somebody else's phone, and a code alone does not say whose account it belongs
to. In a phone browser that the app did not open, the page shows no such link
and tells the human to start from the app. QR scanning and manual entry start
inside the app and need no `state`.
Signing in with an identity already linked through the stdio flow yields the same
UID and therefore the same paired devices.

Codes (`kmo_`, five minutes), access tokens (`kma_`, one hour) and refresh tokens
(`kmr_`, 180 days idle) are opaque, random and stored as SHA-256 digests in
`cloud_oauth`. Codes are single use; replaying one revokes the tokens it
produced. Refresh tokens rotate on every use; replay revokes the entire
approval. Removing the last paired phone also revokes all of that owner's MCP
approvals. A user keeps
at most 30 approvals, newest first. Client registrations lapse after 400 days
without a token being issued.

These tokens are accepted by `/v1/mcp` only. Firebase ID tokens and device tokens
are not accepted there. Tool calls run in-process as the token's owner with the
agent role and the same quotas as the REST API, but can never issue pairing codes
or account-link tokens or open the device event stream. The asking agent shown on
the phone is the registered `client_name`; no working directory is recorded.

Unauthenticated endpoints are bounded: registration is capped per redirect host per hour
and by concurrency, approvals are limited to 20 per user per minute, bodies to
64KB. OAuth endpoints and `/v1/mcp` send `Access-Control-Allow-Origin: *`; no
cookie or ambient credential exists, so cross-origin reads expose nothing.

## Asynchronous voice turns

Clients submit `POST /v1/requests/{id}/call` with
`{event:"turn", text, turn_id:<UUID>, async:true}`. The UUID is generated once per
utterance and reused after transport failures. The cloud server commits the turn
and a durable job in one transaction and returns HTTP 202 immediately. The LAN
relay may still return HTTP 200 with the completed result.

A cloud response is `{request, call, turn, reply?, resolved?}`. `call.turn` also
contains the latest turn so a reconnect can recover it. A turn is
`{id, state:queued|running|completed|failed|cancelled, reply:string|null,
resolved:boolean, error:{code,message}|null}`. Existing call fields are unchanged.
Repeating the same ID and text returns that turn; different text using that ID is
409 `idempotency_conflict`. A different ID while a turn is pending returns 409
`turn_in_progress`. No second user transcript entry is appended on retry.

`GET /v1/requests/{id}/turns/{turn_id}` (owning device auth) returns HTTP 200 with
the same envelope. It remains readable after the request is answered. Poll until
completed/failed/cancelled, using bounded backoff (250ms to 2s), an overall deadline
and caller cancellation. A disconnect only stops polling; it does not cancel the
committed job. Retry a lost POST response with the same ID. Failed/cancelled turns
must never be treated as successful answers. The user can retry a failed utterance
explicitly with a new ID or switch to text. Keep transcription/drafts on transport
failure. Do not start another recognition cycle or end a resolved call before
speaking the final reply. Existing in-flight voice guards also cover the polling
period, so WebSocket resolution cannot cut off the last spoken reply.

## Durability and ordering

There is at most one live call per UID, one pending turn per call and one claimant
device per call. No database lock or worker slot is held while the human is silent.
Workers lease short jobs with fencing tokens. Only the current lease may commit
results. Hangup, cancellation, expiration and text answers invalidate pending
turns; late model responses cannot change terminal requests. Worker crashes allow
lease recovery. Model retries are bounded by attempts and a wall-clock deadline.
External model invocation and push delivery may repeat after a crash; database
state changes are idempotent. Exactly-once external effects are not promised.

PostgreSQL owns state and durable jobs, including push jobs committed with request
changes. Redis messages are hints; loss must not lose work. Gateways periodically
reconcile connected devices from PostgreSQL, send a fresh hello on reconnection,
and close revoked sockets. Slow sockets are disconnected and recover by snapshot.
Client disconnects and gateway shutdown do not terminate durable calls or jobs.

## Cloud voice device proof and automatic account suspension

Self-hosted cloud `answer` and `turn` events use the paired device bearer token.
When `PUBLIC_URL=https://api.oyobidashi.me` or `VOICE_REQUIRE_DEVICE_PROOF=1`,
these events also require `X-Oyobidashi-Voice-Token`, which is opaque, bound
to the device, and expires after ten minutes. In these deployments the API and
worker enforce the proof and the platform needs matching proof configuration.
The voice proof endpoints return 404 when proof is disabled, as on the LAN relay.

`GET /v1/voice` returns `enabled`, `supported`, `platform`, `uid`, `device_id`,
and `token_ttl_seconds`. The device calls `POST /v1/voice/challenge` with
`{"purpose":"apple_enroll"|"android_enroll"|"token"}`. Each random challenge
is bound to the device and purpose, single use, and valid for five minutes.

For iOS, the app makes a separate App Attest key. It attests SHA-256 of UTF-8
`voice-enroll\n<uid>\n<device_id>\n<challenge>` and sends `challenge`,
`key_id`, `attestation` (base64) to `POST /v1/voice/apple/attest`. For Android,
the app creates an EC P-256 signing key in Android Keystore, hashes its SPKI
DER bytes with SHA-256, and encodes the result as base64url `key_id`. The Play
Integrity standard request uses SHA-256/base64url of UTF-8
`voice-enroll\n<uid>\n<device_id>\n<challenge>\n<key_id>` as `requestHash`.
It sends `challenge`, `public_key` (base64 SPKI DER), and `integrity_token` to
`POST /v1/voice/android/enroll`. The server checks the Play-recognized package,
device integrity, freshness, and request hash. Android enrollment must be
renewed every six hours. The server currently checks the Play Integrity verdict
and the bound key's signature; it does not verify a hardware key-attestation
certificate chain.

For a short token renewal, both platforms sign `voice-token\n<uid>\n<device_id>\n<challenge>`.
iOS supplies an App Attest assertion over the SHA-256 digest; Android supplies
an ECDSA SHA-256 signature (base64 DER). `POST /v1/voice/token` receives
`challenge`, `key_id`, `signature` and returns `access_token`, `expires_at`,
`expires_in:600`. The server checks the iOS assertion counter or Android
signature and hashes the issued token at rest. Re-enrollment invalidates any
previous token. Normal API calls do not invoke App Attest or Play Integrity.

Each Firebase UID can submit up to 30 accepted voice turns in any rolling
60-minute period, across calls and devices. Replaying an accepted turn ID
returns its result without consuming another turn. While the budget is full,
new requests that would ring are delivered as text. If a new turn reaches an
already active call after the budget is exhausted, the server ends that call
and returns 409 `call_ended`. The request stays pending for a text reply.
New requests can ring again once a turn falls out of the window.

The server suspends the entire Firebase UID with no expiry and no user-facing
unban endpoint when it sees 30 distinct voice turn IDs in one minute or three
turns longer than 2000 Unicode characters across five minute buckets. Replaying
the same accepted turn ID does not count. Banned users receive 403
`account_banned`; queued model and push jobs are skipped. A newly created
Firebase UID is a different account and is outside this account-level ban.

## Subscription, attestation and the voice model

Only the official HTTPS API at `https://api.oyobidashi.me` accepts purchases,
restores, purchase sync and store notifications. Apps skip billing entirely
for other endpoints and refuse redirects on billing requests. The cloud API
serves `{"enabled":false}` from `GET /v1/billing` on other hosts and when the
stores are unconfigured, with 404 for the other billing routes. The LAN relay
has no billing routes. Self-hosted cloud uses its configured standard model
for everyone.

A subscription belongs to the owner UID. The official worker picks the
voice model per turn: an owner with an active subscription gets the standard
model, everyone else gets `VOICE_MODEL_FREE` when it is set. A failure of one
model never falls back to the other. Model names are deployment configuration
and are never returned by any API, tool result, error or log.

`GET /v1/billing` (device auth) returns

```json
{"enabled":true,"active":false,"expires_at":null,"active_stores":[],
 "voice_training":{"free":true,"plus":false},
 "purchase_account_id":"98765432-1234-5678-9abc-123456789abc",
 "apple":{"product_ids":["..."]},"google":{"product_ids":["..."]}}
```

`apple` / `google` are present only when that store is configured. `expires_at`
is ISO 8601 or null. `active_stores` lists the stores ("apple" and/or "google")
with current access for this owner. Clients use it to show the correct
subscription management instructions. Devices use `active` only for display;
the server decides.

An operator can grant PLUS to listed UIDs without a purchase (`PLUS_GRANT_UIDS`).
Such an owner gets `"active":true` with `"expires_at":null`; `active_stores`
still lists only real store subscriptions, so it may be empty.

`voice_training` declares the configured training terms of the model used for
each plan. `true` means conversations may be used for training, `false`
means no training use, and `null` or a missing value means unknown. Both plans
use the standard model's terms when they share a model.

`purchase_account_id` is a stable, opaque UUID for this UID. New purchases
use it as the StoreKit `appAccountToken` or Play Billing
`obfuscatedAccountId`. The server checks the value returned by the store
against the authenticated UID. It grants no API access.

Every state-changing billing call is device-authenticated, attested and bound to
a single-use challenge. `POST /v1/billing/challenge` with `{}` returns
`{"challenge":"<base64url, 32 random bytes>","expires_at":"..."}`. A challenge
is valid for five minutes, for the device that requested it, once.

In the calls below `payload` is a JSON document serialized to a string by the
client. The server hashes exactly the UTF-8 bytes of that string, so the client
must sign the same string it sends and must not re-serialize it.

iOS (App Attest):

- `POST /v1/billing/apple/attest` `{"key_id","attestation","challenge"}`.
  `key_id` is the base64 key identifier from `DCAppAttestService.generateKey`,
  `attestation` the base64 attestation object for
  `clientDataHash = SHA256(UTF-8 of challenge)`. The server validates the
  certificate chain to the Apple App Attestation root, the nonce, the App ID
  (`<team>.<bundle>`), the environment and the key identifier, then stores the
  public key and counter with the device. 204 on success. A device keeps one key;
  attesting again replaces it.
- `POST /v1/billing/apple` `{"key_id","assertion","payload"}` where `payload` is
  `{"challenge":"...","transactions":["<JWS>", ...]}` (at most 20) and `assertion`
  is the base64 result of `generateAssertion(keyId, clientDataHash:
  SHA256(UTF-8 of payload))`. The assertion counter must increase. Each JWS is a
  StoreKit 2 `jwsRepresentation`; the server verifies its chain to Apple Root CA
  G3, the bundle ID, the product ID and the environment, and ignores anything
  else. 409 `attestation_required` means the device must attest (again) first.

Android (Play Integrity, standard request):

- `POST /v1/billing/google` `{"integrity_token","payload"}` where `payload` is
  `{"challenge":"...","purchases":[{"product_id","purchase_token"}, ...]}` (at
  most 20) and `integrity_token` was requested with
  `requestHash = base64url(SHA256(UTF-8 of payload))` without padding. The server
  decodes the token with Google, requires the configured package name,
  `PLAY_RECOGNIZED` and `MEETS_DEVICE_INTEGRITY`, then verifies each purchase
  token with the Play Developer API and acknowledges it.

Both sync calls return the same body as `GET /v1/billing`. An empty list is
valid and changes nothing: a subscription ends only through its expiry or a
store revocation, never because a device stopped reporting it. Clients sync at
launch, after a purchase and on store updates, not only after buying, because a
subscription can arrive without a purchase on that device (restore, family
sharing, or a seat assigned by an organization).

Each purchase keeps its recorded UID across restores, device changes, expiry
and refunds. A purchase without a store account identifier, such as an older
or out-of-app purchase, uses the existing registration or is bound to the
first UID that presents a valid, active purchase. Restore does not transfer a
purchase to another UID. To recover access on a new device, sign in to the same
Oyobidashi account before restoring.

For Apple, `FAMILY_SHARED` and `ASSIGNED`
(a seat bought by an organization through Apple Business or Apple School
Manager) have no purchaser on the device and no `appAccountToken`. Each
beneficiary must have a signed `appTransactionId`; the same signed beneficiary
transaction is bound to one UID, while different signed
beneficiaries may hold separate seats under the same original transaction.
Updates are ordered by signed date and effective period so a saved transaction
cannot undo a later refund or shorten a renewal. A transaction with `revocationDate`, including `revocationType`
`ASSIGNMENT_REVOKE`, ends access for its owner immediately. A Google purchase
that replaces an earlier purchase inherits the recorded UID of the earlier
purchase and supersedes its access in the same database transaction. A Play
purchase is acknowledged after its owner and active access are confirmed.

Store notifications keep the state current without a device:
`POST /v1/billing/webhooks/apple` takes App Store Server Notifications V2 and
trusts only the verified `signedPayload`; `POST /v1/billing/webhooks/google`
takes a Pub/Sub push whose OIDC bearer token must carry the configured audience
and service account. Both `subscriptionNotification` and a subscription's
`voidedPurchaseNotification` trigger a purchase lookup from Google. If a refund
leaves the subscription valid, access continues until the returned expiry.
When Google reports that the subscription has ended, its access ends on sync.
Unknown transactions are acknowledged and ignored. Webhooks are idempotent
and unauthenticated bodies are bounded to 64KB. At most 16 webhook
signature verifications run at once; excess requests get 429 and the store
retries. A grace period in Apple renewal info extends only the subscription
whose original transaction ID, environment and product it names. A Google Play
test purchase (`testPurchase`) never grants access and is never acknowledged.

### FREE plan input restriction

The FREE voice model of the hosted service accepts no personal or confidential
input. That restriction applies to exactly one combination:

| Deployment | Plan | Restricted |
|---|---|---|
| Hosted, separate FREE model (`VOICE_MODEL_FREE`, `VOICE_FREE_TRAINING` not `0`) | FREE | yes |
| Hosted | PLUS | no |
| Self-hosted cloud or LAN relay (own model) | any | no |

Everything below happens only for a restricted owner. Nobody else is asked,
warned or limited, and no API response changes for them.

1. **Linking an agent.** The owner accepts the restriction once, in the browser,
   before the agent is linked: on the OAuth consent page for `/v1/mcp`, or in
   the stdio login command (`bun run --cwd mcp login:cloud`), which requires
   typing `同意します` or `agree`. `GET /v1/input-restriction` returns
   `{"restricted":true,"accepted":false,"version":1}`; `POST` with
   `{"accept":true,"version":1}` records the acceptance for the owner UID. Both
   need the owner's own sign-in: a paired phone gets 403 and a hosted MCP call
   cannot reach the route. A changed `version` needs a new acceptance. The
   acceptance survives plan changes and is erased with the account.
2. **What the agent is told.** `/v1/mcp` resolves the owner's plan on every
   request and, when restricted, appends the restriction to the server
   `instructions` and to the descriptions of `ask_human` and `notify_human`.
   The agent view of `GET /v1/presence` and the `delivery` object of
   `POST /v1/requests` carry `"input_restricted":true`; MCP surfaces it as a
   `privacy_notice` string in tool results, which also covers the stdio bridge
   and a plan that changes during a session.
3. **During a call.** Nothing is asked. A phone answers and the question is
   read out at once; a turn carries no consent field. The model is chosen per
   turn from the owner's plan.
4. **A missing acceptance.** An owner can become restricted without having
   accepted: the subscription lapsed, or the agent was linked earlier. Their
   voice content must not reach the FREE model, so a requested call is delivered
   as text, a ringing or active call ends with `call_ended` and falls back to
   text, and a queued turn is not sent to the model. Agents see
   `"input_consent_required":true` next to `input_restricted`, which MCP turns
   into a `warning` naming `/oauth/connections` (hosted) or the login command
   (stdio). Text, choice and notification delivery are unaffected: they never
   reach a model.

Model names stay deployment configuration and are never returned.

## Push routing and previews

Cloud Push includes `recipient_device_id`. Native clients must reject a present
recipient that differs from the current pairing; absent fields retain LAN
compatibility. Push destinations have one global owner. A superseded pairing
cannot reclaim its destination through an old in-flight registration.

The optional `push_client_id` additionally owns the installation's pairing globally,
scoped by platform. Re-pairing that identity displaces the previous device even if
both APNs/FCM and VoIP tokens have changed, including across accounts. An old
device cannot reclaim it through an in-flight registration. The identifier grants
no API access and is never included in public device objects or push payloads.
Changing an already bound identity within a pairing is rejected.
The 32-device capacity limit is enforced when consuming the pairing code, allowing
the same phone to replace its old pairing even when all slots are occupied.

Each token's client registration expires after 30 days, independently for ordinary
push and VoIP. Only an explicit registration of that token renews its timestamp;
provider success and `lastSeen` updates do not. Both job creation and execution
prune expired destinations, so queued jobs cannot bypass expiry. Legacy records
are initialized once from their historical `lastSeen`; migration is repeatable
without renewing them. Pairing credentials remain usable for re-registration.
This also bounds delivery attempts for pre-upgrade or unidentifiable abandoned
installations whose provider continues accepting sends.

Remote Push contains generic text, without the question/context/choices. New VoIP
call pushes also carry the optional short `subject` for immediate display in the
system caller name; ordinary pushes and cancellation pushes omit it. Agent details
remain generic until the authenticated app refreshes the request. Optional
`preview_url` and `preview_token` allow the notification extension to retrieve the
current content and choices without sharing account credentials. The URL is the
configured HTTPS origin plus `/v1/previews/{request_id}`; the opaque `kp_` token
is sent ONLY in the Authorization header. The token is stored hashed, bound to
one request/device/destination, valid for five minutes, and denied if pairing or
destination ownership changed. It cannot authorize other APIs. Clients prohibit
redirects, cap the response at 128KB and bound the entire exchange to three
seconds. On failure they keep a generic notification that opens the authenticated
app. Preview secrets must be removed before storing a delivered notification.

Errors use the existing `{error:{code,message}}` envelope. Invalid credentials are
401, role violations 403, cross-user/unknown IDs 404, state conflicts 409, bounded
overload 429, and temporary infrastructure failure 503. Internal details, tokens,
transcripts and raw provider errors are never returned or logged.

### iOS のアカウント削除

- 公式クラウドに接続した iOS の設定から、削除対象と定期購入の管理リンクを確認して、端末にパスコードが設定されている場合は Face ID やパスコードで本人確認する。`POST /v1/account/deletion` は iOS の端末トークンから対象 UID を決める。端末トークンを持つ利用停止中のアカウントも削除できる。
- Apple でサインインを連携したアカウントでは、10 分間有効なチケットを返す。`/account/delete` で再認証し、同じ UID に対する最近の Apple サインインを確認したうえで、Apple の認可を取り消す。Firebase Authentication からユーザーを削除し、質問と回答、ジョブ、端末、連携トークンを消去する。途中で一時障害が起きた場合は、アプリの設定から再試行できる。
- 購入取引の照合情報は、別 UID での再利用を防ぐために保持する。削除した UID はハッシュで照合し、発行済みの認証情報で再利用されるのを防ぐ。ストア側での定期購入の解約は別途行う。
- 通話中に同意を求めることはない。応答した直後に質問の読み上げから始める。同意は2種類あり、どちらも事前に1回だけ行う。
  - **AIへの送信（全プラン・全接続先）**: `GET /healthz` の `voice_ai.provider` が音声会話の送信先を示す。iOS はペアリングの直前に送信先と送る内容を画面に出し、同意を受け取ってからペアリングする。同意は端末に保存し、ペアリング解除で消す。この版より前にペアリングした端末と、送信先が変わった接続先では、アプリを開いたときに1回だけ確認する。同意のない端末は発話を送らず、通話は文字での返信に切り替わる。
  - **FREEプランの入力制限（公式クラウドのFREEのみ）**: エージェントの連携時にブラウザまたはログインコマンドで行う（「FREE plan input restriction」を参照）。
