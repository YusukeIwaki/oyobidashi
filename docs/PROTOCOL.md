# oyobidashi 通信仕様 (v1 / アプリv0.2)

エージェント (Claude Code / Codex) が人間 (お呼び出し) のスマホを鳴らして質問し、テキスト/音声の回答を受け取るための仕組み。
この文書と [v0.2拡張](EXTENSIONS.md) が **全コンポーネント共通の契約** であり、`docs/fixtures/*.json` がその具体例 (各コンポーネントのテストで読み込んで検証する)。

> v0.2では優先度・在席・通話・通知取り消し・任意のHTTPSプロキシを追加しています。以下の旧来の挙動と相違する部分は [EXTENSIONS.md](EXTENSIONS.md) を優先してください。

> クラウド版のユーザー認証・非同期音声・障害復旧契約は [CLOUD_PROTOCOL.md](CLOUD_PROTOCOL.md) を参照してください。LAN版の認証・接続制限は維持します。

## 1. 構成

```
Claude Code / Codex
   │ stdio (MCP)
   ▼
mcp/      … MCPサーバー (Bun, stdio)。薄いクライアント。状態を持たない
   │ HTTP (127.0.0.1, agent token)
   ▼
relay/    … 中継サーバー (Bun, macOS常駐)。状態(SQLite)・ペアリング・Push送信・WebSocket配信
   │ HTTP (同一LAN内・プライベートIP, device token)  │ APNs / FCM
   ▼                                              ▼
ios/ , android/ … アプリ。通知を鳴らし、テキスト/音声/選択肢で回答
```

| ディレクトリ | 技術 | 役割 |
|---|---|---|
| `relay/` | Bun (`Bun.serve`, `bun:sqlite`) | REST + WebSocket + Push送信 + CLI |
| `mcp/` | Bun + `@modelcontextprotocol/sdk` | stdio MCPサーバー |
| `ios/` | Swift / SwiftUI, iOS 17+ | アプリ + `OyobidashiKit` (SwiftPM, ロジック) |
| `android/` | Kotlin / Jetpack Compose, minSdk 26 | アプリ |

アプリID: iOS Bundle ID `me.oyobidashi.ios` / Android applicationId・Kotlin package `me.oyobidashi.android`

## 2. 共通ルール

- ベースパス `/v1`。ボディは `application/json; charset=utf-8`。
- 時刻は ISO 8601 UTC ミリ秒 (`2026-11-15T14:00:00.000Z`)。
- ID・トークンは不透明な文字列として扱う (`req_…`, `dev_…`, agent token `ka_…`, device token `kd_…`)。
- 認証は `Authorization: Bearer <token>`。トークンをURLクエリに載せない。
- JSONの未知フィールドは無視する (前方互換)。`null` とフィールド欠落は同義に扱う。
- エラーは必ず次の形:

```json
{ "error": { "code": "already_resolved", "message": "request is already answered" } }
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `invalid_request` | バリデーションエラー・不正JSON |
| 401 | `unauthorized` | トークンなし/不正/失効 |
| 401 | `pairing_code_invalid` | ペアリングコードが不正・期限切れ・使用済み |
| 403 | `forbidden` | ロール違い (deviceがagent用APIを叩いた等)、ループバック以外からのagent API、プライベートアドレス以外からの接続 |
| 404 | `not_found` | |
| 409 | `already_resolved` | pending でない request への answer / cancel |
| 413 | `payload_too_large` | ボディ 64KB 超 |
| 429 | `rate_limited` | ペアリング試行過多 |
| 500 | `internal` | |

## 3. Request オブジェクト

```json
{
  "id": "req_01JCXYZ",
  "kind": "question",
  "question": "本番DBのマイグレーションを実行してよいですか?",
  "subject": "本番DBの変更承認",
  "context": "users テーブルに列を追加します",
  "choices": ["はい", "いいえ"],
  "urgency": "normal",
  "status": "pending",
  "answer": null,
  "agent": { "name": "claude-code", "cwd": "/path/to/project" },
  "created_at": "2026-11-15T14:00:00.000Z",
  "updated_at": "2026-11-15T14:00:00.000Z",
  "expires_at": "2026-11-15T15:00:00.000Z"
}
```

- `kind`: `question` | `notification` (一方向。作成時点で `status: "notified"`、回答不可)
- `subject`: 任意の短い用件 (40文字以内)。前後の空白を除去し、改行・連続する空白は半角スペースにまとめる。欠落・null・空白だけの場合は用件なし。iPhoneの着信では発信者名に添え、Androidの着信画面では質問本文の上に表示する。
- `urgency`: `normal` | `high`
- `status`: `pending` → `answered` | `cancelled` | `expired` (終端)。`notified` は notification 専用の終端。
- `answer` (answered のときのみ非null):

```json
{ "text": "はい", "choice_index": 0, "input_method": "choice", "device_id": "dev_01", "answered_at": "2026-11-15T14:01:00.000Z" }
```

  - `input_method`: `text` | `voice` | `choice`。`choice_index` は choice のときのみ (それ以外 null)。
- 制限: `question` 1〜4000文字 (必須)、`context` ≤8000、`choices` ≤8個・各1〜200文字、`answer.text` 1〜10000文字、`agent.name` ≤100、`agent.cwd` ≤1000。
- `expires_in_seconds`: 既定 3600、範囲 10〜86400。期限を過ぎた pending は `expired` になる (参照時または定期掃除で遷移し、イベントも配信)。

## 4. Agent API (mcp → relay)

agent token 必須。**接続元がループバック (127.0.0.0/8, ::1) でないリクエスト、および `X-Forwarded-For` / `X-Forwarded-Host` ヘッダーが付いたリクエストは 403 `forbidden`** (agent API は同一マシンからのみ)。

### POST /v1/requests → 201
```json
{ "kind": "question", "question": "...", "subject": "変更の承認", "context": null, "choices": null, "urgency": "normal",
  "expires_in_seconds": 3600, "agent": { "name": "claude-code", "cwd": "/x" } }
```
`kind` 省略時は `question`。レスポンス:
```json
{ "request": { /* Request */ },
  "delivery": { "paired_devices": 1, "websocket_delivered": 0, "push_attempted": 1 } }
```
`paired_devices: 0` でも作成は成功する (mcp 側が警告を出す)。Push送信は非同期で、失敗しても作成は成功。

### GET /v1/requests/{id}?wait=N → 200 `{ "request": {...} }`
`wait` (秒, 0〜300, 既定0)。pending の間だけ最大 N 秒ブロックし、状態が変わった瞬間または時間切れで現在の状態を返す (時間切れでも 200)。

### POST /v1/requests/{id}/cancel → 200 `{ "request": {...} }`
pending 以外は 409 `already_resolved`。

## 5. Device API (アプリ → relay)

**インターネットには公開しない。** アプリは同一LAN内からプライベートIP宛ての平文 HTTP / WS で接続する。
relay は `/healthz` を含む全エンドポイントで、接続元がプライベートアドレス (ループバック, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, IPv6 の ::1 / fc00::/7 / fe80::/10, およびそれらの IPv4-mapped 表現) でないリクエストを 403 `forbidden` で拒否する。
`X-Forwarded-For` / `X-Forwarded-Host` 付きのリクエストも (プロキシ・トンネル経由とみなし) 全エンドポイントで 403。

### POST /v1/pair (認証不要) → 201
```json
{ "code": "<pairing code>", "device_name": "iPhone 16", "platform": "ios",
  "push_token": "abcdef…", "push_environment": "development" }
```
- `platform`: `ios` | `android`。`push_token` は省略可 (あとで PUT)。`push_environment` は iOS のみ `development` | `production` (既定 `production`)。
- `push_client_id` は任意の不透明なアプリ・端末識別子 (英数字・`_`・`-`、32〜128文字)。Pushトークンが再インストールで変わっても、同じplatform・識別子の旧ペアリングを失効させ、通常Push・VoIP双方の旧送信先を止める。認証資格情報としては使わず、公開レスポンスやPushに含めない。未対応クライアントは省略可能。
- コードは1回限り・発行から10分有効。失敗は 401 `pairing_code_invalid`。同一IPから1分に10回を超える失敗で 429。
```json
{ "device": { "id": "dev_01", "name": "iPhone 16", "platform": "ios", "created_at": "..." },
  "device_token": "kd_..." }
```

### PUT /v1/devices/me → 200 `{ "device": {...} }`
`{ "push_token": "...", "push_environment": "development", "device_name": "..." }` (すべて任意、指定分のみ更新。`push_token: null` で解除)

`push_client_id` は既存ペアリングへの初回登録にも使える。一度登録した値の変更は400。新しい識別子を使う場合は新規ペアリングする。同じトークンを再登録しても、その送信先の有効期限を更新する。

### DELETE /v1/devices/me → 204
ペアリング解除。以後その device token は 401。

### GET /v1/requests?status=pending&limit=50 → 200 `{ "requests": [ ... ] }`
`status` 省略時は全件。`created_at` 降順。`limit` 1〜200 (既定 50)。

### GET /v1/requests/{id} → 200 `{ "request": {...} }`
(device token の場合 `wait` は無視)

### POST /v1/requests/{id}/answer → 200 `{ "request": {...} }`
```json
{ "text": "はい", "choice_index": 0, "input_method": "choice" }
```
- pending 以外は 409 `already_resolved`、notification は 409 `already_resolved`。
- `choice_index` を指定する場合は範囲内であること (範囲外は 400)。`text` は必須。
- 2台が同時に回答した場合、先着のみ成功。

### GET /v1/events (WebSocket)
`Authorization: Bearer <device token>` ヘッダーで認証。不正なら upgrade せず 401。
サーバー→クライアント (テキストフレーム, JSON):
```json
{ "type": "hello", "pending": [ /* Request[] */ ] }
{ "type": "request.created", "request": { ... } }
{ "type": "request.updated", "request": { ... } }
{ "type": "pong" }
```
クライアント→サーバー: `{ "type": "ping" }` のみ (それ以外は無視)。サーバーは30秒ごとにWebSocket pingフレームを送る。
`request.created` は question / notification の両方で送る。`request.updated` は answered / cancelled / expired への遷移時。

### GET /healthz (認証不要) → 200

`{ "ok": true, "version": "0.2.0", "voice_ai": { "provider": "claude-code" } }`

`voice_ai.provider` は音声会話の送信先です（LAN版は `claude-code`、クラウド版は `anthropic` または `meta`）。iOS はペアリングの直前にこれを読み、話した内容がその第三者AIへ送られることを画面に出して、同意を受け取ってからペアリングします。同意は端末に保存し、ペアリング解除で消します。通話中には何も尋ねません。応答すると質問の読み上げから始まります。未知の値や欠落の場合、iOS は送信先の名前を出さずに同じ説明をします。

LAN版は利用者自身が用意したモデルを使うため、旧構成の公式クラウドでFREEプランを対象にした入力制限はありません。入力制限は `docs/CLOUD_PROTOCOL.md` を参照してください。

## 6. Push 通知

送信先は、端末がペアリングまたは`PUT /v1/devices/me`で該当トークンを登録してから30日間有効。通常PushとVoIPは独立して期限を持つ。期限に達した送信先は送信前に除外・削除し、APNs/FCMの成功、他のAPIへのアクセス、片方だけのトークン更新では延長しない。ペアリング自体は残し、端末による再登録で再開できる。既存DBの期限は移行前の最終接続時刻 (なければ作成時刻) から数え、サーバー再起動では更新しない。

端末は起動・フォアグラウンド復帰・トークン変更時に再登録する (iOSの同一トークンの再登録は24時間間隔)。iOSは資格情報とは別のKeychain項目にランダムな`push_client_id`を保持する。Android 8+は署名鍵・OSユーザー・端末にスコープされた`ANDROID_ID`をアプリ固有の名前空間でSHA-256化し、生のOS識別子を送信しない。同じ署名での再インストールでは維持される ([Android公式](https://developer.android.com/about/versions/oreo/android-8.0-changes))。OSの初期化や識別子の喪失で旧登録を特定できない場合も30日で停止する。旧版から識別子を登録する前に削除されたアプリも同じ期限で扱う。

relay は `~/.oyobidashi/config.json` に資格情報があるときだけ Push を送る。無ければ WebSocket 配信のみ (アプリ起動中だけ届く)。
通知本文: `title` = `agent.name` があれば `"<name> からの質問"` (notification は `"<name> からのお知らせ"`)、無ければ `"エージェントからの質問"` / `"エージェントからのお知らせ"`。`body` = `question` の先頭 1000 文字。

### APNs (iOS) — `docs/fixtures/apns_payload.json`
```json
{ "aps": { "alert": { "title": "claude-code からの質問", "body": "..." }, "sound": "default",
           "interruption-level": "time-sensitive", "category": "OYOBIDASHI_QUESTION", "thread-id": "oyobidashi" },
  "request_id": "req_01JCXYZ", "kind": "question" }
```
- notification は `category: "OYOBIDASHI_NOTIFICATION"`、`interruption-level: "active"`。`urgency: high` でも question は time-sensitive のまま。
- ヘッダー: `apns-push-type: alert`, `apns-topic: <bundle id>`, `apns-priority: 10`, `apns-collapse-id: <request id>`。
- 410 または `BadDeviceToken` / `Unregistered` を受けたらそのデバイスの push_token を消す。

### FCM (Android) — `docs/fixtures/fcm_data.json`
HTTP v1 の **data メッセージのみ** (`android.priority: "high"`)。通知はアプリ側で組み立てる (RemoteInput を付けるため)。data の値はすべて文字列:
```json
{ "request_id": "req_01JCXYZ", "kind": "question", "title": "claude-code からの質問", "body": "...",
  "urgency": "normal", "choices": "[\"はい\",\"いいえ\"]" }
```
`choices` は JSON 配列文字列 (無ければ `"[]"`)。`UNREGISTERED` / 404 を受けたら push_token を消す。

## 7. ペアリング

`relay` の CLI がワンタイムコードを発行し、QRコードとして端末に表示する。内容:

```
oyobidashi://pair?url=<URLエンコードしたベースURL>&code=<pairing code>
```

- ベースURLは `--public-url` 指定、無ければ `http://<MacのLAN内プライベートIPv4>:<port>` (既定ルートのインターフェースのアドレス。プライベートIPv4が見つからなければエラーにして `--public-url` を促す)。ngrok 等のトンネルは使わない。
- アプリは QR 読み取り / 手入力 (URL とコード) で受け付け、`POST /v1/pair` を呼び、`url` と `device_token` を安全な領域 (Keychain / EncryptedSharedPreferences 等) に保存する。
- `oyobidashi://` ディープリンクは外部から誰でも開けるので、アプリ自身が始めたペアリングへの戻りだけを受け付ける。アプリは推測できない1回限りの値を発行してペアリングページ (`<ベースURL>/pair?from=app&state=<値>`) をブラウザで開き、同じ `state` と同じベースURLを持つリンクが30分以内に戻ったときだけ確認ダイアログを出す。それ以外のリンクは拒否する (他人が発行したコードのリンクを踏ませて、その人のアカウントにペアリングさせる攻撃を防ぐ)。
- アプリが受け付ける `url` は `http` / `https` のみ。平文 HTTP でLAN内アドレスに接続できるよう、iOS は ATS のローカルネットワーク例外 (`NSAllowsLocalNetworking`) と `NSLocalNetworkUsageDescription`、Android は release ビルドでも cleartext 通信を許可する。
- Mac のIPが変わったら再ペアリングする (v1 の割り切り。`--public-url http://<ホスト名>.local:8787` のように mDNS 名を指定してもよい)。
- Push (APNs/FCM) は relay からの外向き通信なので外出先でも鳴るが、**回答の送信は同一LAN内にいるときだけ可能**。圏外のときアプリは「中継サーバーに接続できない」旨を表示し、入力中の回答は保持する。

## 8. ローカル設定 (`$OYOBIDASHI_HOME`, 既定 `~/.oyobidashi`)

`config.json` (パーミッション 600。relay が初回起動時に生成、mcp が読む):
```json
{ "port": 8787, "agent_token": "ka_...",
  "apns": { "key_path": "/path/AuthKey_XXXX.p8", "key_id": "XXXX", "team_id": "YYYY",
            "bundle_id": "me.oyobidashi.ios" },
  "fcm": { "service_account_path": "/path/service-account.json" } }
```
`apns` / `fcm` は任意。DB は `$OYOBIDASHI_HOME/oyobidashi.db`。relay は既定で `0.0.0.0:8787` にバインド (`--host` で変更可)。LAN内のスマホから届く必要があるため。アクセス制御は上記の接続元アドレス検査とトークンで行う。

mcp の接続先解決順: 環境変数 `OYOBIDASHI_RELAY_URL` / `OYOBIDASHI_AGENT_TOKEN` → `config.json` (`http://127.0.0.1:<port>` と `agent_token`)。

## 9. MCP ツール (mcp/)

| ツール | 引数 | 動作 |
|---|---|---|
| `ask_human` | `question` (必須), `subject?` (用件, ≤40文字), `context?`, `choices?`, `items?`, `urgency?`, `wait_seconds?` | request を作り、回答を待つ |
| `wait_for_answer` | `request_id` (必須), `wait_seconds?` | 既存 request の回答を待ち続ける |
| `notify_human` | `message` (必須) | 一方向通知 (`kind: notification`) |
| `cancel_request` | `request_id` (必須) | 質問を取り消す |

- `wait_seconds`: 既定は環境変数 `OYOBIDASHI_DEFAULT_WAIT_SECONDS` (無ければ 50。Codex のツールタイムアウト既定60秒に収めるため)、範囲 0〜3600。内部では `GET …?wait=` を最大30秒ずつ繰り返す。
- 待ち時間内に回答が無ければ **エラーではなく** `status: "pending"` と `request_id` を返し、`wait_for_answer` を呼ぶよう案内する。
- `agent.name` は MCP クライアントの `clientInfo.name`、`agent.cwd` は `process.cwd()`。
- 結果は人間可読テキスト + `structuredContent` (`{ status, request_id, answer?, input_method?, choice_index?, item_answers?, warning? }`)。項目ごとの回答は [複数項目の質問](EXTENSIONS.md#複数項目の質問) を参照。
- `cancelled` / `expired` は `isError: false` でその旨を返す。relay に繋がらない・401 などは `isError: true` で対処方法つきのメッセージ。
- `paired_devices: 0` のときは `warning` に「ペアリング済みデバイスが無い」旨を入れる。
