# oyobidashi Android アプリ

初回は[AIに任せるセットアップ](../docs/SETUP.md)を使えます。[Firebaseのブラウザ手順](../docs/setup/FIREBASE.md)に、プロジェクト作成からサービスアカウントJSON取得・取り込みまでまとめています。


> v0.2: 通話・在席フィードバック・通知取り消しを追加しました。[全体の起動方法と制限](../README.md)、[拡張プロトコル](../docs/EXTENSIONS.md)を参照してください。既定はLAN内、明示したHTTPSプロキシ経由でも利用できます。

AI コーディングエージェント (Claude Code / Codex) からの質問をスマホで受け取り、テキスト・音声・選択肢で回答するアプリです。
通信仕様は [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) に従います。

クラウド中継にも同じペアリング操作で接続できます。HTTPS/WSSで接続し、端末トークンで自分の質問だけにアクセスします。[クラウドの通信・復旧契約](../docs/CLOUD_PROTOCOL.md)に従い、発話ごとにUUIDを付けて送信し、202応答後は結果を非同期に取得します。無言・読み上げ中は会話ジョブを実行しません。従来のLAN relayによる200応答も利用できます。

クラウドPushの本文は汎用のお知らせです。端末認証を使って最大3秒で質問を取得し、同じ通知を本文・選択肢付きに更新します (再度の通知音は鳴らしません)。取得できない場合は汎用通知を残し、未取得の質問への回答ボタンは表示しません。回答済みなら通知を取り消し、別のアカウント宛ての遅延Pushや取得結果は破棄します。

送信結果を失った場合は同じUUIDの結果を先に取得し、対応サーバーでのみ同じUUIDを再送します。待機は250ms〜2秒のバックオフ、全体95秒、連続通信失敗とPOST再試行は最大3回に制限します。確定した発話とUUIDを送信前に下書きへ永続化し、失敗・プロセス再起動後も復旧します。最終応答の読み上げが終わるまで通話を保持し、自動再発信はしません。

- applicationId・namespace・Kotlinのルートpackage: `me.oyobidashi.android` / minSdk 26 / targetSdk 35
- Kotlin + Jetpack Compose (Material 3)

ソースとテストは`src/*/kotlin/me/oyobidashi/android/`に配置します。applicationIdを変更すると旧版とは別アプリになります。Firebaseでは新しいpackage nameでAndroidアプリを追加し、そのApp IDをローカル設定へ反映して、新アプリでペアリングし直してください。旧Firebase登録や旧アプリのデータは削除する必要がありません。

## 構成

| モジュール | 内容 |
|---|---|
| `core/` | 純 Kotlin/JVM。契約のモデル (kotlinx.serialization)、`RelayClient` (OkHttp)、ペアリングURIパーサ、WebSocket イベントクライアント (再接続/バックオフ)、FCM ペイロードパーサ、状態ロジック (`RequestsRepository`)、通知からの直接返信ロジック (`DirectReplyHandler`)とそのユニットテスト |
| `app/` | Android 層。Compose UI、通知 (`AndroidNotifier`)、FCM サービス、`ReplyReceiver`、EncryptedSharedPreferences、CameraX + ML Kit の QR 読み取り、SpeechRecognizer |

## 必要なもの

- JDK 17
- Android SDK (compileSdk 35)。`ANDROID_HOME` を設定するか、`android/local.properties` に書きます (git 管理外):

```properties
sdk.dir=/Users/<you>/Library/Android/sdk
```

Gradle は同梱の wrapper (`./gradlew`, Gradle 8.11.1) を使います。

## ビルド・テスト・インストール

```sh
cd android
./gradlew test            # core と画面遷移の JVM ユニットテスト
./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug    # 接続中の端末/エミュレータにインストール
./gradlew lint            # 任意
```

## 使い方 (既定はLAN内)

既定の中継サーバー (relay) はLAN内で動きます。**スマホを Mac と同じWi‑Fi (同一LAN) に接続**して使います。

1. Mac で relay を起動し、ペアリング用のQRコード (`oyobidashi://pair?url=http%3A%2F%2F192.168.x.x%3A8787&code=…`) を表示する
2. アプリで次のいずれかを行う
   - 「QRコードを読み取る」でQRを読む
   - `oyobidashi://pair?...` のリンクを開く (確認ダイアログが出ます)
   - URL (例 `http://192.168.1.10:8787`) とコードを手入力する
3. 以後、エージェントからの質問が通知され、通知から直接返信するか、アプリで回答できます

- 接続は平文の `http://<MacのプライベートIP>:8787` / `ws://…` です。そのため **debug / release の両方で cleartext 通信を許可**しています (`usesCleartextTraffic` と `res/xml/network_security_config.xml`)。`https://` のURLも使えます (WebSocket は `wss://` になります)。
- Mac のIPアドレスが変わったら、ペアリングし直してください。
- LANのみのrelayは外出先から届きません。FCMを設定していれば通知は鳴りますが、回答時は「中継サーバーに接続できません。ネットワーク接続を確認してください」と表示されます。クラウド中継またはHTTPS経路を設定した場合は外出先からも接続できます。入力した回答 (通知からの返信を含む) は下書きとして端末に保存され、接続が戻るとそのまま「送信」できます (自動送信はしません)。

## プッシュ通知 (FCM) の設定 — 任意

ビルドで `google-services.json` と google-services Gradle プラグインは **使いません**。ダウンロードしたJSONを `./scripts/setup.sh firebase` へ渡すと、以下の値を安全に転記できます。Firebase の値が無くてもビルド・起動でき、その場合は
アプリを開いている間 (WebSocket 接続中) だけローカル通知が出ます。

アプリを閉じていても通知を受けたい場合は、Firebase プロジェクトに Android アプリ (`me.oyobidashi.android`) を追加し、
`google-services.json` に書かれている値を `android/local.properties` に転記します:

```properties
oyobidashi.firebase.projectId=<project_info.project_id>
oyobidashi.firebase.applicationId=<client[].client_info.mobilesdk_app_id   例 1:1234567890:android:abcdef>
oyobidashi.firebase.apiKey=<client[].api_key[].current_key>
oyobidashi.firebase.senderId=<project_info.project_number>
```

(`-Poyobidashi.firebase.projectId=…` のように Gradle プロパティで渡すこともできます。) 4つすべてが揃ったときだけ Firebase を初期化します。
値は BuildConfig に埋め込まれ、起動時に `FirebaseApp.initializeApp` へ渡されます。設定画面の「通知サービス」で利用可否を確認できます。通知・マイク・カメラ・音声認識・全画面着信の再設定も、アプリの「設定」→「権限」から行えます。

relay 側には、同じ Firebase プロジェクトのサービスアカウント JSON を `config.json` の `fcm.service_account_path` に設定します。ルートの補助スクリプト利用時は `.oyobidashi/config.json`、relay CLIを直接使う場合は `~/.oyobidashi/config.json` です。`setup.sh firebase` ならrelayも同時に設定します。

FCM トークンはペアリング時 (`POST /v1/pair` の `push_token`)、起動時・フォアグラウンド復帰時、および `onNewToken` で
`PUT /v1/devices/me` により登録されます。

## 通知

- relay は FCM の **data メッセージ**だけを送り、通知はアプリが組み立てます。
- 質問: 「エージェントからの質問」チャンネル (重要度: 高、音・バイブレーション)。
  - 「返信」アクション (RemoteInput) で通知から直接回答できます。
  - 選択肢があれば選択肢ボタンが付きます。Android の通知に表示できるアクションは3つまでなので、
    選択肢が 0〜2 個なら「選択肢 + 返信」、ちょうど 3 個なら「選択肢3つ」(自由入力はアプリで)、4 個以上なら「返信」のみ (選択肢はアプリで) になります。
  - 送信に失敗した場合は通知が「回答は送信されていません…」に更新され、入力内容はその質問の下書きに保存されます。
- お知らせ (`kind: notification`): 「エージェントからのお知らせ」チャンネルの通常の通知。
- 質問が回答済み・取り消し・期限切れになったことをアプリが知ると (WebSocket / 一覧取得)、通知は自動で消えます。

## 権限

| 権限 | 用途 | 求めるタイミング |
|---|---|---|
| `POST_NOTIFICATIONS` (Android 13+) | 質問の通知 | ペアリング後、一覧画面を最初に開いたとき |
| `RECORD_AUDIO` | 音声入力・通話 (`SpeechRecognizer`) | 音声入力または通話へ初めて応答するとき。設定から再設定可能 |
| `CAMERA` | ペアリングQRコードの読み取り | 「QRコードを読み取る」を最初に押したとき |
| `INTERNET` / `ACCESS_NETWORK_STATE` | relay との通信、ネットワーク復帰時の自動再接続 | (実行時の許可は不要) |

拒否しても、QR は手入力で、音声入力はキーボードで代替できます。

## 画面・戻る操作

ホームは状態と未回答の通知、設定はペアリングと権限の確認・再設定を表示します。Material 3と端末のダイナミックカラーを使用し、ライト・ダーク表示に対応しています。

再ペアリングからは設定、設定・質問からはホームへ戻ります。QR読み取り中はまず読み取り画面を閉じ、キーボードや確認ダイアログの表示中はそれらを先に閉じます。ホームで戻るとAndroidのランチャーへ戻ります。

画面遷移の単体試験は、リポジトリのルートから `android/gradlew -p android :app:testDebugUnitTest` で実行できます。実機での戻る操作・表示の確認記録は[検証結果](../docs/VALIDATION.md#android-material-3戻る操作-2026-11-16)を参照してください。

## 回答の `input_method`

- 選択肢ボタン (アプリ内・通知) → `choice` (`choice_index` つき)
- 音声入力で入ったテキスト (送信前に手で直しても) → `voice`
- それ以外 (キーボード入力、通知の「返信」) → `text`
