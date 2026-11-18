# 製品サイト — 運用とデプロイ

公開URLは [ai.oyobidashi.me](https://ai.oyobidashi.me)。[Astro](https://astro.build/)の静的サイトをCaddyで配信します。APIの `api.oyobidashi.me` とは別の、Railwayの `site` サービスです。

この文書は人間とAIエージェントの共通の手順書です。エージェントは下の「どこまで進めるか」に従い、毎回の確認なしで進めます。

## どこまで進めるか

依頼の言葉で、止まる場所を決めます。

| 依頼 | 進める範囲 |
|---|---|
| 「直して」「変えて」「追加して」など、編集だけの依頼 | 編集 → ビルド → 3幅の表示確認まで。コミット・公開はしない。確認した内容と、公開していないことを報告する |
| 「公開して」「デプロイして」「反映して」「本番に出して」 | 上に加えて、サイト関連ファイルだけをコミット → `main` へpush → デプロイ成功と本番URLの確認まで。途中で確認を挟まない |
| 「今すぐ出して」などpushを待てない、またはpushできない事情がある | `railway up --service site` で手元のコードを直接デプロイし、未コミットであることを報告する |

次の操作は、依頼に明示されていない限り実行しません。必要になったら理由を添えて確認します。

- `railway config apply` で**削除または変更**が出る場合 (追加だけなら実行してよい)
- カスタムドメイン・DNS・`site` 以外のサービス (`api`、`worker`、DB) の変更
- 料金・モデル名・学習利用の有無・ストアURLなど、**製品の事実**の新規記載や変更。依頼者が示した値だけを書き、推測で埋めない
- サイトと無関係な未コミット変更のコミット

## 構成

| 場所 | 内容 |
|---|---|
| `src/pages/index.astro` | ページの組み立て。セクションの順番 |
| `src/components/` | セクションごとの部品 (`Hero`、`Scene`、`Delivery`、`Setup`、`Pricing`、`Faq`、`Download` など) |
| `src/styles/global.css` | 色・書体・レイアウト。全体で1ファイル |
| `src/scripts/main.ts` | ヒーローのデモとコピーボタン |
| `src/config.ts` | ストアURL (`STORE_URLS`) とGitHubのURL |
| `public/` | そのまま配信するファイル (favicon) |
| `Caddyfile` | 配信設定。`$PORT` で待ち受け、`/_astro/*` を長期キャッシュ |
| `../Dockerfile.site` | ビルドと配信イメージ。リポジトリルートがコンテキスト |
| `../.dockerignore` | 許可リスト方式。**`site/` 直下に新しいファイル・ディレクトリを足してDockerで使うなら、ここにも足す** |
| `../cloud/.railway/railway.ts` | Railwayのサービス定義 (`site`) |

## 内容を変えるとき

- **事実の出どころ:** セットアップ手順は `cloud/README.md`・`mcp/README.md`、届き方やMCPツールはルートの `README.md`・`mcp/README.md` が正です。そちらを変えたら `Setup.astro`・`Delivery.astro`・`Faq.astro` も合わせます。サイトだけに書いて実装と食い違わせない。
- **アプリの画面:** 実機のスクリーンショットは `docs/product-reference/<日付>/` にあります。サイト内のスマホ画面や通知の絵は、これを見て描き起こしたものです。アプリの画面や文言が変わったら見比べて直します。参考画像には他社アプリの画面が写っているものがあるので、そのままサイトへ載せない。着信の発信者名は「お呼び出し」、応答後の画面に送信元 (エージェント名) と質問が出ます。
- **ストアURL:** `src/config.ts` の `STORE_URLS` に入れると全ボタンがリンクになります。空のあいだは「近日公開」表示です。
- **料金:** `Pricing.astro`。無料は通話の内容がモデルの学習に使われます。アプリ内課金では通話の内容はモデルの学習に使われません。価格は未記載です。
- **Astroの注意:** テンプレート内の `{` `}` は式として解釈されます。JSONなど波かっこを含む文字列は、frontmatterで変数にして `{変数}` で出します。

## デザインの決まり

「AIが人間に電話をかける世界」を、アプリアイコンのポケベルで表しています。変更してもこの軸を保ちます。

- **色:** `global.css` 冒頭の変数だけを使います。アプリ本体 (`android/app/src/main/res/values/colors.xml`) と同じ値です。クリーム地・墨・ポケベルのオレンジ・緑の液晶。
- **名前:** サイト上のアプリ名は「Oyobidashi」に統一します。ロゴの文字は丸ゴシック (`--logo`、M PLUS Rounded 1c。使う文字だけを読み込んでいるので、ロゴの綴りを変えたら `Base.astro` の `text=` も直す)。端末の画面を描いた絵 (着信画面・通知) だけは、実機の表示名に合わせます。
- **書体:** 見出しは明朝 (`--mincho`)、本文はゴシック (`--gothic`)、液晶ふうのラベルと時刻はドット文字 (`--dot`)、コードは等幅 (`--mono`)。
- **避けるもの:** 紫系のグラデーション、ガラス風のぼかしカード、絵文字アイコン、影つきの角丸カードを並べたグリッド。区切りは罫線と余白で作ります。
- **コントラスト:** オレンジ (`--orange`) の上に白い小さな文字を載せない (約3.3:1で不足)。白文字の地は `--orange-dark`、オレンジ地の文字は墨にします。
- **文体:** 人が書いた短い文にする。見出しは一息で読める長さ。本文は1〜3文で、事実を先に言う。機能名より、使う人の場面で書く。エージェントが「しないこと」(かけ直さない等) も書く。避けるのは、「〜ではありません。〜です」の対比、三つ並べる言い回し、「〜するだけ」「おすすめします」「〜を実現」のような売り文句、同じことの言い換えの繰り返し。
- **幅:** 1000px以下でタブレット、640px以下でスマホの配置。ページ全体が横スクロールしないこと。コードブロックは枠の中でスクロールさせます。
- **動き:** `prefers-reduced-motion` で止まること。ヒーローのデモは静止状態でも内容が伝わること。

## 確認

```sh
bun install --cwd site --frozen-lockfile
bun run --cwd site dev                 # http://localhost:4321 で開発
bun run --cwd site build               # site/dist/ へ出力。エラーなく終わること
./site/scripts/screenshot.sh [出力先]   # ビルドして 1440 / 820 / 390px で撮影
```

ヒーローのスマホ画面は時間で切り替わります。`http://localhost:4321/?demo=ring` のように `?demo=` へ `idle` / `ring` / `ask` / `answer` / `thanks` を付けると、その状態で止めて確認できます。「つかいみち」の場面のアニメーションも同じで、`?scene=1`〜`4` でその場面に止まります。動きを止める設定 (`prefers-reduced-motion`) では場面3で静止し、説明を押すと切り替わります。

見た目に関わる変更では、`screenshot.sh` の画像を実際に開いて確認します。ビルドが通っただけで表示を確認済みとしない。見る点は、見出しの折り返し、文字の切れ・はみ出し、変更した箇所の3幅での配置です。ページが伸びて下が写らなくなったら、スクリプト内のタイル数を増やします。

ヘッドレスChromeは幅500px未満の窓を作れません。`--window-size=390,…` で直接撮ると500px幅の表示を切り取った絵になり、はみ出しを誤認します。スクリプトは指定幅のiframeに入れて撮っています。

## デプロイ

`site` サービスのソースはGitHubの `YusukeIwaki/oyobidashi`・`main` ブランチです。**`main` へpushするとRailwayが自動でビルド・デプロイします。** GitHub Actionsやデプロイ用トークンは使いません。対象は `site/**`、`Dockerfile.site`、`.dockerignore` の変更だけです (`watchPatterns`)。それ以外だけを変えたpushではデプロイされません。

公開までの手順:

```sh
# 1. サイトに関係するファイルだけをコミットする。無関係な変更を巻き込まない
git add site Dockerfile.site .dockerignore
git commit -m "site: <変更の要約>"
git push origin main

# 2. デプロイの結果を見る (先頭が今回のコミットで SUCCESS になること)
railway deployment list --service site
railway logs --service site             # 起動ログ。失敗時の原因もここ

# 3. 本番を確かめる
curl -s -o /dev/null -w "%{http_code}\n" https://ai.oyobidashi.me/
curl -s https://ai.oyobidashi.me/ | grep -c "<変更で入れた文言>"
```

`railway` の操作は、プロジェクトにリンク済みの `cloud/` から実行します (`railway status` でプロジェクト `oyobidashi`・環境 `production` を確認)。ログインが切れていたら、ユーザーに `railway login` を依頼します。トークンを探したり書き出したりしない。

- **pushを待たずに出す:** リポジトリルートから `railway up --service site --ci`。手元の作業ツリーをアップロードしてビルドします。
- **戻す:** 原因のコミットを `git revert` して `main` へpushします。
- **失敗したら:** `railway deployment list --service site` で状態を見て、ビルドログの最初のエラーを読みます。多いのは、`site/` に足したファイルが `.dockerignore` の許可リストにない、`bun.lock` を更新していない (`--frozen-lockfile` で失敗)、の2つです。失敗したデプロイは公開中の版を置き換えないので、サイトは前の版のまま動き続けます。

### Railwayの定義を変えるとき

サービスの定義は `cloud/.railway/railway.ts` です。**定義から消したリソースは削除対象になります。** ダッシュボードでサービスを足すのではなく、このファイルに書いて適用します。

```sh
cd cloud
railway config plan      # 必ず先に差分を見る
railway config apply     # 追加だけのときに実行。変更・削除が出たら確認を取る
```

- `plan` / `apply` にはRailway CLI 5.42.1以降が必要です (5.74.0で確認)。SDKは `PATH` 上の `railway` のバージョンを調べるので、`bunx` で新しい版を呼ぶだけでは通りません。古い場合は一時ディレクトリへ `bun add @railway/cli@5.74.0` して、その `node_modules/.bin` を `PATH` の先頭に置くか、ユーザーにCLIの更新を依頼します。
- 変数は `managed: false` です。`site` には `PORT=8080` だけをRailway側で設定しています。秘密の変数は不要です。
- カスタムドメインもコードでは管理していません (`api` と同じ)。`ai.oyobidashi.me` は転送先ポート8080で割り当て済み、DNS (name.com) のCNAMEと検証用TXTも設定済みです。状態は `railway domain list --service site` で見ます。
- リージョンはAPIと同じSingapore、レプリカ1です。

### 手元でイメージを確かめる

```sh
docker build -f Dockerfile.site -t oyobidashi-site .
docker run --rm -p 8080:8080 oyobidashi-site
```

DockerのディスクがいっぱいだとENOSPCで失敗します。ユーザーのイメージやキャッシュを勝手に消さず、その旨を報告します。Dockerfileと同じファイルだけを別ディレクトリへコピーして `bun install --frozen-lockfile && bun run build` が通るかで代替確認できますが、`.dockerignore` とCaddyの確認にはなりません。
