# AI Hot News Skill

把本目录（或整个 Releases 包）交给任意 AI Agent。Agent 读取本文件后，即可启动并自定义 AI Hot News 网页平台。

## 这是什么

AI Hot News 是一个本地科技资讯网页：

- 默认读取 `data/news.json`
- 浏览器打开 `http://127.0.0.1:8787/`
- 通过 `GET/PUT /api/news` 更新资讯，页面刷新即可看到自己的内容

## 启动

在解压后的安装包根目录执行：

Windows:

```bat
start.bat
```

macOS:

```bash
chmod +x start.command
./start.command
```

也可以直接运行二进制：

```bash
./bin/ai-hot-news --port 8787
```

启动成功后访问 `http://127.0.0.1:8787/`。健康检查：`GET /api/health`。

## 给 Agent 的标准工作流

1. 确认安装包已解压，存在 `bin/ai-hot-news`（macOS）或 `bin/ai-hot-news.exe`（Windows）、`web/index.html`、`data/news.json`。
2. 如服务未运行，启动它。
3. 根据用户要求生成资讯列表。每条必须是：

```json
{
  "title": "标题",
  "desc": "简介，60字以内",
  "source": "来源",
  "url": "https://example.com",
  "tags": ["大模型"],
  "reason": "推荐理由",
  "score": 85
}
```

`tags` 只能从：`Agent`、`产品更新`、`大模型`、`具身智能`、`开源`、`研究`、`工具`、`搜索`。
`score` 范围 60-99。

4. 用 PUT 覆盖当前资讯：

```bash
curl -X PUT http://127.0.0.1:8787/api/news \
  -H "Content-Type: application/json" \
  -d '{"items":[{"title":"示例","desc":"简介","source":"Agent","url":"https://example.com","tags":["Agent"],"reason":"自定义资讯","score":80}]}'
```

也可以直接写 `data/news.json`，然后重启服务或再次 PUT。

5. 告诉用户打开 `http://127.0.0.1:8787/` 查看自己的资讯页。

## API

- `GET /api/health` 服务是否可用
- `GET /api/news` 读取当前资讯
- `PUT /api/news` 或 `POST /api/news` 全量替换资讯
  - Body 可以是数组 `[{...}]`
  - 也可以是对象 `{"items":[{...}]}`

## 约束

- 只改 `data/news.json` 和通过 `/api/news` 更新内容。
- 不要把用户的 API Key 写进仓库或安装包。
- 页面仍支持 Anthropic API 实时抓取；自定义平台内容以本地 `news.json` 为准。
