# cloneからAIにセットアップを任せる

macOSでiOS / Androidのローカル開発環境を作る手順です。Claude Code・Codexどちらも入口はルートの[AGENTS.md](../AGENTS.md)。クラウド操作の説明だけで終わらず、AIがブラウザ操作、鍵の取得、設定、ビルド、MCP接続まで進めます。ユーザーはログイン・端末の接続や発話など、AIから操作できない部分を担当します。

## 最初にユーザーがすること

リポジトリをcloneしてClaude CodeまたはCodexで開き、次を依頼してください。既存プロジェクトを使う場合は名前・IDも添えてください。

> AGENTS.mdを読み、oyobidashi-setupスキルでこのMacの開発環境をセットアップしてください。対象はiOSとAndroidです。ブラウザを操作して、自分のアカウントでFirebase、サービスアカウントJSON、AppleのAPNsを準備し、ビルド・MCP登録・ペアリング・動作確認まで進めてください。ログイン画面になったら知らせてください。

- Claude Code: [Claude in Chrome](https://code.claude.com/docs/en/chrome)を接続して `claude --chrome` で開始します。リポジトリを信頼するとSessionStartフックがAGENTS.mdを読み込みます。フックを無効にしている場合も上の依頼文、または `/oyobidashi-setup` で開始できます。CLAUDE.mdは不要です。
- Codex: `.agents/skills/oyobidashi-setup/` を使います。Chrome拡張またはComputer useを接続してください。ブラウザの種類を指定した場合、AIはその接続を使用します。
- Google / Appleへのログイン、2FAはユーザーがブラウザで行います。パスワード・認証コードをチャットに貼る必要はありません。
- iOSのPush実機確認には有効なApple Developer Programのチームが必要です。未加入でもAndroidと署名なしのiOSビルドを先に進められます。

## エージェントの実施順序

### 1. 現在地を確認する

この文書と[ブラウザの引き継ぎ](setup/BROWSER.md)を読み、ルートから実行します。

```sh
./scripts/setup.sh doctor
```

Bun未導入なら[公式手順](https://bun.sh/docs/installation)に従って導入してから再実行します。doctorは状態を変更せず、秘密値も表示しません。「設定あり」はファイルの存在確認であり、クラウド認証やPush成功の証明ではありません。

OS、ツール、既存のローカル設定、接続中の端末を調べます。対象OS・Googleプロジェクト・Appleチームが複数で判断できない場合だけ、候補を示してまとめて確認します。git remoteの所有者を利用者のAppleチームと見なしません。既存の `.oyobidashi/setup-state.json` があれば未完了工程から再開します。

AIは次をgit管理外のチェックポイントへ記録します。プロジェクトID、Android App ID、Team ID、Bundle ID、APNs Key ID、設定ファイルのパス、工程ごとの `pending/configured/verified/blocked`、阻害理由、次の操作。秘密鍵・アクセストークン・ペアリングURL・認証コードは記録しません。新しい鍵を作る前にこの記録と手元の鍵を確認します。

### 2. ローカルの道具を用意する

不足するものを検出して導入します。既存の正しいインストールを再利用し、機械固有の絶対パスを文書へ固定しません。

| 用途 | 必要なもの・確認 |
|---|---|
| 共通 | git、Bun 1.4以降。`bun --version` |
| iOS | Xcode (iOS 17以降をビルドできるもの)、Command Line Tools、XcodeGen。`xcodebuild -version`、`xcode-select -p`、`xcodegen --version` |
| Android | JDK17、Android SDK Command-line Tools、platform-tools、`platforms;android-35`、`build-tools;35.0.0`。Gradleは同梱wrapperを使用 |
| 音声会話 | Claude Code CLIの導入と本人のログイン。`claude auth status` で確認。Codexだけなら通知・テキストのセットアップを完了し、音声の未設定を報告 |

Homebrewが既にあれば `brew install bun xcodegen openjdk@17` 等を必要なものだけ実行できます。Xcode本体・SDKライセンス等で本人の操作が必要なら、必要な画面と理由を示します。Android SDKはAndroid StudioのSDK Managerまたは `sdkmanager` で準備し、ユーザーのライセンス手続きを尊重します。`adb version` と実行ファイルの位置を確認し、新しい実機を認識できる公式platform-toolsを使用します。

```sh
# sdkmanagerが使える場合。利用者のSDK位置とJAVA_HOMEを先に解決する
sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
./scripts/setup.sh bootstrap
# SDKが自動検出できない場合
./scripts/setup.sh init --sdk-dir '/absolute/path/to/android/sdk'
```

bootstrapはrelay / mcp / integrationの依存をlockfile固定で入れ、私有のrelay設定を初期化します。既存の `android/local.properties` のSDKパスは保ちます。未設定なら `--sdk-dir` → `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOSの既定位置の順で検出します。`--sdk-dir` を明示した場合は既存値も更新します。

### 3. Pushを用意する

- Android対象: [Firebaseのブラウザ手順](setup/FIREBASE.md)を実行します。プロジェクト、Androidアプリ、FCM HTTP v1 API、専用サービスアカウントとJSON鍵を準備し、補助コマンドで取り込みます。
- iOS対象: [Appleのブラウザ手順](setup/APPLE.md)を実行します。本人のチーム、本体・通知拡張のApp ID、APNs鍵を準備し、ローカル署名設定を生成します。iOSはAPNsへ直接送るためFirebaseのiOSアプリ登録やFirebaseへのAPNs鍵アップロードは不要です。

秘密情報の保存先は既定で `.oyobidashi/keys/`、relay設定は `.oyobidashi/config.json`。ディレクトリ700・ファイル600で保存します。`OYOBIDASHI_HOME` を明示した場合はその位置を全コマンド・relay・MCPで統一してください。外部ディレクトリを使う場合もgit管理しません。

### 4. ビルド・インストールする

```sh
# サーバーとMCP
bun test --cwd relay
bun test --cwd mcp
bun test --cwd integration
# iOS共通処理
swift test --package-path ios/OyobidashiKit
# iOS: Appleの取り込み後
xcodegen generate --spec ios/project.local.yml
xcodebuild -project ios/Oyobidashi.xcodeproj -scheme Oyobidashi \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
# Android: JDK17のJAVA_HOMEを指定して実行
android/gradlew -p android :core:test :app:testDebugUnitTest :app:assembleDebug
```

Apple未設定のシミュレータ検証だけなら `xcodegen generate --spec ios/project.yml` が使えます。実機へはローカルspecを使って生成し直し、XcodeでAppleアカウントを追加、正しいチーム・端末を選択して自動署名でRunします。CLIで署名する場合は実際の端末UDIDを調べ `-destination 'id=DEVICE_UDID' -allowProvisioningUpdates` を使い、ビルドしたappを端末ツールでインストールします。端末の信頼・Developer Mode・ロック解除が必要なときだけ本人へ操作を依頼します。

Androidは `adb devices -l` で対象serialを確認し、`adb -s SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk`。複数端末時に無指定でインストールしません。無線ADBはユーザーが表示したペアリング先と接続先を区別します。初回の `adb pair HOST:PAIR_PORT` と `adb connect HOST:CONNECT_PORT` は別で、コードは本人入力を優先します。

### 5. relay・MCP・ペアリングを仕上げる

relayを起動し、ログをgit管理外に置いてhealthを確認します。8787が他の作業で使われていればそのrelayが同じ状態ディレクトリかを確認し、無関係なプロセスを停止しません。別ポートを選ぶと設定に保存されます。

```sh
./scripts/dev.sh
# 別ターミナル
curl --fail http://127.0.0.1:8787/healthz
./scripts/setup.sh mcp --client both
./scripts/pair.sh
```

MCPは使用するクライアントだけなら `--client claude` または `--client codex`。プロジェクトローカルの `.mcp.json` / `.codex/config.toml` に絶対パスと `OYOBIDASHI_HOME` を保存します。既存の他の設定は残し、同名サーバーが異なる接続先ならエラーにして上書きを止めます。エージェントが既存値を確認して必要箇所を統合してください。ユーザーのグローバル設定を一括置換しません。

Codexの[プロジェクト設定](https://developers.openai.com/codex/config-basic/)は、信頼済みプロジェクトで読み込まれます。クライアントを再読み込みし、Claudeの `/mcp` またはCodexのMCP一覧に `oyobidashi` が接続済みで表示されることを確認します。Claudeの初回MCP承認・Codexのプロジェクト信頼が必要なら、そのUIを案内します。補助スクリプトを起動できるBunのPATHも確認してください。詳細な手動登録は[mcp/README.md](../mcp/README.md)。

スマホとMacを同じWi-Fiに接続し、QRまたは手入力でペアリングします。QR・コードを公開ドキュメントや会話へ転記しません。端末で通知、iOSのローカルネットワーク、音声用マイク・音声認識、Androidの全画面着信等を許可します。AIが端末UIを操作できなければ、必要なタップだけまとめて依頼します。

### 6. 実MCPから確認する

利用中のクライアントのMCPツールを使います。MCPを再読み込みできない間は、次の実stdioドライバーでもサーバーまでの確認ができます (クライアント登録の確認とは分けて記録)。

```sh
bun run integration/manual-mcp.ts get_human_status '{}'
bun run integration/manual-mcp.ts ask_human '{"question":"セットアップの確認です。受信できましたか？","choices":["受信できました"],"priority":"low","delivery_mode":"actions","wait_seconds":0}'
```

返った `request_id` を使い、`wait_for_answer` で回答を確認します。テスト通知を残さず、未解決の質問は `cancel_request` で取り消します。APIを直接叩いただけでMCP検証済みとしません。

対象OSごとに次を確認し、確認方法・結果をチェックポイントへ記録してください。

1. アプリ前面の質問受信、選択回答、テキスト返信がMCPへ戻る。
2. アプリをホームへ戻した状態のPush着信。WebSocket経由の通知と区別し、FCM/APNsの送信結果・OS通知を確認する。iOSはスワイプ強制終了後のサイレントPush受信を前提にしない。
3. テスト質問を取り消し、アプリを開かず通知が消えるか確認。iOSのサイレントPushはOS制約で即時保証がなく、復帰時の一覧照合も別途確認する。残った場合は成功扱いしない。
4. Claude音声プロバイダーを準備できた場合、本人へ試験開始を伝えてから着信→応答→声の回答→MCP返却→お礼後の自動終話。途中終了→テキスト通知→返信も確認する。検証用の通話は `priority: high, delivery_mode: call` を明示する。
5. 両OSを同時ペアリングした場合、一方の応答で他方の着信が停止することも確認する。通話取得後の切断は同じ通話を他端末で再開せずテキストへ移る。仕様は[拡張プロトコル](EXTENSIONS.md)を参照する。

端末や本人の発話が必要な工程は理由を示して待ち、確認を省略して「全部完了」と報告しません。シミュレータ・エミュレータだけの確認と実Push実機の確認を区別します。

## トラブル対応と完了報告

補助スクリプトが失敗したら、入力パス、対象package/project、鍵の形式、ファイル権限、既存設定の競合を確認します。パースエラーで鍵を表示させたり `cat config.json` を会話へ流したりしません。`./scripts/setup.sh doctor` で不足の種類を絞り、設定更新後はrelayを再起動、AndroidのFirebase変更後は再ビルド・再インストールします。

Pushの401/403はAPI有効化・FCMロール・鍵/Team ID/topicを確認。APNs `BadDeviceToken` / `DeviceTokenNotForTopic` はBundle ID、開発/本番、端末再登録を確認します。APIキー制限を変更する必要があれば、まず対象Firebaseアプリ用の制限を調べ、無関係な保護を解除しません。ダウンロードできないAPNs鍵は再取得できません。既存の有効鍵を勝手に失効させず、必要なら本人と移行先を決めます。

最後に、対象OS、実際に使用したプロジェクト/Team/Bundle ID、起動コマンドと停止方法、MCPの接続状態、実行したテスト、未確認・阻害された工程を簡潔に報告します。秘密値は含めません。ブラウザのログイン待ちやApple未加入が残る場合も、独立した準備を終えて再開点を明示します。

## 補助スクリプトの開発

`bun test scripts/setup-local.test.ts`。テストは一時ディレクトリと実行時生成の鍵を使い、実アカウントや現在のrelay設定は変更しません。スキル入口の詳細手順はこの文書へ集約し、両方のSKILL.mdへ手順をコピーしないでください。
