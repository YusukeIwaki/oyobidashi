import { defineConfig } from "astro/config";

// 完全な静的サイトとして dist/ へ出力し、Caddy で配信する (Dockerfile.site)。
export default defineConfig({
  // 公開URL。OGPの絶対URL (og:url、og:image) の基点になる。
  site: "https://ai.oyobidashi.me",
  output: "static",
  server: { host: true },
});
