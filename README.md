# お呼び出し

AIエージェントがMCPで人間に質問し、スマートフォンの選択ボタン・テキスト・音声通話で回答を受け取るアプリです。iOSはSwiftUI / CallKit / PushKit、AndroidはCompose / self-managed Telecom、Macの中継はBun / SQLiteです。

アプリID: iOS **`me.oyobidashi.ios`** / Android **`me.oyobidashi.android`**。

複数人向けの[クラウド構成](cloud/README.md)も利用できます。RailwayのAPI／共有ワーカー、PostgreSQL、Redis、Firebase Authenticationで構成し、無言の間は会話ワーカーを使いません。以下はLAN版の説明です。クラウド版の音声判断には明示的に設定したLLM APIを使います。

## clone後のセットアップをAIに任せる

Claude CodeまたはCodexでこのリポジトリを開き、次を依頼してください。

> AGENTS.mdを読み、oyobidashi-setupスキルで開発環境をセットアップしてください。ブラウザを操作してFirebase・サービスアカウントJSON・Apple APNsを準備し、ローカル起動・MCP登録・端末確認までお願いします。ログインはブラウザ上で行います。

ClaudeはClaude in Chrome、CodexはChrome拡張またはComputer useを接続します。スキルはそれぞれ `.claude/skills/` と `.agents/skills/`、共通の入口は[AGENTS.md](AGENTS.md)です。CLAUDE.mdは使いません。既存設定を再利用し、鍵と本人の署名設定はgit管理外へ保存します。[詳しいセットアップ手順](docs/SETUP.md)。

## 応答の流れ

| 質問 | 届き方 |
|---|---|
| 短い質問、短い背景、選択肢1〜3個 | 通知のアクションボタン |
| 長い説明・自由記述 | 通知 → 返信画面。アイコンから起動しても未回答一覧に表示 |
| 明示的な高優先度・緊急の通話 | iOS CallKit / Android Telecomで着信。音声で会話し、回答が揃ったら終話 |
| 相手が取り込み中・離席中、別の通話中 | テキストに切り替え |
| 着信拒否・途中で切断・45秒無応答 | 質問は残してテキスト通知へ。自動再発信はしない |
| エージェントが取り消し・回答済み・期限切れ | 返信を閉じ、通知と着信を取り消す |

人間は「対応可 / 取り込み中 / 離席中」と有効期限を設定できます。MCPリソース`human://status`の購読にも対応し、変化時に`notifications/resources/updated`を送ります (約5秒間隔で検知)。エージェントは`get_human_status`でこの状態・最終接続時刻・拒否/無応答などの結果を読み、`update_request`で優先度や方法を変更できます。通知の取り消しは一方向のお知らせにも使えます。

同じ中継にペアリングした端末へ配信する1対多方式です。最初に応答した端末が通話を所有し、他端末は着信を終了します。iPhone実機とAndroidエミュレータ間で両方向の着信停止、およびエージェントによる通知取り消しがiPhoneのバックグラウンドで反映されることを確認しました。確認条件とiOSの配信制限は[検証記録](docs/VALIDATION.md)に記載しています。

## Macで起動

必要: Bun、ログイン済みのClaude Code (`claude auth status`)、iOSはXcode / XcodeGen、AndroidはJDK 17 / Android SDK。

```sh
bun install --cwd relay
bun install --cwd mcp
bun install --cwd integration
./scripts/dev.sh
```

別ターミナルで`./scripts/pair.sh`を実行し、アプリでQRを読み取るかURLとコードを入力します。コードは10分・1回限りです。`scripts/`は中継とMCPで同じ`.oyobidashi/`を使います。`OYOBIDASHI_HOME`で変更できます。

Claude Code / CodexなどのMCP設定:

```json
{
  "mcpServers": {
    "oyobidashi": {
      "command": "/absolute/path/to/oyobidashi/scripts/mcp.sh"
    }
  }
}
```

```json
{
  "question": "検証環境への反映を進めてもよいですか？",
  "choices": ["進めてください", "あとで"],
  "priority": "low",
  "delivery_mode": "actions",
  "wait_seconds": 0
}
```

これを`ask_human`へ渡します。`pending`なら同じ`request_id`で`wait_for_answer`を呼びます。不要になったら`cancel_request`。通話は`get_human_status`を確認後、`priority: high|urgent`と`delivery_mode: call`を明示してください。[MCPの詳細](mcp/README.md)。

## 音声

Gemini / OpenAIの音声APIキーは不要です。端末のSpeech / TTSと、Macのログイン済みClaude Code CLIを組み合わせます。CLIにツール・MCP・ユーザー設定・フックを渡さず、会話データをstdin、構造化応答をstdoutで受け取ります。OAuth認証情報はCLI自身が扱います。APIキーの抽出・流用は行いません。

**現状はターン単位の音声会話**です。読み上げ → 発話の確定 → CLI判断 → 読み上げを繰り返します。Gemini Liveのような全二重ストリーミング・割り込み発話は未実装です。応答速度と利用量はサブスクリプションに依存します。認識できないときは文字へ切り替えられ、部分的な認識結果を自動送信しません。最後のお礼は読み上げてから終話します。

iOSでは「設定」→「権限」でマイク・音声認識を事前に許可できます。応答後は質問・聞き取り状態・字幕・終了ボタンを表示します。iPhone 16 Proで、実音声回答のMCP返却・お礼後の自動終話・途中終了から通知とテキスト返信への切り替えを確認済みです。[実機の検証記録](docs/VALIDATION.md#iphone実機の追加確認-2026-11-16)。

AndroidもPixel 10a / Android 17で、実FCM着信、音声回答のMCP返却、お礼後の自動終話、途中終了からテキスト通知・返信への切り替えを確認済みです。連続着信の画面更新と、一方向通知が早期に消える不具合を実機で修正・再確認しています。[Pixel実機の検証記録](docs/VALIDATION.md#pixel-10a実機の確認-2026-11-16)。

## Push・実機・外出先

アプリを閉じている場合の着信にはAPNs VoIP / FCMが必要です。起動中のLAN動作はWebSocketだけでも試せます。

- **Android:** 自分のFirebaseプロジェクトにAndroidアプリを登録します。ダウンロードしたJSONは `./scripts/setup.sh firebase` で検証・取り込みでき、`android/local.properties`とrelayを設定します。[Firebaseの準備](docs/setup/FIREBASE.md)、[アプリの詳細](android/README.md)。
- **FCM送信:** ログイン済みGoogle Cloud CLIを使う場合、`.oyobidashi/config.json`へ`"fcm": {"auth":"gcloud","project_id":"YOUR_PROJECT"}`を追加して中継を再起動します。サービスアカウント鍵を使う既存方式も利用できます。
- **iOS:** 自分のApple DeveloperチームでApp IDとAPNs鍵を準備し、`./scripts/setup.sh apple` で取り込みます。別チームでは自分のBundle IDを使い、`ios/project.local.yml`へ署名設定を分離します。通常APNsとVoIPの端末トークンを別々に管理します。[Appleの準備](docs/setup/APPLE.md)、[iOSビルド](ios/README.md)。
- **外出先:** 既定はLAN内です。DNS・正規のTLS証明書・MacへのHTTPS/WSS経路を設定し、`./scripts/dev.sh --host 127.0.0.1 --public-url https://YOUR_HOST`で起動できます。[Caddy設定例](docs/Caddyfile.example)。明示したホストのローカルHTTPSプロキシだけを信頼し、エージェント用APIはプロキシから拒否します。外部公開は今回実施していません。

PushはOSやネットワークにより遅延・不達になります。iOSのサイレントPushによる通知削除も即時保証されません。復帰・再接続時にサーバーの状態と照合し、終了済みの質問への返信を防ぎます。VoIP Pushは着信開始だけに使い、終話・取り消しは接続済みの通信経路で伝えます。

## ビルドと検証

```sh
# サーバー・MCPの単体試験
bun test --cwd relay
bun test --cwd mcp
# Swiftの単体試験
swift test --package-path ios/OyobidashiKit
# Android (JDK17をJAVA_HOMEに設定)
cd android
./gradlew :core:test :app:assembleDebug
# 実サーバー・stdio MCP・両OS通信クライアントの結合試験
cd ..
bun test --cwd integration
# iOSアプリ
xcodegen generate --spec ios/project.yml
```

[検証結果・残る実機確認](docs/VALIDATION.md)、[プロトコル](docs/PROTOCOL.md)、[v0.2拡張](docs/EXTENSIONS.md)。秘密鍵、設定、DB、Firebase設定はgitignore対象です。アイコンはポケベル・緑のLCD・AIのきらめきをネイティブのベクター描画で作成し、Androidはadaptive / monochromeを含みます。
