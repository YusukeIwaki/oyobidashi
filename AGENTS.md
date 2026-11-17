# お呼び出し — agent entrypoint

## 初回セットアップ・修復

「セットアップして」「Firebase/APNsを準備して」「clone後に動かしたい」なら、まずこの環境の `oyobidashi-setup` スキルを読む。

- Codex: `.agents/skills/oyobidashi-setup/SKILL.md`
- Claude Code: `.claude/skills/oyobidashi-setup/SKILL.md`
- 共通の実施手順: `docs/SETUP.md`。クラウド設定からローカル起動・MCP・端末確認まで実施する。

Claude Codeでは `.claude/settings.json` のSessionStartフックがこのファイルを読み込む。フック無効時もこのファイルを明示して開始する。指示の入口を増やす `CLAUDE.md` は作らない。

## 製品サイト

`site/` の製品サイト ([ai.oyobidashi.me](https://ai.oyobidashi.me)) の編集・表示確認・公開・デプロイ調査は、`oyobidashi-site` スキルを読む。

- Codex: `.agents/skills/oyobidashi-site/SKILL.md`
- Claude Code: `.claude/skills/oyobidashi-site/SKILL.md`
- 共通の手順: `site/README.md`。どこまで確認なしで進めるか、デザインの決まり、`main` へのpushによるRailway自動デプロイ、定義変更の手順を記載。

## このプロジェクト

Bun製LAN relay / stdio MCPと、SwiftUI iOS / Compose Material 3 Androidクライアント。既定のアプリIDは `io.github.yusukeiwaki.oyobidashi`。別のAppleチームでは利用者自身のBundle IDをローカル設定に使う。

ルートから `./scripts/setup.sh doctor` → `./scripts/dev.sh` → 別ターミナルで `./scripts/pair.sh`。各スクリプトの既定の状態ディレクトリはリポジトリの `.oyobidashi/`。直接relay CLIを使う場合の既定 `~/.oyobidashi/` と混同しない。

音声の会話判断は現在 **ログイン済みClaude Code CLIのみ**。Codexでもセットアップ・MCP・通知・テキスト返信は利用できるが、Codexの契約だけで音声中継が使えるとは案内しない。APIキーやCLIのOAuthトークンを抽出しない。

## 変更・検証

- 秘密鍵、サービスアカウントJSON、ペアリングURL、トークン、端末ログを会話やgitに載せない。設定は補助スクリプトで保護し、既存の別プロバイダー・ペアリング・MCP設定を保つ。
- ユーザーのアカウント・既存リソースを確認し、再開時にFirebaseプロジェクトやAPNs鍵を重複作成しない。作者のプロジェクト・Team IDを使わない。
- プロトコル変更前は `docs/PROTOCOL.md` と `docs/EXTENSIONS.md` を読む。実機検証記録は `docs/VALIDATION.md` にある。
- サーバー: `bun test --cwd relay` / `bun test --cwd mcp` / `bun test --cwd integration`。
- iOS: `swift test --package-path ios/OyobidashiKit`。ローカル署名設定生成後は `xcodegen generate --spec ios/project.local.yml`。
- Android: JDK17で `android/gradlew -p android :core:test :app:testDebugUnitTest :app:assembleDebug`。
- 製品サイト (`site/`、Astro): `bun run --cwd site build`、表示は `./site/scripts/screenshot.sh`。`main` へのpushで自動デプロイ。手順は `site/README.md`。
- セットアップ補助: `bun test scripts/setup-local.test.ts`。変更に関係する検証を実行し、実測していないクラウド接続・Push・音声を成功扱いしない。
