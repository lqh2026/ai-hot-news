#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-v1.0.0}"
DIST="$ROOT/dist"
STAGE="$DIST/stage"

mkdir -p "$STAGE"

build_one() {
  local goos="$1"
  local goarch="$2"
  local folder="$3"
  local bin_name="$4"

  local out_dir="$STAGE/$folder"
  mkdir -p "$out_dir/bin" "$out_dir/web/js" "$out_dir/data" "$out_dir/agent"

  echo "building $goos/$goarch -> $folder"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags "-s -w" -o "$out_dir/bin/$bin_name" "$ROOT/server/main.go"

  cp "$ROOT/index.html" "$out_dir/web/index.html"
  cp "$ROOT/js/core.js" "$out_dir/web/js/core.js"
  cp "$ROOT/data/news.json" "$out_dir/data/news.json"
  cp "$ROOT/agent/SKILL.md" "$out_dir/agent/SKILL.md"
  cp "$ROOT/README.md" "$out_dir/README.md"

  cat > "$out_dir/AGENTS.md" <<'EOF'
# Agent 接入说明

把本安装包发给任意 AI Agent 后，请先阅读 `agent/SKILL.md`。

目标：启动本地 AI Hot News，并按用户要求自定义 `data/news.json` / `PUT /api/news`，让网页展示该用户自己的科技资讯。

启动后访问 http://127.0.0.1:8787/
EOF

  if [ "$goos" = "windows" ]; then
    cat > "$out_dir/start.bat" <<'EOF'
@echo off
cd /d "%~dp0"
start "" "%~dp0bin\ai-hot-news.exe" --port 8787
echo AI Hot News is starting at http://127.0.0.1:8787/
echo Send this folder to any AI Agent and ask it to read agent\SKILL.md
pause
EOF
    unix2dos "$out_dir/start.bat" >/dev/null 2>&1 || true
  else
    cat > "$out_dir/start.command" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
chmod +x ./bin/ai-hot-news
./bin/ai-hot-news --port 8787
EOF
    chmod +x "$out_dir/start.command" "$out_dir/bin/$bin_name"
  fi
}

cd "$ROOT"
build_one windows amd64 "AI-Hot-News-${VERSION}-windows-x64" "ai-hot-news.exe"
build_one darwin amd64 "AI-Hot-News-${VERSION}-macos-intel" "ai-hot-news"
build_one darwin arm64 "AI-Hot-News-${VERSION}-macos-apple-silicon" "ai-hot-news"

mkdir -p "$DIST"
(
  cd "$STAGE"
  for d in *; do
    zip -qr "$DIST/${d}.zip" "$d"
  done
)

echo "release artifacts:"
ls -lh "$DIST"/*.zip
