# Oyobidashi

Oyobidashi sends an AI agent's question or completion update to your paired phone. When you are away from your computer, reply from the iOS or Android app with a short choice or text. Calls are available when your device, account and availability settings allow them. The plugin connects to the hosted Oyobidashi service over HTTPS and uses browser sign-in.

## インストール

スマホに [Oyobidashi](https://ai.oyobidashi.me/) をインストールします。以下のコマンドは GitHub の公開マーケットプレイスから導入します。

### Claude Code

```sh
claude plugin marketplace add YusukeIwaki/oyobidashi
claude plugin install oyobidashi@oyobidashi
```

Claude Code で `/reload-plugins` を実行するか、セッションを開き直します。`/mcp` から Oyobidashi の接続を選び、ブラウザで許可します。

### Codex

```sh
codex plugin marketplace add YusukeIwaki/oyobidashi
codex plugin add oyobidashi@oyobidashi
```

デスクトップアプリではプラグイン一覧で Oyobidashi を開いて接続します。CLI では `codex mcp login oyobidashi` を実行します。

### スマホと接続

ブラウザで Google・Apple・GitHub のいずれかを使ってログインし、接続を許可します。スマホの Oyobidashi アプリで「Oyobidashiクラウドに接続」を選び、同じアカウントを使います。パソコン側の接続画面に QR コードが出た場合は、アプリの「自分で用意したサーバーに接続」から読み取る方法もあります。

接続後はエージェントに「Oyobidashiで、スマホにテスト通知を送って」と頼めます。質問への返信を受け取りたいときは「Oyobidashiで、短い版と詳しい版のどちらがいいかスマホで聞いて」と頼んでください。

すでに同じ MCP URL を手動登録している場合は、プラグイン経由と手動登録のどちらか一方を有効にしてください。

## データの流れ

プラグインには Oyobidashi の MCP 接続設定と使い方が入っています。MCP ツールは通知や質問の本文を `api.oyobidashi.me` へ送り、同じアカウントの登録端末に配信します。質問への回答は呼び出し元のエージェントに戻ります。音声通話で第三者 AI へ送る情報や保存期間はプライバシーポリシーに記載しています。[プライバシーポリシー](https://ai.oyobidashi.me/privacy/)

連携は [接続済みアプリ](https://api.oyobidashi.me/oauth/connections) から取り消せます。質問や会話の内容など個人情報を含めずにお問い合わせください。[サポート](https://github.com/YusukeIwaki/oyobidashi/issues)
