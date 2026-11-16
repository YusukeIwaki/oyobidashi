# oyobidashi iOS アプリ

初回は[AIに任せるセットアップ](../docs/SETUP.md)を使えます。本人のAppleチーム・APNs鍵・Bundle IDは[Appleの準備](../docs/setup/APPLE.md)で設定します。


> v0.2: 通話・在席フィードバック・通知取り消しを追加しました。[全体の起動方法と制限](../README.md)、[拡張プロトコル](../docs/EXTENSIONS.md)を参照してください。既定はLAN内、明示したHTTPSプロキシ経由でも利用できます。

エージェント (Claude Code / Codex) からの質問を通知で受け取り、テキスト・音声・選択肢で回答するアプリです。
通信仕様は [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) を参照してください。

## 構成

| パス | 内容 |
|---|---|
| `OyobidashiKit/` | Swift パッケージ。UI 以外のすべて (モデル、`RelayClient`、ペアリングURI、資格情報ストア、WebSocket、Push ペイロード、状態管理)。macOS 上で `swift test` できる |
| `App/Sources/` | SwiftUI アプリ本体。OyobidashiKit の薄いラッパー (カメラ・音声認識・通知・画面) |
| `project.yml` | XcodeGen の定義。`App/Info.plist` と `App/Oyobidashi.entitlements` もここから生成される |

## 必要なもの

- Xcode 16 以降 (開発時は Xcode 27 / Swift 6.4 で確認)、[XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- iOS 17 以降の実機 (Push 通知・カメラ・音声認識を使うため、実機を推奨)
- Push 通知を使う場合は有料の Apple Developer Program のチーム

## テスト

```sh
cd ios/OyobidashiKit
swift test
```

## プロジェクトの生成とビルド

```sh
cd ios
xcodegen generate --spec project.local.yml # setup.sh appleで生成した本人の署名設定
open Oyobidashi.xcodeproj
```

APNsを使わないシミュレータ・署名なしのビルド確認だけなら `xcodegen generate --spec project.yml` を使えます。共有specには開発チームを固定していません。

署名なしでコンパイルだけ確認する場合:

```sh
xcodebuild -project Oyobidashi.xcodeproj -scheme Oyobidashi \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

## 実機で動かす

1. **署名チームを確認する。** `./scripts/setup.sh apple --team-id ... --key-id ... --key-file ... --bundle-id ...` をルートから実行すると、git管理外の `project.local.yml` に本人のチーム・本体と通知拡張のBundle IDを設定します。
   作者とは別のチームでは固有のBundle IDが必要です。relayのAPNs `bundle_id` も補助スクリプトが同じ本体IDに揃えます。`project.yml` を直接個人向けに書き換える必要はありません。
2. **Capability を確認する。** entitlements ファイルで次の2つを要求している。自動署名ならプロビジョニングプロファイルに自動で反映される。
   - Push Notifications (`aps-environment`)
   - Time Sensitive Notifications (`com.apple.developer.usernotifications.time-sensitive`)
3. iPhone を接続して実行先に選び、Run (⌘R)。

### Push 通知 (APNs) について

- relay 側に APNs の認証キー (`.p8`) を設定したときだけ Push が送られる (`docs/PROTOCOL.md` §6, §8)。
  設定が無くても、**アプリを開いている間は WebSocket で質問を受け取り、アプリ自身が通知を出す**。
- Xcode から実行した Debug ビルドは `push_environment: development` (APNs sandbox)、Release ビルドは `production` を relay に登録する。
  TestFlight / App Store 配布のビルドは production の APNs を使うので Release ビルドのままでよい。
- 質問の通知は「即時通知 (Time Sensitive)」として届く。通知を長押しして **「返信」からそのまま回答** できる。

## ペアリング (既定はLAN内)

既定の中継サーバーはLAN内で動きます。**iPhone と Mac を同じ Wi‑Fi (同じ LAN) に接続** して使います。

1. Mac で relay を起動し、ペアリング用の QR コードを表示する (relay の README を参照)。
   QR の中身は `oyobidashi://pair?url=http%3A%2F%2F192.168.1.10%3A8787&code=…` の形式。
2. アプリで次のいずれかを行う。
   - 「QRコードを読み取る」でカメラから読み取る
   - iPhone 上で `oyobidashi://pair?...` のリンクを開く (接続先を確認するダイアログが出る)
   - URL (`http://192.168.1.10:8787` など) とコードを手入力する
3. 初回接続時に **「ローカルネットワーク上のデバイスの検索および接続」の許可ダイアログ** が出るので「許可」を選ぶ。
   拒否した場合は 設定 → プライバシーとセキュリティ → ローカルネットワーク で「お呼び出し」を有効にする。
   (許可していないと「中継サーバーに接続できません」になる)

接続は LAN 内のプライベート IP 宛ての平文 HTTP / WebSocket (`http://` → `ws://`、`https://` → `wss://`)。
`Info.plist` で ATS のローカルネットワーク例外 (`NSAllowsLocalNetworking`) を有効にしており、Release ビルドでも IP アドレス・`.local` 名への平文接続ができます。

### 外出先 (LAN の外) での動作

- relay に APNs を設定していれば、Push 通知は外出先でも届く。
- ただし **回答にはLANまたは設定済みのHTTPS経路への接続が必要**。圏外のときは「中継サーバーに接続できません。同じWi‑Fiに接続しているか確認してください」と表示される。
- 入力した回答は下書きとして端末に保存される。通知の「返信」から送って失敗した場合も、
  「回答を送信できませんでした」という通知が出て、その内容が質問画面の入力欄に残る。Wi‑Fi に戻ってから「送信」を押せば送れる (自動では再送しない)。
- Wi‑Fi に戻る・アプリを前面に出すと、自動的に再接続して一覧を更新する。

### うまくいかないとき

- Mac の IP アドレスが変わると接続できなくなる。設定 (歯車) → 「ペアリングし直す」から接続先を更新する。通知・マイク・音声認識・カメラ・ローカルネットワークの再設定も、アプリの「設定」→「権限」から行える。
- 「ペアリングが無効になりました」と出た場合は relay 側でデバイスが削除されている。もう一度ペアリングする。

## 権限

| 権限 | 用途 |
|---|---|
| カメラ | ペアリング用 QR コードの読み取り |
| マイク / 音声認識 | 音声での回答 (認識結果はテキスト欄に入り、送信前に編集できる) |
| ローカルネットワーク | LAN 内の中継サーバーへの接続 |
| 通知 | 質問・お知らせの受信 |
