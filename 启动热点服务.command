#!/bin/bash
# 双击运行：启动本地中转服务并打开热点页
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"

# 若端口已被占用，直接打开页面
if curl -s --max-time 2 "http://127.0.0.1:${PORT}/health" | grep -q '"ok"'; then
  echo "中转服务已在运行，直接打开页面..."
  open "http://127.0.0.1:${PORT}/ai-hotspots-online.html"
  exit 0
fi

echo "正在启动 AI 热点中转服务..."
if ! python3 -c "import segno" >/dev/null 2>&1; then
  echo "提示：未安装 segno，二维码将尝试在线生成；失败时仍可在页面手动复制地址。"
  echo "      离线生成二维码可执行：python3 -m pip install segno"
fi
python3 hotspots_relay.py &
RELAY_PID=$!

for _ in $(seq 1 20); do
  sleep 0.5
  if curl -s --max-time 2 "http://127.0.0.1:${PORT}/health" | grep -q '"ok"'; then
    break
  fi
done

open "http://127.0.0.1:${PORT}/ai-hotspots-online.html"

echo ""
echo "页面右上角「📱 手机查看」可扫码在手机打开（需同一 WiFi）。"
echo "关闭此窗口或按 Ctrl+C 可停止服务。"
wait $RELAY_PID
