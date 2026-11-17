# 検証結果

2026-11-16 (Asia/Tokyo)。参考アプリの移植後、実際のBun中継・stdio MCP・ネイティブアプリを使用して確認しました。テスト用の画面データや架空の成功応答を製品に追加していません。

## Android Material 3の再整理と最終検証 (2026-11-17)

[Android UIの方針](../android/UI_DESIGN.md)に沿って、設定の一律の右向き矢印・行の装飾・グループのカードを外し、標準のListItemで項目名と状態を表示しました。未回答カードは質問と操作名を中心に構成し、対応状態は標準の選択チェックを持つSegmentedButtonへ揃えました。回答の見出し・送信の説明、通常の設定／通話トップバー、会話の重複表示の抑制も反映しています。

Pixel 10a / Android 17へ更新版をインストールし、ライト／ダーク、文字サイズ100%／150%、権限項目から端末設定を開いて戻る操作、接続変更画面からの復帰、回答入力・送信成功・一覧復帰、バックグラウンド着信・応答・終了を確認しました。文字を大きくしたときは状態選択が縦のラジオボタンへ切り替わります。既存のペアリングを保持し、確認後は対応可・文字サイズ100%・ダークモードへ戻しています。

最終のコードに対する検証:

- relay **552 pass**、MCP **390 pass**、セットアップ補助 **14 pass**、実通信の結合 **18 pass**（JDK17）。すべて失敗0。
- クラウドは隔離した実PostgreSQL17／Redis7で **396 pass / 0 fail**。プロセス停止・接続強制断を含む復旧試験を実施。
- iOS Kit **236件 / 1 skip / 0 fail**、署名付きiOS本体・通知拡張ビルド成功。
- Android core **261件 / 1 skip / 0 fail**、app **12件 / 0 fail**。JDK17でDebug APKビルド成功。
- relay・MCP・cloudの型検査、Compose設定の検査、クラウドのDockerイメージビルドが成功。
- コミット対象のファイル一式を隔離コピーし、gitleaksで秘密情報の検出0件。ローカル資格情報・端末ログは対象外。

## 呼び出しの用件 (2026-11-17)

任意の `subject` (40文字以内) をMCP・LAN relay・クラウド・各ネイティブアプリに追加。iPhoneはCallKitの発信者名に添え、Androidは着信画面の質問本文の上に表示する。用件なしの既存リクエストとSQLiteの追加マイグレーション、空白の正規化、文字数・型検証、VoIP Pushから即時に作る発信者名を検証した。クラウドではVoIP Pushに用件だけを追加し、質問・文脈・会話を含めず、通常・取り消しPushにも用件を載せないことを確認した。

- `bun test --cwd relay`: **552 pass / 0 fail**。
- `bun test --cwd mcp`: **390 pass / 0 fail**。
- `bun test --cwd cloud`: **386 pass / 10 skip / 0 fail**。今回、実PostgreSQL・Redisの強制断試験は未実施。
- `swift test --package-path ios/OyobidashiKit`: **236件、1 skip / 0 fail**。
- JDK17でAndroidのcore・app単体テストと `:app:assembleDebug` が成功。
- `bun test --cwd integration`: **18 pass / 0 fail**。実relayからiOS/Android通信クライアントへの一覧・WebSocket・回答後の用件保持、および実stdio MCPからrelayへの用件伝達を確認。
- relay・MCP・cloudの型検査、署名なしiOS Simulator向けアプリビルドが成功。

今回の変更で実機へのPush配信・CallKit着信画面の見え方・音声は未検証。

## クラウド構成・非同期音声 (2026-11-16)

共有API／WebSocket、Firebase IDトークンを使うstdio MCP、PostgreSQLの永続ジョブ、Redisの更新通知、発話単位の共有ワーカーを追加しました。[構成・起動方法](../cloud/README.md)、[障害復旧の契約](CLOUD_PROTOCOL.md)を参照してください。

| 確認 | 結果 |
|---|---|
| クラウドの単体・結合試験（実PostgreSQL17／Redis7を含む） | **394 pass / 0 fail**。隔離した一時DB／Redisを使用。サーバー・ブラウザ双方のstrict型検査成功 |
| 既存relay | **548 pass / 0 fail**、strict型検査成功 |
| MCP | **389 pass / 0 fail**、strict型検査成功。複数プロセスの同時更新・更新前後のアカウント変更・ブラウザからの安全な認証引き渡しも検証 |
| 実relay・stdio MCP・iOS URLSession・Android OkHttp結合 | **18 pass / 0 fail**。JDK17を明示 |
| iOS Kit | **233 tests / 1 skip / 0 fail**。既存の実relay依存試験だけskip |
| Android | core **260 tests / 1 skip / 0 fail**、app **5 tests / 0 fail**、Debug APKビルド成功 |
| セットアップ補助 | **14 pass / 0 fail** |
| iOSビルド | Simulator、物理iPhone向けの本体・通知拡張とも成功。既存署名設定を使用 |
| iPhoneへのインストール・起動・選択返信 | データを保持して更新成功。ロック解除後に起動成功。既存LAN経路で新しい質問の表示・選択返信をユーザーが確認し、サーバーへの`choice`回答保存と実stdio MCPの`wait_for_answer`による同じ回答の取得まで確認 |
| Docker | Linux版Bun1.4.4の実イメージで初期269件成功。認証ページ追加後のイメージもビルド成功。実RailwayでAPI／workerの起動・DB readiness 200・未認証API 401を確認 |
| 配置設定 | RailwayのAPI／workerとも実デプロイとhealth成功。現行Infrastructure as Codeのplan差分なし、Compose・CI YAML・シェル構文・差分の空白検査成功 |
| 秘密情報検査 | git管理対象・追加予定のソースを隔離コピーしてgitleaksで検査し、検出なし。ローカル状態・資格情報はコピー対象外 |

再現した障害は、実ワーカープロセスのSIGKILL、PostgreSQL接続の強制終了、古いワーカーの遅延完了、Redis購読TCPの強制切断、実WebSocket切断・再接続、iOS/AndroidのHTTP本文途中切断、応答だけの喪失、401・429・5xx、プロバイダーの壊れた出力・無応答、停止とジョブ取得の競合、遅いソケット、アカウント切り替えと遅いHTTP応答の競合です。

加えて、履歴が200件を超えた再接続、初回Push待ち中の優先度変更、旧アカウントのPush宛先再登録、未回答一覧からの欠落、最終読み上げの早期終了を試験で保護しています。無言の1000通話は会話ジョブ・モデル呼び出し・占有ワーカー0、変更のない1000接続は500人ずつの変更番号照会だけ、変更時のDBスナップショット取得は最大4並列であることを構造として検証しました。これは本番環境のCPU別収容数の実測ではありません。

以下のLAN確認に続いて、実Firebaseログイン・トークン更新、Railway上の稼働、クラウド経由の実iPhoneへの背景Push・返信・音声通話を確認しました（下表）。集中モード中はバナーが表示されず、通知センターから開いて返信できました。集中モードを一時的にオフにした後は、通知表示・通知からの返信・通話の着信と会話・お礼の読み上げ・自動終話をユーザーが確認しました。実stdio MCPでも選択回答と音声の解決済み回答を受信しました。秘密値・ペアリングURL・端末ログはこの記録に載せていません。

### Railway・Firebaseへの配置 (2026-11-16)

| 確認 | 結果 |
|---|---|
| Railway | 利用者のPersonal workspaceにAPI・worker・PostgreSQL18・Redis8.2を配置。APIは `https://oyobidashi.up.railway.app` で公開、DB/Redisの公開TCP proxyは0件。API・DB/RedisはSingapore、workerは米国西部。アプリは1レプリカずつでhealth成功 |
| 認証 | 既存Firebaseプロジェクトを再利用。匿名とGoogleを有効化し、Googleの連携・独立再ログインの成功を確認してからEmail/Passwordを無効化。匿名での実サインアップ・同じ資格情報の再利用・強制更新・クラウド認証成功。既存のペアリング所有UIDへGoogleをリンクした後、保存済み資格情報を使わない独立したGoogleログインでも同じUID・既存端末1台を取得。無効化後の強制更新、実stdio MCPのget_human_status成功。未認証・不正トークンは401 |
| 配置設定 | 新規サービスで旧railway.tomlが無視されることを実環境で確認し、Infrastructure as Codeへ移行。CLI5.74.0のplanはNo changes。変数はunmanagedで手動設定の秘密値を保持 |
| APIプロバイダー | Meta Model APIのMuse Spark対応を追加。Anthropic/Meta双方の切断・キャンセル・429/5xx・401/403・不正出力・途中応答を含む99件成功。設定名は`MODEL_API_KEY`。Singaporeの当該workerは404 `model_not_found`、同一キーのMacは成功。workerを米国西部へ移した後、製品の会話providerで通常版`muse-spark-1.2`が約4.5秒で`resolved:true`・テスト発話の要約・お礼を返却。続いて実iPhoneの音声往復も成功 |
| Firebase更新の回帰試験 | 実応答のproject_idが数値のプロジェクト番号であるため、設定したプロジェクトIDとの文字列比較を修正。IDトークンのaudで照合し、別プロジェクト・別UID・更新中のログイン切替を拒否 |
| CPU・メモリの初期値 | 端末0台・待機時のRailway計測でAPI約0.0011vCPU/41MB、worker約0.0016vCPU/14MB。多人数や音声処理中の収容数の実測ではない |
| iPhoneクラウド接続 | 新ホスト名へ実機で再ペアリング。通常Push・VoIPトークン登録、質問表示・選択返信を確認。アプリアイコンの画面に戻してからの背景APNsも1回目で配信完了し、ユーザーが通知から開いて返信。実stdio MCPで同じ選択結果を受信 |
| iPhoneクラウド通話 | 集中モードをオフにして着信・応答・マイク・音声認識・Metaによる確認質問・再回答・お礼の読み上げ・自動終話が成功。実stdio MCPで`answered`、`input_method:voice`、`outcome:resolved`、確認用の名前の要約を受信。検証後のlive call・ready/leased jobは0件 |
| 実Railwayの無言・再デプロイ | 別の匿名テスト利用者で通話を開始。無言61秒で発話ジョブ0、worker再デプロイ後もactive・無言142秒で発話ジョブ0。発話の受付はHTTP202・約152ms。同じIDの再送も202・同じturn ID。完了結果は`answered/voice`、ユーザー発話の記録は1件のみ |

実Railwayの自動疎通試験では、結果の取得中に一度503を観測しました。発話は失われず、別の取得操作で保存済みの完了結果を回収しました。端末の503・通信断からの再取得は単体・結合試験で検証済みですが、この自動疎通ドライバーによる手動の再取得を端末の自動復旧の実測とは扱いません。多人数の同時音声負荷や、本番環境のCPU別収容数は未実測です。

ブラウザ認証は、別UIDへの誤ったリンク・別ブラウザ利用者の認証状態・二重操作・ポップアップのキャンセル・プロバイダーとの通信失敗を48件の試験で検証しています。MCPの実ループバックHTTP試験ではOrigin／Host／state／プロジェクト／UID／プロバイダーの不一致、同時コールバック、応答しない検証処理の中断、タイムアウト、復旧前の資格情報バックアップを検証しました。匿名認証の検証用アカウントは端末0台・未連携を確認して削除し、実利用者のUIDとペアリングを保持しています。

iPhoneの再ペアリング後に同じVoIPトークンの登録が省略される不具合も実機確認中に修正しました。ペアリング成功時に登録済みのVoIP状態をクリアし、通常Push・VoIP双方がクラウド端末レコードに登録されることを確認しました。失敗したペアリングで旧登録を保持することと、一時的な登録失敗後に再試行できることを回帰試験で保護しています。

設定画面は、iOS・Androidとも接続先URLの右側に「変更」を配置しました。新しい接続の確立までは現在のペアリングを保持します。両OSのビルドが成功し、iPhoneへデータを保持して更新済みです。ユーザーも実機でURL右側の「変更」を確認しました。


指定された`muse exec --model wonder-1.0-contributor --effort max`は、モデル不存在／アクセス不可で3件とも開始できませんでした。独立した端末・MCP作業は代替の並列エージェントで実施し、認可・共有DB・ジョブの排他制御と復旧処理は主担当が実装しました。

### Apple・GitHub認証の追加 (2026-11-16)

Firebaseの標準方式でGoogle・Apple・GitHubと匿名を有効にし、Email/Passwordは無効を維持しています。認証属性のメールアドレスはFirebase標準の管理に任せ、アプリのPostgreSQLではUIDで認可します。メール属性・プロフィール・メール照合用ハッシュをアプリDBへコピーしません。

| 確認 | 結果 |
|---|---|
| GitHub設定 | 利用者のGitHubアカウントにお呼び出し用OAuth Appを作成。正確なFirebaseコールバックURLを登録し、Client ID・Client SecretをFirebaseへ設定。追加のリポジトリ権限は要求していない |
| GitHub連携・復旧 | 実ブラウザで既存のGoogle連携済みUIDへGitHubを追加。UIDとペアリング1台を保持。続いて保存済み資格情報を使わない独立したGitHubログインでも同じUID・端末1台・クラウドHTTP200を確認 |
| Apple設定 | 利用者の既存Apple Developerチームで本体App IDのSign in with Appleを有効化。Web用Services ID、認証ドメイン・FirebaseコールバックURL、専用のSign in with Apple鍵を設定。FirebaseのAppleプロバイダー有効を確認 |
| Apple連携・復旧 | 本人によるApple Account認証を経て、既存のGoogle・GitHub連携済みUIDへAppleを追加。UID・ペアリング1台を保持。続いて保存済み資格情報を使わない独立したAppleログインでも同じUID・端末1台・クラウドHTTP200を確認 |
| 秘密情報 | GitHub Client SecretとApple秘密鍵はFirebaseへ保存。Apple鍵は権限600のgit管理外ファイルへ保護し、今回のDownloadsの元ファイルは移動済み。既存APNs鍵は変更していない。OAuth秘密情報をRailwayやブラウザbundleへ追加していない |
| Railway | APIを再デプロイ。公開設定が`google,apple,github`、`canLinkExisting:true`、HTTP200であることを確認 |
| 属性の非コピー | 有効なJWTにemail・name・pictureと各プロバイダーのidentitiesが含まれても、認可処理がUIDだけを返す回帰試験を強化。MCPの認証検査がemail・displayName・photoUrl・provider email等を返さない既存試験も確認。対象165件成功、両strict型検査と差分の空白検査成功 |


## 独自ドメインの併用 (2026-11-17)

メインURLを`https://api.oyobidashi.me`へ変更し、既存の`https://oyobidashi.up.railway.app`も同じAPIサービスの8787番ポートへ直接接続する構成を維持しました。

| 確認 | 結果 |
|---|---|
| Railway・DNS・HTTPS | 既存のカスタムドメイン登録、CNAMEと所有確認TXTを再利用。所有確認と証明書発行が完了し、新旧両URLの`/readyz`が証明書検証ありでHTTP200 |
| 正規URL | API・worker両方の`PUBLIC_URL`を`https://api.oyobidashi.me`へ更新。既存デプロイのイメージを使って両サービスの再デプロイが成功。通知プレビューURLは新ドメインを使用 |
| Firebase | 承認済みドメインへ`api.oyobidashi.me`を追加し、旧ホストと既定ドメインを保持。`authDomain`と各プロバイダーのFirebaseコールバックURLは維持 |
| API・ペアリング | 新旧両URLのFirebase公開設定が一致。同じ資格情報で認証付きAPIがHTTP200となり、同じペアリング済み端末1台を取得 |
| ローカルMCP | 資格情報を権限600でバックアップし、UID・認証トークンを保持して保存先URLのみ新ドメインへ変更。実MCPの`get_human_status`で`ok`・端末1台を確認 |
| Google OAuth | 新ドメインの認証ページから実ブラウザでGoogleログインし、既存のFirebaseコールバック・ローカルMCPへの受け渡しが完了。同じUID・端末1台・認証付きAPIのHTTP200を確認 |
| 検証範囲 | GitHubは検証用ブラウザが未ログインのため新ドメインでの再ログインは未完了。Appleの再ログインと、切り替え後の実機Push・音声は今回再実施していない |

クラウドとMCPの案内・ログイン例も新URLへ変更しました。旧URLで接続済みのスマホは引き続き利用でき、ドメイン追加に伴う再ペアリングは不要です。


## アプリID・Kotlin packageの変更 (2026-11-17)

iOS本体を`me.oyobidashi.ios`、通知拡張を`me.oyobidashi.ios.NotificationService`、AndroidのapplicationId・namespace・Kotlin packageを`me.oyobidashi.android`へ変更しました。Androidのmain/testのクラス・import・ディレクトリ、iOSのURL type名・Keychainサービス、relayのAPNs既定topic、セットアップ補助・テスト・案内を揃えています。以下より前の記録にある旧IDは、その時点の検証履歴です。

| 確認 | 結果 |
|---|---|
| Android | core 260件（1 skip）・app 5件、失敗0。新IDのDebug APKビルドが成功。50個のKotlinファイルで宣言packageと配置先が一致 |
| Android起動 | `emulator-5554`へ新IDのAPKをインストール。`me.oyobidashi.android/.ui.MainActivity`の解決・コールド起動・新プロセスを確認 |
| Firebase | 既存プロジェクトへ`me.oyobidashi.android`を追加。新App IDを`android/local.properties`へ反映し、既存のproject・sender・API key・FCM送信資格情報を保持。旧Android登録は削除保留後の「今すぐ削除」も実行し、完全削除。旧packageだけを含む未使用の`google-services.json`も削除 |
| iOS Kit | 233件（1 skip）、失敗0 |
| iOS署名 | 既存の本人のチーム・開発証明書・APNs鍵を再利用。本体と通知拡張の署名付き実機向けビルドが成功。本体の署名プロファイルで新Bundle ID、development APNs、Time Sensitive権限を確認 |
| iOS起動 | 起動済みiPhone 17 Simulatorへ新Bundle IDでインストール・起動し、ペアリング画面を確認 |
| relay・MCP・setup | relay 548件・setup 14件成功。MCPは初回に実HTTPタイムアウト試験の後処理が5秒制限を超えたため、15秒制限で再実行し389件成功 |
| 結合 | 実relay・stdio MCP・iOS URLSession・Android OkHttpの結合18件成功 |

iPhone・Pixelへ新IDのアプリをインストールし、両端末をクラウドへ再ペアリングしました。workerの`APNS_BUNDLE_ID`を`me.oyobidashi.ios`へ変更して再配置し、通常Push・VoIPトークンの登録を確認しました。Pixelでは実OS通知からアプリを開いて選択回答し、MCPで受信しました。新iPhone宛ての通常Pushジョブは初回で完了し、トークンの失効処理もありません。iPhone確認用の質問への回答も実際にはPixelのdevice IDだったため、iPhone実機での新IDの通知受信・画面遷移は未確認として扱います。今回、新IDでの音声往復は再試験していません。

AppleのServices IDは変更できないため、`me.oyobidashi.ios.auth`を新規作成し、主App IDを`me.oyobidashi.ios`へ紐付けました。新しいSign in with Apple鍵をFirebaseへ設定し、実際のAppleログインで以前と同じFirebase UID・認証付きAPI通信・ローカルへのコールバックを確認しました。OAuthの戻り先は引き続き`https://oyobidashi-7a842.firebaseapp.com/__/auth/handler`です。

利用者の削除確認後、旧Sign in with Apple鍵を失効、旧Services ID・旧本体／通知拡張App IDをAppleから削除しました。旧鍵のローカルファイルと旧専用プロビジョニングプロファイル・移行用バックアップを削除し、iPhone・Pixelから旧アプリをアンインストールしました。クラウドでは旧iOS端末2件について、資格情報・Push所有権・presence・previewを削除し、古い宛先の未完了Pushジョブを終了しました。新しい2端末と質問・回答履歴は保持しています。Team ScopedのAPNs鍵・共通の開発用証明書・Androidの共通debug keystoreは新IDでも必要なため維持しています。



## 回答後の完了表示・未回答一覧への復帰 (2026-11-17)

iOSはSwiftUIのシステム背景・SF Symbols、AndroidはMaterial 3のScaffold・アイコン・ボタンを使い、回答を送信できた場合に「回答を送信しました」を約1.2秒表示し、未回答一覧へ戻すよう変更しました。読み上げ利用時は表示時間を延長します。戻った後の履歴に回答済みの詳細を残さず、送信中に別の通知を開いた場合は新しい画面を閉じません。送信失敗・他端末での解決は送信成功と区別し、失敗時には入力画面と下書きを保持します。

- Pixel 10a実機: クラウドの実OS通知を開く → 選択回答 → 完了表示 → 未回答一覧を録画で確認。MCPへ同じ選択が返ることも確認。
- iOS Simulator: 独立した実relayへペアリングし、実HTTP送信 → 完了表示 → 未回答一覧を録画で確認。検証用relayは終了し、検証用ペアリング情報も片付けました。
- iOS Kit 233件（1 skip）、Android core 260件（1 skip）・app Debug 7件、失敗0。署名付きiOS実機ビルド、iOS Simulatorのビルド・起動、Android Debug APKのビルド成功。更新版をiPhone・Pixelへインストール済み。
- iOSは送信成功イベントを受信した場合だけ画面遷移し、失敗時には成功イベントを発行しないことと、ペアリング解除時のイベント破棄を検証。Androidは完了表示から一覧への復帰と、遅れて完了した処理が別の質問・設定を閉じないことを検証。


## 新IDのクラウドPushと応答確認 (2026-11-17)

cloud workerのFCM送信資格情報を設定しました。専用の送信アカウントへ `roles/firebasecloudmessaging.admin` を付与し、保護した鍵をworkerの `FCM_SERVICE_ACCOUNT_JSON` に設定して再配置しました。資格情報と端末ログはgitへ含めません。

Pixel 10a / Android 17では、Chromeの利用中に実FCMのCallStyle着信を受信し、OSの応答ボタンから通話へ遷移しました。クラウドの同じ通話が `active` になり、読み上げと会話表示を確認しました。無音で音声認識のno-matchが続く場合は文字回答へ切り替わりました。音声回答の往復成功としては扱いません。文字回答・選択回答はサーバー保存、完了表示、未回答一覧への復帰まで確認しました。

iPhone 16 Pro / iOS 26.7.2では、Safariの利用中に新Bundle ID宛てのVoIP PushでCallKit着信を受信しました。応答後にアプリの通話画面と読み上げを確認し、「終了」で一覧へ復帰しました。同じ通話が `ended` / `hangup` となり、未回答の質問は `delivery_mode: text` で残ることをAPIで確認しました。自由入力した回答についても完了表示と一覧復帰まで確認しました。

## clone向けセットアップ (2026-11-16)

AGENTS.md、Claude/Codexのセットアップスキル、ブラウザでのクラウド準備手順、ローカル設定の補助スクリプトを追加しました。今回の追加検証では既存アカウントにFirebaseプロジェクトやAPNs鍵を新規作成せず、一時ディレクトリと実行時生成の検証鍵を使用しました。ブラウザでの新規プロビジョニング全工程の再実行は未実施です。

| 確認 | 結果 |
|---|---|
| `bun test scripts/setup-local.test.ts` | **14 pass / 0 fail**。既存トークン・他プロバイダー保持、不正な既存設定の非破壊、入力のプロジェクト不一致拒否、PKCS#8鍵形式、権限、MCP競合、秘密値の非表示を検証 |
| 補助スクリプトとテストのTypeScript strictチェック | 成功 |
| 両方のSKILL.md | skill-creatorのquick_validateで成功 |
| 未設定の隔離環境から `setup.sh bootstrap` | 3パッケージのfrozen-lockfileインストール、relay設定作成に成功 |
| Claude SessionStart用シェル | `sh -n` 成功。実行結果がAGENTS.md全文と一致 |
| 別チーム・別Bundle IDでXcodeGen生成 | 本体と通知拡張の両ターゲットの実build settingsがローカル指定に一致 |
| 生成したローカルspecでiOS Simulator向けビルド | 本体・通知拡張とも署名なしビルド成功 |
| 隔離relayと実stdio MCP | 別ポートでhealth成功、`get_human_status` 成功。既存relay・端末には接続せず確認 |
| `git check-ignore` | relay設定・p8・Android設定・iOSローカルspec・両MCP設定がすべて対象 |
| gitleaks | 追跡対象と新規ソースの秘密情報検出なし |

Claude/Codex本体でのスキル自動選択・ブラウザログイン・新規クラウド作成の一連の確認は、このローカル補助処理の試験とは区別します。実アカウントで設定する際は[セットアップの完了条件](SETUP.md)まで実施してください。

## 自動試験・ビルド

| 対象 | 実行 | 結果 |
|---|---|---|
| relay | `bun test --cwd relay` | **548 pass / 0 fail** |
| MCP | `bun test --cwd mcp` | **232 pass / 0 fail** |
| iOS Kit | `swift test --package-path ios/OyobidashiKit` | **187 tests / 1 skip / 0 fail** |
| Android core | JDK17で `android/gradlew -p android :core:test` | **186 tests / 1 skip / 0 fail** |
| Android画面遷移 | `:app:testDebugUnitTest` | **5 tests / 0 fail** |
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

## Android Material 3・戻る操作 (2026-11-16)

ホーム・設定をMaterial 3のカード、セグメントボタン、アイコン付きListItem、大きなトップバーで構成しました。Android 12以降は端末のダイナミックカラーを使い、それ以前は青系のライト・ダーク配色を使用します。ホームは状態と未回答の通知だけ、設定はペアリング・権限・アプリ情報だけを表示します。[Material 3公式ガイド](https://developer.android.com/develop/ui/compose/designsystems/material3)。

Pixel 10aのダーク表示と専用エミュレータのライト表示で確認しました。ダーク表示でも選択中の状態を見分けられるよう、状態カードにsurfaceコンテナ色を使用しています。文字サイズ1.3倍では状態選択を縦並びのラジオボタンへ切り替え、横並びの折り返しによる崩れを防ぎました。エミュレータの文字サイズは試験後に元へ戻しています。

ツールバーとシステムバックは共通の画面遷移処理を使用します。単体試験5件で、ホームがシステムバックを妨げないこと、再ペアリング→設定→ホーム、通知の質問→ホーム、別の通知で古い質問の戻る履歴を作らないこと、設定への重複遷移を検証しました。

| 実機・エミュレータでの確認 | 結果 |
|---|---|
| Pixel: 設定から端の戻るジェスチャー | ホームへ戻る |
| Pixel: ホームで戻るキー | ランチャーへ戻り、再起動でホームを表示 |
| エミュレータ: QR読み取りで戻る | 再ペアリング画面へ戻り、入力したコードも保持 |
| エミュレータ: 再ペアリングで戻る → 設定で戻る | 設定 → ホームの順に戻る |
| Pixel: ペアリング解除の確認ダイアログで戻る | ダイアログだけ閉じ、ペアリングを維持 |
| Pixel: OSの通知設定から戻る | アプリの設定画面へ復帰 |
| Pixel: 設定から通知と同じIntentで実際の質問を開く | 質問を表示。キーボード表示中の最初の戻るはキーボードだけを閉じ、次の戻るでホームへ戻る。設定へは戻らない |
| 状態の選択・未回答カード・設定の末尾までのスクロール | 反映・表示に問題なし。確認用の質問はMCPから取り消し済み |

`:app:assembleDebug` / `:app:testDebugUnitTest`は成功し、Pixelとエミュレータへ最終APKをインストール済みです。今回、通話・通知配送のロジックは変更していません。

![Material 3 ホーム・ライト](evidence/android-material-home-light.png)
![Material 3 設定・ライト](evidence/android-material-settings-light.png)
![Material 3 ホーム・ダーク](evidence/android-material-home-dark.png)
![Material 3 設定・ダーク](evidence/android-material-settings-dark.png)
![大きな文字での状態選択](evidence/android-material-large-text.png)

## 未確認・外部条件

- iOS実機では上記の通話・テキストへの切り替えを確認済みです。実APNsの選択肢ボタンによる回答は実機では未確認です (アプリ内選択回答はiOS Simulator、実Pushの選択回答はAndroid Emulatorで確認済み)。
- Androidの音声往復・自動終話・途中終了と通知への切り替えは、上記のPixel 10a実機で確認済みです。音声出力ありのAndroidエミュレータではQEMU2 main loop/CPU threadが停止してADBが切断される問題が残っています。エミュレータの音声試験を実機で代替しました。
- **音声はターン単位。** 全二重音声ストリーミング・発話での割り込みは未実装です。Claudeのサブスクリプションを使い、Geminiのキーは不要です。
- **外出先の通信経路は未設定。** HTTPS/WSSプロキシ対応とアクセス制御の試験・Caddy設定例は用意済みですが、公開ホスト名・証明書・実ネットワークの接続確認は残っています。
- iOSの通知削除を含むPush配信はOSのベストエフォートです。今回のバックグラウンド試験では削除を確認しましたが、圏外・強制終了・OS制限中の即時反映は保証しません。復帰時にサーバーと照合します。[Apple公式: background通知の配送は保証されない](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)。

## この作業環境の初期設定記録 (2026-11-16)

以下はID変更前の記録です。現在のID・認証設定・削除結果は上記2026-11-17の記録を参照してください。

- Firebase: `oyobidashi-7a842` (Spark)、Android登録ID `io.github.yusukeiwaki.oyobidashi`。
- `android/local.properties` / `android/app/google-services.json` は設定済み・gitignore対象。
- `.oyobidashi/config.json` はFCMをGoogle Cloud CLIの既存ログインで送る設定。新規サービスアカウント秘密鍵は作成していません。
- Apple Developer: Team `6KG5EF3BN2`、本体 `io.github.yusukeiwaki.oyobidashi` (Push Notifications / Time Sensitive Notifications有効)、通知拡張 `io.github.yusukeiwaki.oyobidashi.NotificationService` を登録済み。XcodeGenの署名チームも設定済みです。
- APNs: キー名 `Oyobidashi Push`、Key ID `7GS4U6H2LS`、APNsのみ・Sandbox & Production・Team Scoped。秘密鍵は `.oyobidashi/keys/` に移動し、鍵と設定ファイルは権限0600・gitignore対象です。中継再起動後、APNs / FCMとも有効です。
- `./scripts/dev.sh` / `./scripts/pair.sh` / `./scripts/mcp.sh` が同じローカル状態ディレクトリを使います。
- Android専用検証AVD: `oyobidashi_qa`。既存AVDのデータは消去していません。
