#!/bin/sh
# OGP画像 (リンクカード用、1200×630) を site/og/og.html から書き出す。
#   ./site/scripts/og-image.sh
# 出力: site/public/og.png。絵柄や文言を変えたら実行し、画像を開いて確かめてからコミットする。
# 書体はmacOSのヒラギノ角ゴを使うので、macOSで実行する。
set -eu
site=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
out="$site/public/og.png"

[ -x "$chrome" ] || { echo "Chromeが見つかりません。CHROME=<実行ファイル> を指定してください。" >&2; exit 1; }

"$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=3000 --window-size=1200,630 \
  --screenshot="$out" "file://$site/og/og.html" >/dev/null 2>&1

size=$(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixel/ { printf "%s ", $2 }')
[ "$size" = "1200 630 " ] || { echo "og.png が 1200×630 になっていません: $size" >&2; exit 1; }
echo "$out"
