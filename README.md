# AI Hot News
🔥 AI 科技资讯自动聚合与动态网页生成平台

## 项目介绍
AI Hot News 是一个基于 **Hermes Agent + OpenClaw** 多智能体协作开发的全自动科技资讯聚合网站。
通过多 Agent 工作流实现：内容抓取 → 智能过滤 → 摘要生成 → 翻译优化 → 网页渲染全流程自动化，
为开发者和 AI 爱好者提供实时、高质量、干净整洁的科技资讯阅读入口。

## 核心功能
- 多源头 AI 科技资讯自动采集与更新
- 基于长上下文推理的内容质量筛选
- 自动摘要、智能翻译与内容结构化
- 响应式网页，支持 PC / 移动端适配
- 暗黑模式、关键词搜索、热点排序

## 技术栈
- Agent 框架：Hermes Agent、OpenClaw
- 前端：HTML / CSS / JavaScript
- 数据处理：RSS 解析、文本清洗、AI 摘要

## 规划与展望
本项目计划全面接入 **MiMo 大模型**，构建新一代资讯 Agent：
- 更强的长文本理解与多文档关联能力
- 深度内容解读与行业趋势分析
- 大幅降低 API 成本，提升系统稳定性
- 实现更智能的个性化推荐与自动推送

## Releases 安装包

从 GitHub Releases 下载对应系统压缩包：

- Windows x64：`AI-Hot-News-v1.0.0-windows-x64.zip`
- macOS Intel：`AI-Hot-News-v1.0.0-macos-intel.zip`
- macOS Apple Silicon：`AI-Hot-News-v1.0.0-macos-apple-silicon.zip`

解压后：

Windows 双击 `start.bat`  
macOS 双击 `start.command`

浏览器会打开 `http://127.0.0.1:8787/`。资讯内容来自安装包内的 `data/news.json`。

## 发给任意 AI Agent

把整个解压目录发给其他 AI Agent，并让它阅读 `agent/SKILL.md`。Agent 可以通过：

```bash
curl -X PUT http://127.0.0.1:8787/api/news -H "Content-Type: application/json" -d '{"items":[...]}'
```

自定义网页上的科技资讯。

本地开发：

```bash
# 单元测试
npm test
go test ./server

# 构建安装包
bash scripts/build-releases.sh v1.0.0
```

## 项目地址
https://github.com/lqh2026/ai-hot-news
