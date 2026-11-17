# AI Hot News

中文 AI 热点资讯项目，包含两套实现。

## 1. AI 热点在线版（当前推荐）

文件：`ai-hotspots-online.html` + `hotspots_relay.py`

九个信源并发抓取（量子位、36氪快讯、极客公园、爱范儿、奇客 Solidot、少数派、OpenAI、Anthropic、虎嗅），服务端解析 RSS 与 HTML，浏览器端按日期分组展示。

主要功能：
- 侧边栏六项：精选（总分 ≥75）、全部 AI 动态、热点榜（Top5 含热度与来源日期）、AI 日报、主题、收藏
- 关键词分类与搜索；自定义 RSS 信源支持「名称|地址」，附 9 个常用公众号公开 feed 一键填入
- 公众号订阅：搜狗微信检索；受出口 IP 限制时建议改用 Wechat2RSS 公开 feed
- AI 增强：OpenAI 兼容接口筛选、评分、理由与今日速览，失败自动回退规则评分
- 收藏（localStorage）、品牌自定义（名称/小字/LOGO）、深浅色切换、手机查看入口

运行：
```bash
pip install -r requirements.txt
python3 hotspots_relay.py
# 打开 http://127.0.0.1:8787/ai-hotspots-online.html
```
也可双击 `启动热点服务.command`；公网访问用 `启动公网访问.command`（免费隧道地址会轮换）。

中转服务监听 `PORT` 环境变量（默认 8787），默认绑定 `0.0.0.0`；`RELAY_HOST=127.0.0.1` 可收回本机。含 SSRF 白名单与 90 秒抓取缓存。

## 2. 纯前端 Demo（保留）

文件：`index.html` + `app.js`

基于 Anthropic Messages API（`web_search`）在浏览器端生成资讯，无后端服务。填入自己的 API Key 即可使用；含 CSP、时间轴、标签筛选与错误透明化。API 调用费用由使用者自行承担。

## 数据说明

公众号文章优先使用 Wechat2RSS 公开 feed：`https://wechat2rss.xlab.app/list/all.html`。搜狗微信通道对部分出口 IP 限流，不保证可用。
