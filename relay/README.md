# oyobidashi relay


> v0.2: 通話・在席フィードバック・通知取り消しを追加しました。[全体の起動方法と制限](../README.md)、[拡張プロトコル](../docs/EXTENSIONS.md)を参照してください。既定はLAN内、明示したHTTPSプロキシ経由でも利用できます。

エージェント (Claude Code / Codex) からの質問をスマホへ届け、回答を返す中継サーバーです。
Mac 上で動かし、スマホとは 既定は **同じLAN (Wi-Fi)** で通信します。外出先ではHTTPS/WSSの中継経路を明示設定します。
通信仕様は [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) を参照してください。

## 必要なもの

- [Bun](https://bun.sh) 1.4 以降
- Mac とスマホが同じ Wi-Fi / LAN にいること

## 起動

```sh
cd relay
bun install
bun run serve            # 0.0.0.0:8787 で待ち受け
```

- 初回起動時に `~/.oyobidashi/config.json` (パーミッション 600) を作り、agent token を生成します。mcp はこのファイルを読んで接続します。
- DB は `~/.oyobidashi/oyobidashi.db` です。置き場所は環境変数 `OYOBIDASHI_HOME` で変えられます。
- `--port 9000` でポートを変えると `config.json` の `port` も書き換えます (mcp が同じポートを見るため)。
- `--host 192.168.1.10` のように待ち受けアドレスを絞れます。`--host 127.0.0.1` にするとスマホからは届きません。
- 初回は macOS のファイアウォールが「受信接続を許可しますか」と尋ねることがあります。**許可** してください (拒否するとスマホから届きません)。
- 止めるときは Ctrl-C。

## 既定のLAN接続とHTTPSプロキシ

- relay は接続元がプライベートアドレス (ループバック / 10.x / 172.16〜31.x / 192.168.x / 169.254.x / IPv6 の fc00::/7・fe80::/10) でないリクエストを、`/healthz` も含めてすべて 403 で拒否します。
- 未設定のプロキシは403です。`serve --host 127.0.0.1 --public-url https://YOUR_HOST`で明示したホストのローカルTLSプロキシだけを許可します。転送されたエージェント用APIは常に拒否します。
- エージェント用 API (質問の作成・取り消し・回答待ち) は、この Mac 自身 (ループバック) からしか呼べません。
- Push 通知 (APNs / FCM) は relay から外向きに送るので外出先でも届きます。回答にはLANまたは設定済みのHTTPS経路への接続が必要です。

## ペアリング

`serve` を動かしたまま、別のターミナルで:

```sh
bun run pair
```

QR コードと `oyobidashi://pair?url=...&code=...` が表示されます。アプリで QR を読み取るか、URL とコードを手入力してください。

- コードは 10 分間・1 回だけ有効です。
- URL は既定で `http://<Mac の LAN 内プライベート IPv4>:<port>` (既定ルートのインターフェースのアドレス) になります。
  プライベート IPv4 が見つからないときはエラーになるので、`--public-url` で指定してください。
- **Mac の IP アドレスが変わったら再ペアリングが必要です。** 変わりやすい環境では mDNS 名を使うと楽です:

  ```sh
  bun run pair --public-url http://<ホスト名>.local:8787
  ```

  (`bun run serve --public-url ...` と起動時に指定しておくと、以後の `pair` がその URL を使います)

その他のコマンド:

```sh
bun run devices            # ペアリング済みデバイスの一覧
bun run revoke <device_id> # ペアリング解除 (接続中の WebSocket も数秒以内に切断)
bun run status             # 設定・起動状態・Push 設定・デバイス数
```

## Push 通知の設定 (任意)

`~/.oyobidashi/config.json` に資格情報を書いて `serve` を再起動します。
書かなければ Push は無効で、アプリを開いている間だけ WebSocket で届きます。

```json
{
  "port": 8787,
  "agent_token": "ka_...",
  "apns": {
    "key_path": "/Users/me/keys/AuthKey_XXXXXXXXXX.p8",
    "key_id": "XXXXXXXXXX",
    "team_id": "YYYYYYYYYY",
    "bundle_id": "io.github.yusukeiwaki.oyobidashi"
  },
  "fcm": {
    "service_account_path": "/Users/me/keys/service-account.json"
  }
}
```

### APNs (iOS)

1. Apple Developer の Certificates, Identifiers & Profiles → Keys で、Apple Push Notifications service (APNs) を有効にしたキーを作り、`.p8` をダウンロードします。
2. `key_path` に `.p8` のパス、`key_id` にキー ID、`team_id` に Team ID を書きます。
3. `bundle_id` はアプリの Bundle ID です (省略時 `io.github.yusukeiwaki.oyobidashi`)。

Xcode から実機に入れた開発ビルドは sandbox、TestFlight / App Store ビルドは production の APNs を使います。
どちらに送るかはアプリがペアリング時に `push_environment` で申告するので、relay 側の設定は共通です。

### FCM (Android)

1. Firebase コンソール → プロジェクトの設定 → サービス アカウント → 「新しい秘密鍵を生成」で JSON をダウンロードします。
2. `service_account_path` にそのパスを書きます。

鍵ファイルが読めない・壊れている場合、relay は警告を出してその Push だけを無効にして起動します (`bun run status` で確認できます)。
無効になった端末トークン (APNs の 410 / `BadDeviceToken` / `Unregistered`、FCM の `UNREGISTERED` / 404) は自動的に消します。

## 開発

```sh
bun test            # ユニットテスト (ネットワークには出ません)
bun run typecheck   # tsc --noEmit
```

| ファイル | 役割 |
|---|---|
| `src/app.ts` | HTTP / WebSocket ハンドラ本体。`createApp({ store, agentToken, clock, push, peerAddress })` |
| `src/net.ts` | 接続元アドレスの判定 (プライベート / ループバック) |
| `src/db.ts` | SQLite (`bun:sqlite`) |
| `src/push/` | APNs (HTTP/2 + ES256 JWT) / FCM (HTTP v1 + OAuth2) |
| `src/pairing.ts` | ペアリングコード発行、ペアリング URL の決定 |
| `src/config.ts` | `$OYOBIDASHI_HOME/config.json` |
| `src/server.ts` | `Bun.serve` への組み込み、定期掃除、WebSocket ping |
| `src/cli.ts` | `serve` / `pair` / `devices` / `revoke` / `status` |
