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
| `GET /pair` | Sign in and pair a phone without an MCP client |

An unauthenticated `/v1/mcp` request gets 401 with
`WWW-Authenticate: Bearer resource_metadata="..."`. Issuer and resource are the
origin the client used (`PUBLIC_URL` when the host matches; always HTTPS except on
loopback). PKCE with S256 is mandatory. Redirect URIs must be registered and match
exactly, except that an HTTP loopback redirect may use any port. Allowed targets
are HTTPS, HTTP on loopback and app-specific schemes; an unknown client or a
mismatched redirect is shown as an error page and never redirected. A `resource`
parameter must name this endpoint. Authorization responses carry `iss`.

The consent page signs the human in with Google, Apple or GitHub in an in-memory
Firebase session and posts the decision with that ID token. The server verifies
the token and the page's `Origin`, and refuses anonymous sign-ins: an account
without an external identity could not be recovered once the client lost its
tokens. If the account has no paired phone, the page obtains a pairing code,
shows it as a QR code and waits for the device before returning to the client.
Signing in with an identity already linked through the stdio flow yields the same
UID and therefore the same paired devices.

Codes (`kmo_`, five minutes), access tokens (`kma_`, one hour) and refresh tokens
(`kmr_`, 180 days idle) are opaque, random and stored as SHA-256 digests in
`cloud_oauth`. Codes are single use; replaying one revokes the tokens it
produced. Refresh tokens rotate on every use. A repeat within 60 seconds is
honoured as a retried request; a later repeat revokes the approval. A user keeps
at most 30 approvals, newest first. Client registrations lapse after 400 days
without a token being issued.

These tokens are accepted by `/v1/mcp` only. Firebase ID tokens and device tokens
are not accepted there. Tool calls run in-process as the token's owner with the
agent role and the same quotas as the REST API, but can never issue pairing codes
or account-link tokens or open the device event stream. The asking agent shown on
the phone is the registered `client_name`; no working directory is recorded.

Unauthenticated endpoints are bounded: registration is capped globally per hour
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
