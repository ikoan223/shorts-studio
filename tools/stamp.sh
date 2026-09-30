#!/bin/sh
# Stamp a version onto every module import and asset link so browsers fetch fresh files after each release.
# Usage: sh tools/stamp.sh 2026.09.30-3
set -e
V="$1"; [ -n "$V" ] || { echo "usage: $0 VERSION"; exit 1; }
cd "$(dirname "$0")/.."
sed -i -E "s#(from '\./[a-z]+\.js)(\?v=[^']*)?'#\1?v=$V'#g" js/*.js
sed -i -E "s#(href=\"css/app\.css)(\?v=[^\"]*)?\"#\1?v=$V\"#; s#(src=\"js/app\.js)(\?v=[^\"]*)?\"#\1?v=$V\"#" index.html
sed -i -E "s#^export const VERSION = '[^']*';#export const VERSION = '$V';#" js/state.js
echo "stamped $V"
