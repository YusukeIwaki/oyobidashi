# AndroidのFirebase / FCMをAIが用意する

前提: [ブラウザ操作](BROWSER.md)を読んで接続済み。FirebaseはAndroid用です。iOSのPushは[Apple側](APPLE.md)で設定します。

## 1. プロジェクトとAndroidアプリ

1. [Firebase Console](https://console.firebase.google.com/)を開き、ログインが必要なら本人へ引き継ぎます。選択アカウント・組織を確認します。
2. ユーザー指定またはチェックポイントのプロジェクトを再利用します。指定がなく既存の用途も判断できない場合は、開発用 `oyobidashi-dev` などの新規プロジェクトを作ります。表示名とProject IDは別で、IDの衝突時は短い一意の接尾辞を付け、実際のIDを記録します。Google Analyticsや有料プランはこの用途では追加しません。既存Google Cloudプロジェクトを利用する場合はそこへFirebaseを追加します。
3. Project settings → General → Your appsでAndroidアプリを探し、なければ登録します。package nameは **`me.oyobidashi.android`**。表示名は任意、FCMのみならSHA証明書の登録は不要です。
4. `google-services.json` をダウンロードします。ビルドへ直接置かず補助スクリプトへ渡します。このアプリはgoogle-services Gradleプラグインを使わず、4つの値をlocal.propertiesから読む実装です。コンソールの一般的なSDK追加例をそのままGradleへコピーしません。
5. Project settings → Cloud Messagingで **Firebase Cloud Messaging API (HTTP v1)** を確認します。無効ならManage API in Google Cloudから有効にします。サービス名は `fcm.googleapis.com`。Legacy APIや古いサーバーキーは使いません。

## 2. 送信用のサービスアカウントJSON

1. 同じプロジェクトの[Google Cloud Console](https://console.cloud.google.com/)を開き、IAM & Admin → Service Accountsへ進みます。プロジェクトIDを毎回確認します。
2. `oyobidashi-relay` などの専用アカウントを再利用、なければ作成します。プロジェクトに対する **Firebase Cloud Messaging API Admin (`roles/firebasecloudmessaging.admin`)** を付与します。一般のEditor/OwnerやFirebase全体のAdminは付与しません。service agent専用ロールも使いません。
3. 対象サービスアカウント → Keys → Add key → Create new key → JSONで作成・ダウンロードします。既存の有効なJSONが手元にあるなら新しく作りません。FirebaseのService accountsタブにも鍵生成ボタンがありますが、広い権限を持つ既定Admin SDKアカウントを使う前に専用アカウントを優先します。
4. ダウンロードされたJSONの内容を表示せず、Android設定と一緒に取り込みます。

```sh
./scripts/setup.sh firebase \
  --android-config '/absolute/path/to/google-services.json' \
  --service-account '/absolute/path/to/downloaded-service-account.json'
```

補助スクリプトはpackage、Firebase projectの一致、RSA秘密鍵の形式を検証し、次を生成/更新します。

- `android/local.properties`: `oyobidashi.firebase.projectId/applicationId/apiKey/senderId`。既存のSDKパス等は残します。
- `.oyobidashi/keys/fcm-<digest>.json`: サービスアカウントJSON (600)。鍵を会話に出さず同じファイルの再取り込みも可能です。
- `.oyobidashi/config.json`: `fcm.service_account_path`。APNsや既存のagent tokenは保ちます。

このrelayはFirebase Admin SDKではなくJSONのサービスアカウント鍵でOAuthトークンを作るため、`GOOGLE_APPLICATION_CREDENTIALS` やADCを設定する必要はありません。設定後はrelay再起動とAndroid再ビルド・インストールが必要です。

## 組織がJSON鍵の作成を禁止している場合

組織ポリシーを緩めません。現在のrelayは、ログイン済みGoogle Cloud CLIで送信する方式にも対応しています。ユーザーに代替方法と制限を説明し、選択された場合は本人のアカウントに同じFCM送信権限があることを確認します。

```sh
gcloud auth login
./scripts/setup.sh firebase --android-config '/absolute/path/to/google-services.json' --auth gcloud
```

`gcloud auth login` のブラウザ認証は本人が行います。relayは `gcloud auth print-access-token --quiet` を使用します。`gcloud auth application-default login` はこの方式の要件ではありません。CLIのトークンを表示・抽出・configへ保存しません。アクティブアカウントが別の作業で変わると送信できなくなる可能性があります。JSON取得が阻害された工程として記録し、代替方式の実Push確認まで進めます。

## 確認

[共通手順](../SETUP.md)へ戻り、ビルド、ペアリング、バックグラウンド受信、MCPへの返信、取り消しを実行します。FCMの403ならまずAPI有効化・対象プロジェクト・ロール反映を調べます。権限の反映待ちで鍵を作り直しません。

公式資料: [AndroidへのFirebase追加](https://firebase.google.com/docs/android/setup)、[FCM HTTP v1認証](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[FCMロールと権限](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)、[サービスアカウント鍵の作成](https://cloud.google.com/iam/docs/creating-managing-service-account-keys)。
