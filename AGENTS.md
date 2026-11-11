# Agent 接入说明

先阅读 `agent/SKILL.md`。

目标：启动本地 AI Hot News，并按用户要求自定义 `data/news.json` 或 `PUT /api/news`，让网页展示该用户自己的科技资讯。

开发环境启动：

```bash
go run ./server --port 8787 --no-open
```

启动后访问 http://127.0.0.1:8787/
