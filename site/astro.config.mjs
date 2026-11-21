import { defineConfig } from "astro/config";

// 完全な静的サイトとして dist/ へ出力し、Caddy で配信する (Dockerfile.site)。
export default defineConfig({
  // canonical、OGP、構造化データ、サイトマップの絶対URLの基点。
  site: "https://ai.oyobidashi.me",
  output: "static",
  server: { host: true },
});
