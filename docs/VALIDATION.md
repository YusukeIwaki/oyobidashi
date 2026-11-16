# 検証結果

2026-11-16 (Asia/Tokyo)。参考アプリの移植後、実際のBun中継・stdio MCP・ネイティブアプリを使用して確認しました。テスト用の画面データや架空の成功応答を製品に追加していません。

## 自動試験・ビルド

| 対象 | 実行 | 結果 |
|---|---|---|
| relay | `bun test --cwd relay` | **548 pass / 0 fail** |
| MCP | `bun test --cwd mcp` | **232 pass / 0 fail** |
| iOS Kit | `swift test --package-path ios/OyobidashiKit` | **187 tests / 1 skip / 0 fail** |
| Android core | JDK17で `android/gradlew -p android :core:test` | **186 tests / 1 skip / 0 fail** |
| 実サーバー結合 | JDK17で `bun test --cwd integration` | **18 pass / 0 fail** |
| TypeScript | relay / mcp の `tsc --noEmit` | 成功 |
| iOSアプリ + Notification Service Extension | XcodeBuildMCP、iPhone 17 / iOS 27.0 | ビルド・インストール・起動成功 |
| iOS実機向け署名 | `xcodebuild -destination generic/platform=iOS -allowProvisioningUpdates build` | 本体・通知拡張の開発署名付きビルド成功、署名検証成功 |
| Androidアプリ | `:app:assembleDebug`、API36 Google Play ARM64 | APK生成・インストール・起動成功 |

単体試験のskipは、環境変数で実サーバーを指定して走らせるLiveRelay試験です。両OSとも別途結合試験で実サーバーに接続して実行しています。SwiftのコンパイルにはCallKit/AVAudioSessionの非推奨API警告が残っています (iOS17互換)。

結合試験は実際の中継プロセス・stdio MCP・iOS URLSession・Android OkHttpを使用し、ペアリング、選択/テキスト/音声としての回答、取り消し、同時回答、再起動後の永続化、在席によるチャネル変更、優先度変更、拒否フィードバック、一方向通知取り消しを検証します。`human://status`の読み取り・購読・更新通知・購読解除も実クライアントで確認しました。

## 画面・Pushを含む確認

| 環境 | シナリオ | 結果 |
|---|---|---|
| iOS Simulator | 深いリンクでペアリング → 通常起動 → 未回答一覧 | 成功 |
| iOS Simulator | 選択ボタンから回答 → MCPにchoice_index付きで返却 | 成功 |
| iOS Simulator | 背景の説明 → 返信画面で長い文章を入力 → MCPへ全文返却 | 成功 |
| iOS Simulator | 開いている質問をエージェントが取り消す | 送信UIが閉じ、取り消し状態を表示 |
| iOS Simulator | 通話のアプリ内代替画面 → 拒否 | pending/textへ移行、MCPにdeclined |
| iOS Simulator | 「30分取り込み中」を設定 → urgent/callで質問 | textへ切り替え |
| iOS Simulator / APNs sandbox | 実際のAPNsへ通常通知・VoIP通知を送信 | 両方ともAPNs成功応答。`apsd`で通常/`.voip`トピックの受信、SpringBoardで通常通知と2アクションの登録を確認 |
| Android Emulator | QRと同じペアリングURI → 通常起動から未回答一覧 | 成功 |
| Android Emulator | アプリをバックグラウンドへ → **実際のFCM** → 通知の選択ボタン | MCPに「回答できました」/choice_index=0が返却 |
| Android Emulator | 通知以外から起動 → テキスト画面で返信 | 入力した全文がMCPに返却 |
| Android Emulator | 実FCM着信 → Android Telecom | `self_mng`, `voip=true`, `RINGING`、CallStyleのAnswer/Declineを確認 |
| Android Emulator | 標準着信通知のDecline | 端末ID付きdeclinedをMCPで確認、質問はtextとして継続 |
| Android Emulator | Answer → マイク許可 → foreground service | 通話中画面・TTSエンジン接続を確認 |
| Android Emulator (音声出力なし) | Answer → 通話画面の「切断」 | MCPに端末ID付き`hangup`、質問はpending/textへ移行。実音声の往復は対象外 |
| Android Emulator | バックグラウンドの一方向通知をMCPから取り消し | OSのNotificationRecordが **1件→0件**。アプリの一覧更新だけによる代替ではありません |
| Claude Code | 実際のサブスクリプション認証で質問/人間の回答を構造化判定 | 約3.3秒で `resolved:true` と回答要約、終話のお礼を返却 |

Androidの長文入力はエミュレータ上の高速キーボード注入で文字の取りこぼしがあったため、各入力を確認し、通常の入力速度で全文を確認してから送信しました。製品内のテキスト欄も即時の編集状態を保持します。確認した返信: “Announce today. Start at 10am. Check error rates before continuing.”

![iOS 未回答一覧](evidence/ios-inbox.png)
![iOS シミュレータの着信代替画面](evidence/ios-incoming-call.png)
![Android 実FCMの通知](evidence/android-notification.png)
![Android Telecomの着信通知](evidence/android-call.png)

通知の画像は検証途中のものです。最終版のactionsモードは選択ボタンのみを表示します。

## iPhone実機の追加確認 (2026-11-16)

iPhone 16 Pro / iOS 26.7.2へ開発署名付きアプリをインストール・起動し、ユーザー操作でペアリング、通知・マイク・音声認識の許可を設定しました。通常APNs / VoIPトークンは実機から別々に登録されました。

| シナリオ | 確認できた結果 |
|---|---|
| CallKit着信・応答 | 実機の標準着信バナーを撮影。端末ログで`voip_received` → `answer_action` → `audio_activated`を確認 |
| 実音声の回答 → Claude → MCP | 「明日の午前10時に始めてください」が認識され、`input_method: voice` / `answered` / `outcome: resolved`として返却 |
| お礼後の自動終話 | `final_reply_finished`の後に`phase=ended`・CallKitの`reason=resolved`を確認。ユーザーもお礼後の自動終話を確認 |
| 応答後の画面 | 表示されない不具合を修正し再インストール。再試験で質問と赤い終了ボタンを表示する画面を撮影し、ユーザーも正常と確認。終話後は一覧へ復帰 |
| アプリを離れて着信 → 途中終了 → 通知 | ユーザーがホーム画面に戻してから着信。応答・読み上げの後に手動終了し、`hangup`と実機の端末ID、`pending` / `delivery_mode: text`をMCPで確認。実機で同じ質問の通知バナーを撮影 |
| 切り替わった通知 → テキスト返信 → MCP | ユーザーが通知から質問を開いて返信。`input_method: text` / `answered`で「明日の10時。午前」がMCPに届き、ユーザーにも入力内容との一致を確認 |

初回にWebSocketとVoIP Pushの同じUUIDの報告が競合し、代替画面が重なる問題を発見しました。CallKitの`callUUIDAlreadyExists`を既存着信の継続として扱うよう修正し、再試験では重複する代替画面が出ないことを確認しました。通話関連の回帰試験は51件成功・失敗0件です。音声権限は着信中の初回ダイアログを避けるため、一覧・設定から事前に許可できるようにしました。

応答後の通話画面には質問、読み上げ・聞き取りの状態、認識中の字幕、終了ボタンを表示します。アプリ内の終了ボタンからもCallKitの終了アクションを通し、同じ途中終了処理を使用します。

![実機のCallKit着信](evidence/ios-device-callkit.png)
![応答後の実機通話画面](evidence/ios-device-active.png)
![途中終了後のテキスト返信通知](evidence/ios-device-hangup-notification.png)

最終確認リクエスト: 音声解決 `req_01M7GYKJS18HG2QTWNEQ346P1T`、途中終了後のテキスト回答 `req_01M7GYPJWTK3DCFG9W84RABVXK`。両試験とも本物のstdio MCPと中継を使用しました。音声解決では実機のマイク・音声認識・Claude・読み上げ・CallKitを経由しました。テスト用未回答リクエストは残っていません。

## 複数端末・通知取り消しの追加確認 (2026-11-16)

同じ中継にペアリングした端末へ配信する1対多構成です。最初の応答端末が通話を所有し、他端末の応答・発話は中継が拒否します。

| シナリオ | 実動作で確認した結果・限界 |
|---|---|
| Android Emulatorで応答 → iPhoneの着信停止 | 両端末の着信画面を確認し、Androidの標準Answerボタンを操作。実機ログに同じrequest IDの`reason=answeredElsewhere`が記録され、ロック中のiPhoneからCallKit着信画面が消えた。Android側はその直後に`failed`へ移行したため、音声通話継続の成功としては数えない |
| iPhoneで応答 → Androidの着信停止 | AndroidのAnswer/Decline通知を撮影後、ユーザーがiPhoneで応答。MCPで実機が所有する`active`通話の継続を確認した時点で、Androidの通知は0件となり、Telecomは10:38:00の`RINGING`から10:38:03の`DISCONNECTED`へ移行。その後エージェントが取り消し、iPhoneの標準通話画面にも「終了」を確認 |
| エージェントが未回答の質問を取り消す → iPhone通知削除 | 上記のテキストへのフォールバック通知をMCPで取り消し、iPhoneの通知センターから消えることを画面で確認 |
| 一方向のお知らせを取り消す (初回) | ユーザーが通知の残存を確認。不具合を発見: `kind=notification`を全状態で削除対象から除外していた |
| 修正後、一方向のお知らせを取り消す | 再インストール後、ユーザーがアプリを一度開いてホームへ戻った状態で実APNs配信。ロック画面上の通知を確認してからMCPで取り消し、アプリを開かずに通知が消えたことを前後の実機画面で確認 |

一方向のお知らせは`notified`のときだけ表示を維持し、`cancelled`等なら削除するよう修正しました。WebSocket更新と、未取得の通知をHTTPで取得する経路の両方に回帰試験を追加し、修正前の失敗・修正後の成功を確認しました。また、取り消し等のAPNs更新を受けた時点で通知を削除し、中継への再取得を待たないようにしました。Swift全185件・skip1件・失敗0件、実機向けビルド成功です。

識別子: Androidから応答 `req_01M7GZ7FRCFPN7SNEJ0J288YY1`、iPhoneから応答 `req_01M7H021PQ6XVCQM77G3ND7A7W`、初回不具合 `req_01M7GZCDKHM22F7BN4XNAH3P0N`、修正後通知取消 `req_01M7GZRQG7X5GYXQBYQ1WC9P9E`。端末間の着信停止は両方向で確認しました。Androidは音声出力なしの専用QAエミュレータです。

![両端末への配信時のiPhone着信](evidence/ios-multidevice-incoming.png)
![Android応答後、iPhoneの着信画面が閉じた状態](evidence/ios-multidevice-ended.png)
![逆方向確認のAndroid着信](evidence/android-multidevice-incoming.png)
![iPhone応答後、Androidの着信通知が消えた状態](evidence/android-multidevice-ended.png)
![iOS通知の取り消し前](evidence/ios-notification-cancel-before.png)
![iOS通知の取り消し後](evidence/ios-notification-cancel-after.png)

## ホーム・設定画面の整理 (2026-11-16)

iOS・Androidのホームを「あなたの状態」と「未回答の通知」に絞りました。アプリ名を繰り返す見出し・装飾、履歴一覧を削除し、状態変更はホームに集約しています。設定は接続先・再ペアリング・権限の確認と再設定・バージョンを表示します。

| 環境 | 確認内容 | 結果 |
|---|---|---|
| iOS Simulator / Android Emulator | ホーム・設定を表示 | ホームに状態と未回答のみ表示。設定に状態変更・履歴の表示なし |
| 両OS | 設定 → 再ペアリング → 閉じる / 戻る | 既存のペアリングと接続を維持 |
| iOS Simulator | 設定からマイク・音声認識を初回許可 | OSダイアログから許可でき、設定画面の状態も「許可済み」に更新 |
| Android Emulator | 設定からOSの通知設定を開き、無効化 → 再度有効化 → アプリへ戻る | 「未許可」「許可済み」が反映。再有効化後の確認用通知も受信 |
| 両OS + 実stdio MCP | 低優先度の選択回答を配信し、iOSで回答 | 両OSのホームに表示。MCPへ選択結果が返り、両OSのホームから消える。履歴表示なし |
| 両OS + 実stdio MCP | テキスト質問を配信し、MCPから取り消す | 両OSのホームに表示された後、取り消しで消える。履歴表示なし |
| ビルド・インストール | iOS Simulator・iPhone実機向け、Android debug | すべてビルド成功。iPhoneとAndroid QAエミュレータへインストール済み |

iOS Simulatorでは権限の「設定」ボタンからOSの設定アプリを開けましたが、iOS 27 Simulatorはアプリ個別画面ではなく設定のトップ画面へ遷移しました。個別設定への遷移は実機での確認が残っています。OSの公開設定URLを使用しています。

今回のUI確認では通話・中継のロジックを変更していません。通話の実機確認結果は前の節を参照してください。確認用の質問はすべて回答または取り消し済みです。

![iOS ホーム](evidence/ios-home-simplified.png)
![iOS 設定](evidence/ios-settings-simplified.png)
![Android ホーム](evidence/android-home-simplified.png)
![Android 設定](evidence/android-settings-simplified.png)

## 状態変更の競合と表示 (2026-11-16)

iOSでは、状態取得の開始後に利用者が状態を変えると、遅れて届く取得結果で新しい選択を巻き戻す競合がありました。操作の世代とペアリングを照合し、古い取得結果を反映しないよう修正しました。送信失敗時も選択を保持し、再送信できます。送信中は追加操作を無効にし、共有中の表示を出します。両OSとも、選んだ状態に合わせて連絡方法の説明を更新します。

- 回帰試験で「離席中」が古い取得結果の「対応可」に戻る失敗を再現し、修正後の成功を確認しました。通信失敗後の再取得で選択を保持し、再送信でエラーが消えることも検証しています。Swift全187件・skip1件・失敗0件。
- iOS Simulator / Android Emulatorで、対応可・取り込み中・離席中の選択と説明表示を確認し、実stdio MCPの`get_human_status`で反映を確認しました。
- 取り込み中に`high/call`の質問を実MCPで作成し、`requested_mode: call` / `delivery_mode: text`になることを確認しました。確認用の質問は取り消し済みで、QA端末の状態は対応可に戻しています。
- iOS Simulator・iPhone実機向け・Android debugのビルド成功。iPhoneとAndroid QAエミュレータへ再インストール済みです。利用者がiPhoneで「離席中」の選択を確認し、実MCPでも当該iPhoneの`availability: away`を確認しました。
- 状態と誤認しやすかった常設の「30分取り込み中」ボタンを削除しました。iOSもAndroidと同じく、「取り込み中」を選ぶと30分間有効にし、その間だけ終了時刻を表示します。iOS Simulatorで選択後の期限が約1800秒であることを実MCPと照合し、「離席中」「対応可」へ変えると期限表示が消えることを確認しました。iPhoneへ再インストールし、「離席中」に余分なボタンが出ない画面も実機で確認しています。

![iPhone実機 離席中の表示](evidence/ios-presence-away.png)
![Android 離席中の表示](evidence/android-presence-away.png)

## Pixel 10a実機の確認 (2026-11-16)

Pixel 10a / Android 17 / API 37へWi-Fi ADBで接続しました。SDKのPlatform Toolsは37.0.1がインストール済みで、安定版の更新チェックを実行しました。Homebrew側も37.0.0から37.0.1へ更新し、双方のADBのバージョンを確認しています。ADBサーバーの再起動後、実機への接続・APKのインストールに成功しました。[Android公式のADB Wi-Fi 2.0対応情報](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)。

音声試験は、iPhoneの「離席中」を維持するため、Pixelだけをペアリングした一時的な中継で実施しました。実FCMとログイン済みClaude CLIを使用し、試験後はPixelを通常の中継へ戻しています。

| シナリオ | 結果 |
|---|---|
| ペアリング・ホーム・設定 | 成功。通知・全画面着信・音声認識の利用可否を確認。初回応答時のOSダイアログからマイクを許可 |
| 状態変更 | 取り込み中と30分の期限、離席中、対応可が実MCPへ反映 |
| ホーム画面へ戻ってから実FCM着信 | Telecomのself-managed着信と、OSの応答・拒否ボタンを確認 |
| 応答 → 実音声 → Claude → MCP | 「明日の午前10時」が認識され、`input_method: voice` / `answered` / `outcome: resolved`として返却 |
| お礼後の自動終話 | 利用者が「お礼の後に自動終了」と確認。端末ログでも通話終了を確認 |
| 連続着信 | 2本目が前の通話の終了画面を表示する不具合を発見。`onNewIntent`でComposeの表示対象も更新するよう修正。前の終了画面を残した状態から次の着信に応答し、新しい質問と切断ボタンを実機で確認 |
| アプリ内で途中終了 | 切断ボタンから`hangup`が端末ID付きでMCPへ返り、同じ質問が`pending` / `delivery_mode: text`に移行 |
| 切り替わった通知 → 返信画面 → MCP | 通知から同じ質問が開き、`Start tomorrow at 10am, then send a text update.`の全文が`input_method: text`で返却 |
| 通知の選択ボタン | アプリを開かずに「確認できました」を選び、MCPへ`input_method: choice` / `choice_index: 0`として返却 |
| 一方向通知の保持・取り消し | 配信直後のHTTP照合で`notified`を消す不具合を発見・修正。再試験では通知が表示されたまま残り、MCPから取り消すと、アプリを開かずにOSのNotificationRecordが1件→0件となり、画面からも消えることを確認 |

通知の回帰試験では、未取消のお知らせをHTTP照合・hello・一覧更新で保持し、取り消し後だけ削除することを検証しました。修正前の2件の失敗を確認し、修正後はAndroid core全186件・skip1件・失敗0件です。debugビルド成功、最終APKをPixelへインストール済みです。

検証用MCPドライバーは`OYOBIDASHI_HOME`の指定に対応させ、通常の中継と分けて試験できるようにしました。試験データ・設定・ログはgitignore対象に置き、通知シェードに写った他アプリの情報はリポジトリに保存していません。

![Pixel実機 連続着信の2本目](evidence/pixel-call-active.png)
![Pixel実機 ホーム](evidence/pixel-home.png)

## 未確認・外部条件

- iOS実機では上記の通話・テキストへの切り替えを確認済みです。実APNsの選択肢ボタンによる回答は実機では未確認です (アプリ内選択回答はiOS Simulator、実Pushの選択回答はAndroid Emulatorで確認済み)。
- Androidの音声往復・自動終話・途中終了と通知への切り替えは、上記のPixel 10a実機で確認済みです。音声出力ありのAndroidエミュレータではQEMU2 main loop/CPU threadが停止してADBが切断される問題が残っています。エミュレータの音声試験を実機で代替しました。
- **音声はターン単位。** 全二重音声ストリーミング・発話での割り込みは未実装です。Claudeのサブスクリプションを使い、Geminiのキーは不要です。
- **外出先の通信経路は未設定。** HTTPS/WSSプロキシ対応とアクセス制御の試験・Caddy設定例は用意済みですが、公開ホスト名・証明書・実ネットワークの接続確認は残っています。
- iOSの通知削除を含むPush配信はOSのベストエフォートです。今回のバックグラウンド試験では削除を確認しましたが、圏外・強制終了・OS制限中の即時反映は保証しません。復帰時にサーバーと照合します。[Apple公式: background通知の配送は保証されない](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)。

## この作業環境の設定

- Firebase: `oyobidashi-7a842` (Spark)、Android登録ID `io.github.yusukeiwaki.oyobidashi`。
- `android/local.properties` / `android/app/google-services.json` は設定済み・gitignore対象。
- `.oyobidashi/config.json` はFCMをGoogle Cloud CLIの既存ログインで送る設定。新規サービスアカウント秘密鍵は作成していません。
- Apple Developer: Team `6KG5EF3BN2`、本体 `io.github.yusukeiwaki.oyobidashi` (Push Notifications / Time Sensitive Notifications有効)、通知拡張 `io.github.yusukeiwaki.oyobidashi.NotificationService` を登録済み。XcodeGenの署名チームも設定済みです。
- APNs: キー名 `Oyobidashi Push`、Key ID `7GS4U6H2LS`、APNsのみ・Sandbox & Production・Team Scoped。秘密鍵は `.oyobidashi/keys/` に移動し、鍵と設定ファイルは権限0600・gitignore対象です。中継再起動後、APNs / FCMとも有効です。
- `./scripts/dev.sh` / `./scripts/pair.sh` / `./scripts/mcp.sh` が同じローカル状態ディレクトリを使います。
- Android専用検証AVD: `oyobidashi_qa`。既存AVDのデータは消去していません。
