---
name: oyobidashi-setup
description: お呼び出しをcloneした環境で初期設定・修復する。Firebase作成、サービスアカウントJSON、Apple APNs、ローカルビルド、MCP登録、ペアリング、通知確認までAIに任せたいときに使う。
---

リポジトリルートの `AGENTS.md`、次に `docs/SETUP.md` を読み、そこにある順序と完了条件に従って実施する。相対パスはすべてリポジトリルートから解決する。

Claude CodeではClaude in Chromeの接続を確認する。必要なら `docs/setup/BROWSER.md` に従い `claude --chrome` と拡張の接続を案内する。利用可能なブラウザ／Computer useに付属する操作説明を読み、ログイン済みのユーザーブラウザを使う。

最初に `./scripts/setup.sh doctor` を実行し、既存設定を再利用する。OSや対象端末は環境から判断し、決められない項目だけユーザーへまとめて確認する。ブラウザの認証待ち中は、依存しないローカル準備を進める。クラウド操作、鍵ファイルの取り込み、ビルド、起動、実MCP経由の確認まで継続する。

処理を再開できるよう、リソースIDと未完了の工程をgit管理外の `.oyobidashi/setup-state.json` に記録する。秘密値は記録しない。ファイルが存在するだけでPushや通話まで検証済みとしない。
