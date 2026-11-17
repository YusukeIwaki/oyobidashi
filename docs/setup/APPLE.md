# iOSのApp ID / APNs / 署名をAIが用意する

前提: [ブラウザ操作](BROWSER.md)を読んで接続済み。Push・PushKit/CallKitの実機確認には有効なApple Developer Programチームが必要です。未加入なら加入/支払いを勝手に進めず、Androidと署名なしビルドを進め、iOS Pushは未完了とします。

## 1. 本人のチームとBundle ID

1. [Apple Developer Account](https://developer.apple.com/account/)を開き、ログイン/2FAは本人に入力してもらいます。Membership details等で選択チーム・10文字のTeam IDを確認します。チームが複数なら既存指定を優先し、不明なら本人に選んでもらいます。
2. 最新契約への同意が必要で操作できない場合、該当画面を本人へ引き継ぎます。完了後に同じ画面から再開します。
3. 既定のBundle IDは `me.oyobidashi.ios` です。別チームでこのIDを取得できない場合は、本人が所有する名前空間のIDを使います。指定がなければ例として `dev.oyobidashi.team<小文字のTeam ID>` を候補にし、空きをコンソールで確認します。作者のIDを取得するために既存登録を削除したりしません。
4. 本体を `BUNDLE_ID`、通知拡張を `BUNDLE_ID.NotificationService` とします。両方をチェックポイントに記録します。

## 2. IdentifiersとCapabilities

Certificates, Identifiers & Profiles → Identifiersで次を確認・作成します。

- 本体: App IDs → App → 明示的な `BUNDLE_ID`。**Push Notifications** と **Time Sensitive Notifications** を有効にします。既存App IDを使う場合は不足分だけ追加します。
- 通知拡張: 明示的な `BUNDLE_ID.NotificationService` を登録します。通知の拡張処理用です。本体と同じチームで署名し、不要なPush証明書は発行しません。

現在のアプリは `voip, remote-notification, audio` のbackground modesとPushKit/CallKitを使います。通常通知トークンとVoIPトークンを分け、VoIPは `BUNDLE_ID.voip` topicで送ります。Push-to-Talkは別機能なので有効化しません。通知取り消しのために偽のVoIP着信を送る構成へ変えません。

## 3. APNs認証鍵

1. Keys一覧と手元の設定を調べ、利用可能なAPNs `.p8` があればTeam ID・Key ID・topic・環境を確認して再利用します。既存のダウンロード済み鍵はコンソールから再取得できません。
2. 新規作成が必要ならKeys → Addで開発用途がわかる名前を付け、**Apple Push Notification service (APNs)** を選択します。
3. コンソールで環境とキーのスコープを確認します。**ローカルのDebug実機用はSandboxのTeam Scopedキー**を基本にし、本体とVoIPのtopicを送れることを確認します。新しいキーには環境制限があります。既存の両環境対応キーが手元にあれば再利用できますが、新規に必ず両環境対応を選べるとは限りません。Topic Specificを使う場合は通常の `BUNDLE_ID` と `BUNDLE_ID.voip` の送信をカバーできることが必要です。現在のrelay設定は鍵1組なので、Production/TestFlightとの同時運用を追加する場合は別途構成を検討します。このセットアップではProduction鍵を余分に発行しません。
4. 登録後、10文字のKey IDを記録し、`.p8` をダウンロードします。ダウンロードは一度だけです。上限に当たっても無関係な鍵を失効させません。
5. ファイルを安全に取り込みます。引数の値は実際に確認したものへ置き換えてください。

```sh
./scripts/setup.sh apple \
  --team-id YOURTEAMID \
  --key-id YOURKEY_ID \
  --key-file '/absolute/path/to/AuthKey_YOURKEY_ID.p8' \
  --bundle-id 'your.own.oyobidashi'
xcodegen generate --spec ios/project.local.yml
```

`YOURTEAMID` / `YOURKEY_ID` は説明用で、実行時は英大文字・数字10文字を使います。補助スクリプトはP-256鍵を検証し、`.oyobidashi/keys/AuthKey_<Key ID>.p8` とrelayの `apns` を保存します。設定は `key_path/key_id/team_id/bundle_id` で、`bundle_id` は `.voip` や拡張のsuffixを付けない本体IDです。

## 4. ローカル署名とインストール

補助スクリプトはgit管理外の `ios/project.local.yml` も生成します。共有 `project.yml` をincludeし、両ターゲットの署名チームとBundle IDだけを上書きします。共有設定には特定の開発チームを固定しません。自動署名でプロファイルと証明書を準備します。

XcodeにAppleアカウントを追加し、生成した `ios/Oyobidashi.xcodeproj` を開きます。本体と通知拡張のTeam/Bundle ID、PushとTime Sensitiveのentitlements、インストール先を確認します。本人のiPhoneを接続し、信頼・Developer Mode・ロック解除を済ませてRun。CLIの場合も自動署名を許可し、別チームの既存プロファイルを流用しません。Appleのサインイン情報をplistや環境変数へ保存しません。

アプリはDebugならdevelopment、Releaseならproductionをrelayへ登録します。実際の署名・プロファイルのAPNs環境と一致するかを確認し、通常APNs/VoIPの両トークンが登録されたことを確認します (トークン値は出力しません)。relayを再起動して[共通手順](../SETUP.md)の実機確認へ戻ります。

XcodeGenはInfo.plist等も再生成します。ローカル専用の識別子を追跡ファイルへ書き込む独自変更は不要です。`git diff` を確認し、本人のチーム設定・鍵・生成プロジェクトがコミット対象になっていないことを確認してください。

公式資料: [App IDの登録](https://developer.apple.com/help/account/identifiers/register-an-app-id/)、[Capabilityの有効化](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/)、[APNs鍵の作成・一度限りのダウンロード](https://developer.apple.com/help/account/keys/create-a-private-key/)、[APNs token認証](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[環境・topic制限](https://developer.apple.com/news/?id=wy4tb0uo)、[XcodeGen include](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md#include)。
