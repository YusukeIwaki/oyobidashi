import { defineConfig } from "astro/config";

// 完全な静的サイトとして dist/ へ出力し、Caddy で配信する (Dockerfile.site)。
export default defineConfig({
  output: "static",
  server: { host: true },
});
