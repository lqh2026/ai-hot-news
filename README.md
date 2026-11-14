# AI Hot News

AI 科技资讯聚合站。架构已从「浏览器直连 Anthropic API」改为「Pages Functions 代理 + KV 缓存」，
解决了三个致命问题：密钥暴露在前端、中国大陆网络下请求被拒、每个访客各跑一次搜索无法共享结果。

## 架构

```
浏览器  ──GET /api/news──▶  Pages Function (functions/api/news.js)
                                    │
                                    ├─▶ KV 缓存命中（25 分钟内）→ 直接返回
                                    │
                                    └─▶ Anthropic Messages API + web_search
                                              │
                                              └─▶ 清洗 / 去重 / 评分 → 写回 KV
```

关键设计：

- **密钥仅存服务端**：`ANTHROPIC_API_KEY` 通过环境变量注入，前端不再需要用户输入 Key。
- **全员共享一份数据**：结果写入 KV，所有访客读到同一份资讯与同一套评分，这才是"同步"。
- **陈旧优先刷新**：缓存超过 25 分钟后先返回旧数据，再后台异步刷新，访客不必等待 20–40 秒的联网检索。
- **模型降级链**：`MODEL_CHAIN` 中任一模型下线会自动切换下一个，不再因硬编码模型 ID 整体失效。
- **错误可诊断**：401/403/429/404 分别映射为独立错误码，页面直接显示原因与处置建议，不再静默降级为假数据。

## 目录结构

```
index.html              前端（单文件）
functions/api/news.js   接口：抓取 / 清洗 / 评分 / 缓存
dev-server.mjs          本地调试服务器（无需 wrangler）
test/api.test.mjs       接口逻辑测试
wrangler.toml           Pages 项目与 KV 绑定配置
```

## 本地开发

```bash
npm run dev
# 或指定 Key
ANTHROPIC_API_KEY=sk-ant-xxx npm run dev
```

访问 http://127.0.0.1:8788 。也可将 Key 写入 `.dev.vars`（已加入 `.assetsignore`）：

```
ANTHROPIC_API_KEY=sk-ant-xxx
```

## 部署到 Cloudflare Pages

```bash
# 1. 创建 KV 命名空间，把返回的 id 填入 wrangler.toml
npx wrangler kv namespace create NEWS_KV

# 2. 注入密钥（不要写进代码或 wrangler.toml）
npx wrangler pages secret put ANTHROPIC_API_KEY

# 3. 部署
npx wrangler pages deploy .
```

或在 Cloudflare 控制台连接本仓库，构建设置留空、输出目录填 `.`，再于
Settings → Functions → KV namespace bindings 中绑定 `NEWS_KV`，于环境变量中添加 `ANTHROPIC_API_KEY`。

## 接口

`GET /api/news` 参数：`force=1` 跳过缓存强制刷新。

成功响应：

```json
{
  "updatedAt": "2026-11-11T15:04:00.000Z",
  "model": "claude-sonnet-4-5-20250929",
  "cached": false,
  "items": [
    {
      "id": "kx3f9a",
      "title": "标题",
      "desc": "摘要",
      "source": "Anthropic",
      "url": "https://...",
      "publishedAt": "2026-11-11T08:30:00.000Z",
      "tags": ["大模型"],
      "reason": "入选理由",
      "score": 95
    }
  ],
  "stats": { "total": 14, "avgScore": 83, "sources": 9 }
}
```

失败响应：`{ "error": "UPSTREAM_FORBIDDEN", "message": "..." }`，状态码 4xx/5xx。
若有可用旧缓存，则返回 200 并携带 `stale: true` 与 `error` 字段，页面顶部显示横幅提示。

## 故障排查

| 错误码 | 含义 | 处置 |
| --- | --- | --- |
| `NO_API_KEY` | 未配置环境变量 | 执行 `wrangler pages secret put ANTHROPIC_API_KEY` |
| `UPSTREAM_FORBIDDEN` | 403，Anthropic 拒绝请求 | 函数运行区域受限或 Key 权限不足；确认部署在 Cloudflare 海外节点 |
| `UPSTREAM_AUTH` | 401，Key 无效 | 更换 Key |
| `MODEL_NOT_FOUND` | 模型已下线 | 更新 `wrangler.toml` 中 `MODEL_CHAIN` |
| `PARSE_FAILED` | 模型输出非 JSON | 通常为 `max_tokens` 不足，已设 4096 并内置截断抢救 |
| `UPSTREAM_TIMEOUT` | 检索超时 | 降低 `max_uses` 或改用定时预热 |

## 已知边界

- 前端侧边栏的「收藏 / 信源提报 / 精选策略 / 策略迭代 / 系统 / 用户」尚无后端数据源，页面会明确提示未接入，而非假装可用。
- 首次冷启动需等待一次完整检索（约 20–40 秒），之后由缓存承接。可用外部定时器定期请求 `/api/news?force=1` 预热。
- 匿名 KV 缓存不区分用户，评分策略一旦调整需等缓存过期或手动 `force=1` 才对全部访客生效。

## 项目地址

https://github.com/lqh2026/ai-hot-news
