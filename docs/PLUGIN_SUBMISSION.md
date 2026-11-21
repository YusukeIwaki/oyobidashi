# Oyobidashi の公式ディレクトリ掲載

GitHub 配布版の [インストール手順](../plugins/oyobidashi/README.md) は公開リポジトリから利用できます。両社の公式ディレクトリには、それぞれの開発者ポータルから提出します。

| 項目 | 値 |
| --- | --- |
| 表示名 | Oyobidashi |
| 日本語の紹介文 | AIがあなたをお呼び出し |
| サービス | https://ai.oyobidashi.me/ |
| Streamable HTTP MCP | https://api.oyobidashi.me/v1/mcp |
| 認証 | OAuth、動的クライアント登録 (DCR)、PKCE S256 |
| プライバシーポリシー | https://ai.oyobidashi.me/privacy/ |
| サポート | https://github.com/YusukeIwaki/oyobidashi/issues |

## Claude

有料プランの提出権限があるアカウントで [Claude 開発者ポータル](https://claude.ai/directory/manage) を開きます。

1. **MCP connector** として上記 MCP URL を登録します。OAuth は自動登録を選びます。同じサーバーをカスタムコネクタとして接続し、全 6 ツールをテストしてください。
2. **Plugin bundle** として GitHub リポジトリ `YusukeIwaki/oyobidashi`、ブランチ `main`、フォルダー `plugins/oyobidashi` を指定します。GitHub アカウントを連携して検証し、配布用 README と表示内容を確認して提出します。
3. 同じ組織で作成したコネクタとプラグインをポータルで関連付け、審査後に公開します。

[Claude の提出手順](https://claude.com/docs/directory/publish) · [コネクタの審査チェックリスト](https://claude.com/docs/connectors/building/review-criteria)

## OpenAI

```sh
bash scripts/package-openai-plugin.sh
```

生成先は `.oyobidashi/plugin-submission/oyobidashi.zip` です。検証済みの開発者 ID を使い、[OpenAI Plugins](https://platform.openai.com/plugins) にアップロードします。

1. ポータルが発行したドメイン検証値を、Railway の本番 API の `OPENAI_APPS_CHALLENGE` にそのまま設定します。ポータルが表示するホストを確認してから、API の `/.well-known/openai-apps-challenge` が値のみを返す状態で **Connect** を実行します。
2. 承認された利用規約を公開し、URL を `plugin.json` の `extensions.com.openai.interface.termsOfServiceURL` に追加します。
3. 審査担当者がログインと端末ペアリングを試せる専用アカウントを用意します。個人のアカウントは使わず、追加の認証コードや承認が不要な手順を、審査ポータルの非公開欄に記載します。
4. OpenAI のクライアント上で同梱の正常系 5 件と異常系 3 件を実行します。サンプルデータで接続、端末への配信、回答の受け取りを録画し、審査担当者が開ける動画 URL を登録します。
5. 自動検査と登録内容を確認して審査へ提出します。承認後、ポータルから **Publish** を実行します。

[プラグインのアップロードと審査](https://developers.openai.com/plugins/deploy/submission)
