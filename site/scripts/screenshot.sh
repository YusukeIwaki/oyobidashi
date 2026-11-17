#!/bin/sh
# 製品サイトをビルドし、PC・タブレット・スマホ幅で撮影する。
#   ./site/scripts/screenshot.sh [出力ディレクトリ]
# 出力: <幅>-<連番>.png (上から順のタイル)。既定の出力先は一時ディレクトリ。
# ヘッドレスChromeは幅500px未満の窓を作れないため、指定幅のiframeに入れて撮る。
set -eu
site=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/oyobidashi-site-shots.XXXXXX")}
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
port=${PORT:-4391}
tile=1400

[ -x "$chrome" ] || { echo "Chromeが見つかりません。CHROME=<実行ファイル> を指定してください。" >&2; exit 1; }
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)

cd "$site"
bun run build >/dev/null
# astro preview は常駐プロセスを別に起動するので、killではなく stop で止める。
bunx astro preview stop >/dev/null 2>&1 || true
bunx astro preview --port "$port" >/dev/null 2>&1 &
trap 'bunx astro preview stop >/dev/null 2>&1 || true' EXIT INT TERM
tries=0
until curl -sf -o /dev/null "http://localhost:$port/"; do
  tries=$((tries + 1))
  [ "$tries" -lt 40 ] || { echo "プレビューサーバーが起動しません。" >&2; exit 1; }
  sleep 0.25
done

# 幅:タイル数 (ページが伸びたら数を増やす)
for spec in 1440:6 820:6 390:6; do
  width=${spec%%:*}
  count=${spec##*:}
  window=$width
  [ "$window" -ge 500 ] || window=500
  i=0
  while [ "$i" -lt "$count" ]; do
    offset=$((i * tile))
    frame="$out/.frame-$width.html"
    printf "<body style='margin:0;overflow:hidden'><iframe src='http://localhost:%s/' style='border:0;width:%spx;height:20000px;margin-top:-%spx'></iframe>" \
      "$port" "$width" "$offset" > "$frame"
    "$chrome" --headless=new --hide-scrollbars --force-prefers-reduced-motion \
      --virtual-time-budget=5000 --window-size="$window,$tile" \
      --screenshot="$out/$width-$i.png" "file://$frame" >/dev/null 2>&1
    i=$((i + 1))
  done
  rm -f "$out/.frame-$width.html"
done
echo "$out"
