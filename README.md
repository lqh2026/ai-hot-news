# AI Hot News

基于 Anthropic Messages API 的中文 AI 资讯单页应用。在浏览器中填入自己的 API Key，点击「刷新」后由模型联网搜索并生成 10 条资讯，前端按标签筛选并以时间轴展示。

> 本项目是**纯前端 Demo**，仓库只包含静态页面与脚本，没有后端服务、定时任务或数据流水线。

## 当前实现

- 通过 Anthropic Messages API（`web_search` 工具）联网抓取并生成中文资讯
- 标签筛选（9 个固定标签）、评分展示、来源与推荐理由
- 手动刷新、请求超时控制、防重复请求；失败时展示真实错误信息与重试入口，**不再回退到内置假数据**
- 依据资讯原文发布时间渲染时间轴，时间未知时显示 `--:--`（不生成随机时间）
- 所有来自模型的字段在渲染前统一 HTML 转义；URL 做协议白名单校验；外链使用 `noopener,noreferrer`
- 通过 CSP 限制脚本来源（仅同源 `app.js`）、网络连接（仅本站与 Anthropic API）与资源加载
- 响应式布局（PC / 移动端）、固定深色主题、键盘可访问

## 运行方式

1. 在仓库设置中开启 GitHub Pages，或直接用浏览器打开 `index.html`。
2. 填入自己的 Anthropic API Key，点击「开始使用」。
3. 点击右上角「刷新」获取资讯。

API 调用与联网搜索会**产生费用**，费用由使用者自己的 Key 承担。侧栏「重置 API Key」可随时清除本地凭据。

## 配置

编辑 `app.js` 顶部的 `CONFIG`：

| 字段 | 说明 |
| --- | --- |
| `MODEL` | 模型 ID。若 API 返回 `model_not_found`，请用 Models API 核对可用 ID 后替换 |
| `API_VERSION` | `anthropic-version` 请求头 |
| `MAX_TOKENS` | 输出上限，过小会导致 JSON 被截断并触发明确的错误提示 |
| `TIMEOUT_MS` | 单次请求超时（毫秒） |
| `ALLOWED_TAGS` | 允许渲染的标签白名单 |

## 安全说明

- API Key 保存在浏览器 `localStorage`，并通过 Anthropic 的 `anthropic-dangerous-direct-browser-access` 头直连 API。共享设备、浏览器扩展或同源脚本都可能读取该 Key。
- **生产环境应改为服务端代理**：Key 放在服务端环境变量，前端只请求自有后端。
- 已采取的防护：统一 HTML 转义、字段类型校验与标签白名单、URL 协议白名单、错误信息通过 `textContent` 输出、CSP 限制 `script-src` / `connect-src` / `img-src`。

## 已知限制 / 规划中

以下功能**尚未实现**，侧栏中对应入口为占位，点击会明确提示而非切换到同一份数据：

- 关键词搜索、热点排序、暗黑模式切换、收藏、信源提报、后台管理
- 多 Agent 采集 / 摘要 / 翻译流水线、定时自动更新（当前为手动刷新）
- 服务端代理、结果缓存、自动化测试与 CI

资讯内容与原文链接由模型联网搜索生成，可能存在不准确或链接失效的情况，请以来源站点为准。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构与样式（含 CSP），无内联脚本与内联事件 |
| `app.js` | 配置、API 调用、数据校验、渲染与交互（事件委托） |
| `README.md` | 本文档 |

## 项目地址

https://github.com/lqh2026/ai-hot-news
