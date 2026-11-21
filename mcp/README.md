# oyobidashi MCP サーバー (`mcp/`)

初回は[共通セットアップ](../docs/SETUP.md)を推奨します。ルートで `./scripts/setup.sh mcp --client both` を実行すると、絶対パスと状態ディレクトリを揃えたローカルMCP設定を生成します。以下は手動登録の代替手順です。ルートのスクリプトを使うrelayの状態は `.oyobidashi/` なので、手動登録も `scripts/mcp.sh` を使うか `OYOBIDASHI_HOME` を一致させてください。

AI コーディングエージェント (Claude Code / Codex) が、お呼び出し (人間) のスマホを鳴らして質問し、テキスト・音声・選択肢による回答を受け取るための **stdio MCP サーバー** です。

- ローカルの`relay/`またはクラウドの`cloud/`へ接続する薄いstdioブリッジです。クラウドの認証・ペアリングは[クラウドへの接続](#クラウドへの接続)を参照してください。
- 通信仕様は [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) が正です (ツール仕様は 9章)。

```
Claude Code / Codex ──stdio(MCP)──▶ mcp/ ──HTTP 127.0.0.1──▶ relay/ ──Push/WebSocket──▶ スマホアプリ
```

## 必要なもの

- [Bun](https://bun.sh) 1.4 以降
- LAN版では起動済みのrelay (`cd /path/to/oyobidashi/relay && bun run serve`)。初回起動で`~/.oyobidashi/config.json`を生成し、MCPはポートとagent tokenを読みます。クラウド版ではローカルrelayの起動は不要です。
- relay とペアリング済みのスマホ (未ペアリングでも質問は作成されますが、結果に `warning` が付きます)

## セットアップ

```sh
cd /path/to/oyobidashi/mcp
bun install
```

ビルドは不要です (`bun run src/index.ts` で TypeScript をそのまま実行します)。
以下では、このリポジトリを `/path/to/oyobidashi` に clone したものとします。**すべてのパスは絶対パスで指定してください** (相対パスは MCP クライアントの起動ディレクトリ依存になり、動きません)。自分の環境の絶対パスは `cd /path/to/oyobidashi && pwd` で確認できます。

## Claude Code に登録する

### `claude mcp add`

```sh
# 自分の全プロジェクトで使う (user スコープ)
claude mcp add -s user oyobidashi -- bun run /path/to/oyobidashi/mcp/src/index.ts

# 環境変数を渡す場合 (-e はサーバー名の後、-- の前に書く)
claude mcp add -s user oyobidashi -e OYOBIDASHI_DEFAULT_WAIT_SECONDS=50 -- bun run /path/to/oyobidashi/mcp/src/index.ts
```

`-s` を省略すると `local` スコープ (現在のプロジェクトで自分だけ) になります。登録状況は `claude mcp get oyobidashi` / Claude Code 内の `/mcp` で確認できます。

### `.mcp.json` (プロジェクト共有)

プロジェクトのルートに置きます (`claude mcp add -s project …` でも同じものが生成されます)。初回は Claude Code 起動時に承認が必要です。

```json
{
  "mcpServers": {
    "oyobidashi": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/oyobidashi/mcp/src/index.ts"],
      "env": {
        "OYOBIDASHI_DEFAULT_WAIT_SECONDS": "50"
      }
    }
  }
}
```

`env` は省略できます。Claude Code 側のツール呼び出しタイムアウトは環境変数 `MCP_TOOL_TIMEOUT` (ミリ秒) で変更できます。`wait_seconds` を長くする場合はそれ以上の値にしてください。

## Codex に登録する

### `codex mcp add`

```sh
codex mcp add oyobidashi -- bun run /path/to/oyobidashi/mcp/src/index.ts
```

### `~/.codex/config.toml`

```toml
[mcp_servers.oyobidashi]
command = "bun"
args = ["run", "/path/to/oyobidashi/mcp/src/index.ts"]
# 1回のツール呼び出しのタイムアウト (秒)。Codex の既定は 60 秒。
# 既定の待ち時間 (50 秒) のままなら設定不要。待ち時間を延ばすなら必ずそれより大きくする。
tool_timeout_sec = 120

# env テーブルは必ず最後に書く (これより後ろに書いたキーは env の中身として解釈される)
[mcp_servers.oyobidashi.env]
OYOBIDASHI_DEFAULT_WAIT_SECONDS = "100"
```

**`tool_timeout_sec` についての注意:** Codex はツール呼び出しが `tool_timeout_sec` (既定 60 秒) を超えるとエラーにします。このサーバーの既定待ち時間が 50 秒なのはそのためです。`OYOBIDASHI_DEFAULT_WAIT_SECONDS` や `wait_seconds` を大きくするときは、`tool_timeout_sec` を「待ち時間 + 20 秒」程度以上にしてください (relay が無応答のとき、最後のポーリングは待ち時間を最大 10 秒ほど超過して打ち切られます)。値を変えない場合は `tool_timeout_sec` も `env` も不要です。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `OYOBIDASHI_RELAY_URL` | (config.json の `port` から `http://127.0.0.1:<port>`) | LAN版relayのURL。LAN版agent APIはトンネル経由だと403。クラウド版では資格情報ファイルのURLを使うため指定不要 |
| `OYOBIDASHI_AGENT_TOKEN` | (config.json の `agent_token`) | relay の agent token (`ka_…`) |
| `OYOBIDASHI_HOME` | `~/.oyobidashi` | `config.json`・`cloud-auth.json`の保存先。ルートの補助スクリプト経由ではリポジトリの`.oyobidashi/` |
| `OYOBIDASHI_CLOUD_AUTH_FILE` | `$OYOBIDASHI_HOME/cloud-auth.json` | クラウド資格情報ファイルを明示する場合のパス |
| `OYOBIDASHI_DEFAULT_WAIT_SECONDS` | `50` | `wait_seconds` を省略したときの待ち時間 (0〜3600 に丸める。数値でなければ 50) |

接続先はツール呼び出しのたびに解決します。`OYOBIDASHI_RELAY_URL`または`OYOBIDASHI_AGENT_TOKEN`の明示指定があればLAN用設定を優先し、URLとtokenを環境変数・`config.json`から個別に解決します。明示指定がなければクラウド資格情報ファイルを使い、それもなければ従来の`config.json`を使います。LAN版はMCPを先に起動し、あとからrelayを起動しても動きます。

## ツール

| ツール | 引数 | 動作 |
|---|---|---|
| `ask_human` | `question` (必須, 1〜4000文字), `subject?` (用件, ≤40文字, 着信画面に表示), `context?` (≤8000), `choices?` (≤8個, 各1〜200文字), `priority?` (`low`/`normal`/`high`/`urgent`, 既定 `normal`), `delivery_mode?` (`auto`/`actions`/`text`/`call`, 既定 `auto`), `urgency?` (`normal`/`high`, 旧来の別名), `expires_in_seconds?` (10〜86400), `wait_seconds?` | 質問を作ってスマホへの通知を試み、回答を待つ (配信は保証されない) |
| `wait_for_answer` | `request_id` (必須), `wait_seconds?` | `pending` で返ってきた質問の回答を待ち続ける (通知は再送しない)。`pending` 時は `priority` / `delivery_mode` / `call` のテレメトリも返す |
| `get_human_status` | (引数なし) | 人間の在席 (`available`/`busy`/`away`) と直近のフィードバック (回答・通話の declined/hangup など) を読む。エスカレーション前に呼ぶ |
| `update_request` | `request_id` (必須), `priority?`, `delivery_mode?` (少なくとも一方は必須) | `pending` の質問の優先度・配信方法を変える。現在の実効モード・通話状態・フィードバックを返す |
| `notify_human` | `message` (必須, 1〜4000文字) | 一方向の通知。待たない (配信は保証されない) |
| `cancel_request` | `request_id` (必須) | 質問を取り消す。一方向の通知 (`notify_human`) の取り下げにも使える |

結果は人間可読テキスト + `structuredContent`:

```jsonc
{ "status": "answered", "request_id": "req_01JCXYZ", "answer": "はい", "input_method": "choice", "choice_index": 0 }
{ "status": "pending",  "request_id": "req_01JCXYZ", "priority": "high", "delivery_mode": "call",
  "requested_mode": "call", "call": { "id": "call_01", "state": "ringing", "outcome": null } }  // 時間切れ。エラーではない → wait_for_answer を呼ぶ
{ "status": "cancelled" | "expired" | "notified", "request_id": "…" }
{ "status": "ok", "devices": [/* {device_id, availability, until, note, …} */],
  "recent_events": [/* {request_id, device_id, event, at} */], "now": "…" }   // get_human_status
{ "status": "error", "error_code": "relay_unreachable", "request_id": "…" }   // isError: true のときのみ
```

- `wait_seconds` は 0〜3600 (範囲外は丸める)。内部では relay への long-poll (`GET /v1/requests/{id}?wait=`) を最大 30 秒ずつ繰り返します。`0` なら待たずに現在の状態を返します (`get_request` 代わりに `wait_for_answer` + `wait_seconds: 0` を使う)。
- `priority` は `low`/`normal`/`high`/`urgent` (既定 `normal`)。短い選択式 (3つ以下) で急がないものは `low` を、実際に行き詰まっていて遅延が実害になる場合だけ `high`/`urgent` を使う。`urgency` は互換用の旧引数 (`priority` 指定時は `priority` から `urgency` を補完して送る)。
- `delivery_mode` は `auto` (既定: 短い選択式はワンタップの `actions`、それ以外は `text`) / `actions` / `text` (補足つき・長文の自由回答向け) / `call`。`call` は `high`/`urgent` かつ実際にブロックしているときだけ明示指定し、事前に `get_human_status` を確認する。通話が `declined`/`hangup`/`missed`/`failed` ならリダイヤルせずテキストで続ける。
- `input_method: "voice"` の回答は音声認識の書き起こしなので、誤認識を含む可能性があります (結果テキストにもその旨を書きます)。
- `cancelled` / `expired` は `isError: false` です。
- ペアリング済みデバイスが 0 台のときは `warning` フィールドが付きます。
- `cancel_request` で既に回答済み・期限切れなどだった場合 (relay が 409 `already_resolved`) は、エラーにせず現在の状態 (回答済みなら回答も) を返します。
- いずれのツールも OS 通知の到達を保証するものではありません。在席表示は人間が共有した意思表示であり、通知が見られた証拠にはなりません。
- relay に繋がらない / 401 / 403 / 404 / 400 / 5xx / 壊れた応答 / タイムアウトは `isError: true` で、対処方法つきのメッセージを返します (`error_code`: `relay_unreachable`, `relay_timeout`, `bad_response`, `config_missing`, `config_invalid`, または relay のエラーコード)。
- 質問を作成した後の待機中に relay が一時的に落ちた場合 (接続不可・タイムアウト・5xx) は 1 秒 → 2 秒 → 4 秒の間隔で最大 3 回リトライし、復帰すればそのまま待ち続けます。復帰しなければ `request_id` つきのエラーを返すので、relay 復旧後に `wait_for_answer` で続きから待てます。
- エージェント側がツール呼び出しをキャンセル (MCP の `notifications/cancelled`) すると、ポーリングを止めます (質問自体は取り消しません。不要なら `cancel_request` を呼んでください)。
- クライアントが progress token を付けた場合、ポーリング 1 周ごとに `notifications/progress` を送ります。

## AGENTS.md に書くスニペット (例)

エージェントが適切な場面で `ask_human` を呼ぶよう、共通の `AGENTS.md` に次のような指示を入れておけます。Claude CodeでAGENTS.mdを読み込む方法はルートのSessionStartフックを参照してください。

```markdown
## お呼び出しへの連絡 (oyobidashi)

ユーザーは端末の前にいないことが多い。次の場合はターミナルで質問して止まるのではなく、
MCP ツール `ask_human` (oyobidashi) でスマホに質問すること。

- ユーザーにしか決められない判断で作業が止まったとき
  (仕様の曖昧さ、トレードオフのある設計の選択、本番環境や削除・force push など取り返しのつかない操作の承認)
- 作業に必要な情報が足りず、コードやドキュメントを調べても分からないとき
- 依頼された作業が終わり、次に何をするか指示が必要なとき

使い方:

- 質問はスマホの通知で読まれる。それだけ読んで分かるように短く具体的に書き、補足は `context` に入れる (通知の到達は保証されない)。
- 電話の冒頭では `question` が読み上げられる。Jira などの参照先を確認できる場合は事前に読み、何の件かと判断に必要な事実を伝えてから、決めてほしいことを聞く。課題番号や URL は `context` に入れ、聞くだけで判断できるよう短くまとめる。判断に必要な情報を確認できない場合や、相手が資料を読む必要がある場合はテキストで送る。
- 答えが数個に絞れるなら `choices` を付ける (ワンタップで回答できる)。急がない短い選択式 (3つ以下) は `priority: "low"` で送る。
- 補足を読む必要があるときや、長文の自由回答がほしいときは `delivery_mode: "text"` を使う。`call` は `high`/`urgent` かつ実際に行き詰まっているときだけ明示指定する。
- 優先度を上げたり `call` に切り替えたりする前に `get_human_status` で在席と直近のフィードバックを確認する。`busy`/`away` なら `low` + `text` を優先する。
- 通話が `declined`/`hangup` (不在・失敗も) ならリダイヤルせず、テキストで待つ。`pending` 結果の `delivery_mode` / `call` を見て判断し、必要なら `update_request` で静かにする。
- 結果が `status: "pending"` ならエラーではない。同じ質問を `ask_human` で送り直さず、
  返ってきた `request_id` で `wait_for_answer` を回答が来るまで繰り返し呼ぶ。
- `input_method: "voice"` の回答は音声認識の書き起こしで、誤変換を含むことがある。
  文脈から解釈し、重要な判断で意味が曖昧ならもう一度確認する。
- 質問 (や通知) が不要になったら `cancel_request` で取り消す・取り下げる。
- 自分で調べれば分かることや些細な確認では呼ばない (呼ぶたびにスマホが鳴ることがある)。
- 長時間かかる作業が完了・失敗したときは `notify_human` で一言知らせる (返事は来ない)。
```

## トラブルシューティング

| 症状 (`error_code`) | 対処 |
|---|---|
| `relay_unreachable` | relay が起動していない。`cd /path/to/oyobidashi/relay && bun run serve`。別ポート・別ホストなら `OYOBIDASHI_RELAY_URL` |
| `config_missing` / `config_invalid` | `~/.oyobidashi/config.json` が無い・壊れている。relay を一度起動して生成させるか、`OYOBIDASHI_RELAY_URL` と `OYOBIDASHI_AGENT_TOKEN` を設定 |
| `unauthorized` (401) | LAN版ではtoken不一致。`OYOBIDASHI_AGENT_TOKEN` を設定しているなら config.json の `agent_token` と揃える (または外す)。`OYOBIDASHI_HOME` が relay と同じか確認 |
| `forbidden` (403) | LAN版ではトンネル (ngrok) のURLやプロキシ経由で叩いている。`http://127.0.0.1:<port>` を直接指定する |
| `not_found` (404) | `request_id` が違う、または relay の DB が初期化された |
| `bad_response` | そのポートでrelay以外の何かが動いている、またはバージョン不一致 |
| `cloud_auth_required` / クラウドの401 | 保存したアカウントの認証を確認。新しい匿名UIDで置き換えず、登録済みの復旧方法と下記の`--recover`を使う |
| `cloud_auth_invalid` | 資格情報の形式・権限600・クラウド接続先・Firebaseプロジェクトを確認。元ファイルを保存したまま再試行 |
| `cloud_auth_unavailable` | 一時的な通信障害またはクラウド認証設定の不足。接続・管理者の設定を確認して再試行 |
| いつも `pending` で返る | 仕様どおりです (既定 50 秒)。エージェントが `wait_for_answer` を呼び続けます |
| `warning` (ペアリング済みデバイスなし) | relay の CLI でペアリング用 QR を表示し、アプリの「自分で用意したサーバーに接続」で読み取る |

ログは標準エラー出力に `[oyobidashi-mcp]` 付きで出ます (標準出力は MCP プロトコル専用です)。

## 開発

```sh
cd /path/to/oyobidashi/mcp
bun test            # ユニットテスト (偽 relay を使うので relay の起動は不要)
bun run typecheck   # tsc --noEmit (strict)
```

```
src/index.ts         stdio エントリポイント
src/server.ts        MCP サーバーとツール定義 (依存はすべて注入可能)
src/http.ts          クラウドの /v1/mcp が使う Streamable HTTP の処理 (同じツール定義を共用)
src/relay-client.ts  relay の Agent API クライアント (fetch と時計を注入可能)
src/wait.ts          long-poll の繰り返し・リトライ
src/results.ts       結果とエラーメッセージの組み立て
src/config.ts        接続先の解決 (環境変数 → config.json)
src/clock.ts         時計の抽象
test/helpers.ts      偽 relay (docs/fixtures を返す)・偽時計・インメモリ MCP ハーネス
test/*.test.ts       config / relay-client / tools / tools-errors / extensions (優先度・配信・在席) / stdio (実プロセス)
```

`get_request` という独立ツールはあえて作っていません。状態確認だけなら `wait_for_answer` に `wait_seconds: 0` を付けて呼ぶのがそれに相当します (通知の再送なし・ブロックなしで `priority` / `delivery_mode` / `call` 付きの現在状態を返します)。


## 人間の状態リソース

`resources/list`で`human://status`を公開します。`resources/read`は在席・期限・最終接続・直近の拒否/切断などをJSONで返します。`resources/subscribe`を実装するクライアントには、変化時に`notifications/resources/updated`を送ります (5秒間隔で検知)。通知後に再読み込みしてください。購読解除・接続終了時に監視を停止します。購読しないクライアントは`get_human_status`を利用できます。

## クラウドへの接続

クラウド版には、MCPクライアントへ`https://api.oyobidashi.me/v1/mcp`を登録してブラウザでログインするだけの接続方法もあります。その場合はこのディレクトリのセットアップは不要です。手順は[cloud/README.md](../cloud/README.md#urlだけで接続するmcp)を参照してください。以下は、ローカルのstdioブリッジからFirebase IDトークンでAPIへ接続する方法です。公開環境のメインURLは[api.oyobidashi.me](https://api.oyobidashi.me)です。既存の[oyobidashi.up.railway.app](https://oyobidashi.up.railway.app)も引き続き利用できます。MCP登録は既存の`scripts/mcp.sh`のままで、ローカルrelayの起動は不要です。

リポジトリルートから、通常のターミナルで実行します。

```sh
bun install --cwd mcp --frozen-lockfile
./scripts/login-cloud.sh --url https://api.oyobidashi.me
./scripts/pair-cloud.sh
```

初回はメールアドレスやパスワードを求めず、匿名のFirebaseアカウントを作ります。同じコマンドを再実行すると保存済みアカウントを再利用し、UIDとペアリングを維持します。Firebaseの公開設定はAPIから取得するため、通常は`--api-key`不要です。

既存の資格情報に旧URLが保存されている場合は、ログイン・`--link`・`--recover`にも保存済みの旧URLを指定します。ログイン補助は別の接続先による資格情報の上書きを拒否します。旧URLも引き続き利用できるため、ドメイン追加に伴う再ペアリングは不要です。

### 復旧用アカウントの登録

匿名アカウントを使い始めたら、Googleなどを復旧用に登録してください。

```sh
./scripts/login-cloud.sh --url https://api.oyobidashi.me --link google
```

ブラウザが開き、現在のUIDへGoogleアカウントをリンクします。UIDを変更せず、質問・スマホのペアリングを保ちます。指定したGoogleアカウントが別のUIDへ登録済みならリンクを拒否します。別アカウントへ自動で切り替えたり、ペアリングを統合したりしません。

現在の公開環境ではGoogle・Apple・GitHubをFirebaseで設定済みです。旧URLでは3つとも既存UIDを保つリンクと、保存済み資格情報を使わない独立した再ログインでもペアリングを復旧できることを実ブラウザで確認しています。新しいメインURLではGoogleの再ログイン・同じUIDと端末一覧の取得を確認し、Apple・GitHubのコールバック設定は維持しています。`--link apple`・`--link github`でも同じUIDへ追加できます。自分の環境で利用する場合は、[各プロバイダーの設定](../cloud/README.md#applegithubのプロバイダー設定)を先に完了してください。

### 登録済みアカウントへの復旧

PCの変更や資格情報の喪失時には、以前リンクしたアカウントで復旧します。

```sh
./scripts/login-cloud.sh --url https://api.oyobidashi.me --recover google
```

復旧先UIDの質問・ペアリングへ戻ります。別UIDの資格情報が既に保存されていれば、上書き前に`cloud-auth.json.before-recovery-<時刻>-<UUID>.json`を権限600で保存します。元のUIDのデータを復旧先へ移動・統合する処理ではありません。ファイルがない場合や同UIDの場合は、この別UID用バックアップを作りません。

**復旧方法を登録せずに匿名アカウントの資格情報を失うと、同じUIDへは戻れません。** 新しく匿名で開始しても以前の質問・ペアリングは復元されません。Firebase側の匿名アカウント自動クリーンアップも有効にしないでください。

`--provider google`はブラウザでの明示的なログイン、`--provider password`は従来のメール・パスワード入力です。既存ファイルと異なるUIDへの切り替えは`--recover`で明示する必要があります。`--provider`・`--link`・`--recover`は同時指定できません。

### 資格情報と通信

ルートの補助スクリプトは`scripts/mcp.sh`と同じ`OYOBIDASHI_HOME`（既定はリポジトリの`.oyobidashi/`）を使います。`bun run --cwd mcp login:cloud`を直接使う場合の既定は`~/.oyobidashi/`です。MCP・ログイン・ペアリングで保存先を揃えてください。`--auth-file PATH`または`OYOBIDASHI_CLOUD_AUTH_FILE`で明示できます。

資格情報は`cloud-auth.json`へ原子的に保存し、権限を600にします。復旧時のバックアップも秘密情報です。ファイルをチャット・git・共有ドライブへ載せないでください。既存の`config.json`や他プロバイダーの認証は変更しません。破損したファイルや別のクラウド用ファイルは上書きせず、保全したうえで別の`--auth-file`へ復旧してください。

`OYOBIDASHI_RELAY_URL`または`OYOBIDASHI_AGENT_TOKEN`が明示されているとLAN用設定を優先します。クラウドを使うMCP設定からこれらの上書きを外し、アカウントを切り替えたらMCPを再接続してください。IDトークンは期限前に更新し、同時リクエストの更新を共有します。更新は10秒で打ち切り、401時は1回だけ強制更新します。失敗時も既存資格情報を保持します。

ブラウザ認証は対話デスクトップ端末から開始します。現在のUIDとのリンク、使い捨てstate、ループバックのHost・Originを検証し、トークンはURLクエリへ入れません。Google等の秘密鍵やサービスアカウントJSONをCLIへ渡す必要はありません。Firebase Web APIキーは公開設定値ですが、IDトークン・refresh token・認証ハンドオフURLは秘密として扱います。

質問作成では`Idempotency-Key`を付けます。クラウドで応答が失われた場合だけ、同じキーで1回再試行します。LAN relayへの作成や、任意の5xx応答を受けた更新は自動で繰り返しません。MCPの結果・エラーへトークンやペアリングコードを含めず、ペアリングURLは`pair-cloud.sh`を実行した対話ターミナルにだけ表示します。

クラウド運用のFirebase設定・署名鍵・音声APIの制限は[cloud/README.md](../cloud/README.md)を参照してください。米国西部のRailway workerと実iPhoneを使い、通知からの返信、音声の確認質問と再回答、お礼の読み上げと自動終話、MCPへの解決済み回答の返却まで確認しました。[検証記録](../docs/VALIDATION.md)
