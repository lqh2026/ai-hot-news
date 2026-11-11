(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AiHotNews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ALLOWED_TAGS = ['Agent', '产品更新', '大模型', '具身智能', '开源', '研究', '工具', '搜索'];

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isValidApiKey(val) {
    return typeof val === 'string' && val.trim().startsWith('sk-ant');
  }

  function filterNews(news, tag) {
    if (!Array.isArray(news)) return [];
    if (tag === '全部') return news;
    return news.filter(function (n) {
      return (n.tags || []).includes(tag);
    });
  }

  function extractTextFromApiResponse(data) {
    return ((data && data.content) || [])
      .filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('');
  }

  function parseNewsJson(text) {
    var cleaned = String(text || '').replace(/```json|```/g, '').trim();
    var s = cleaned.indexOf('[');
    var e = cleaned.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('no json array');
    var parsed = JSON.parse(cleaned.slice(s, e + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty');
    return parsed;
  }

  function normalizeScore(score) {
    return Number(score) || 72;
  }

  function isHighScore(score) {
    return normalizeScore(score) >= 80;
  }

  function resolveItemUrl(item) {
    if (item && item.url && String(item.url).startsWith('http')) {
      return { open: true, url: item.url };
    }
    return { open: false, title: (item && item.title) || '' };
  }

  function timelineHour(index) {
    return String(Math.max(0, 6 - Math.floor(index * 0.7))).padStart(2, '0');
  }

  function formatDateLabel(date, count) {
    var todayStr = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    return todayStr + ' · 共 ' + count + ' 条';
  }

  function formatPromptDate(date) {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatUpdateTime(date) {
    return '更新于 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function padMinute(value) {
    return String(Math.floor(Number(value) || 0) % 60).padStart(2, '0');
  }

  function defaultSource(source) {
    return source || 'AI资讯';
  }

  function emptyFeedHtml() {
    return '<div class="state-box"><div class="state-text">该分类暂无资讯</div></div>';
  }

  function loadingFeedHtml() {
    return '<div class="state-box"><div class="spinner"></div><div class="state-text">正在抓取最新 AI 资讯...</div><div class="state-sub">联网搜索中，请稍候</div></div>';
  }

  function errorFeedHtml(msg, showReset) {
    return '<div class="state-box"><div class="state-text">' + escHtml(msg) + '</div>' +
      (showReset ? '<button class="btn" onclick="resetApiKey()">重新设置 API Key</button>' : '') +
      '</div>';
  }

  function renderNewsItem(item, index, isLast, minute) {
    var tags = (item.tags || []).map(function (t) {
      return '<span class="card-tag">' + escHtml(t) + '</span>';
    }).join('');
    var score = normalizeScore(item.score);
    var time = timelineHour(index) + ':' + padMinute(minute);
    return '<div class="tl-item">' +
      '<div class="tl-left">' +
      '<span class="tl-time">' + time + '</span>' +
      '<div class="tl-dot"></div>' +
      (isLast ? '' : '<div class="tl-line"></div>') +
      '</div>' +
      '<div class="tl-card" onclick="openItem(' + index + ')">' +
      '<div class="card-source">' + escHtml(defaultSource(item.source)) + '</div>' +
      '<div class="card-title">' + escHtml(item.title) + '</div>' +
      '<div class="card-desc">' + escHtml(item.desc || '') + '</div>' +
      '<div class="card-tags">' + tags + '</div>' +
      '<div class="card-footer">' +
      '<div class="card-score' + (isHighScore(score) ? ' high' : '') + '">' + score + '</div>' +
      '<div class="card-reason">' + escHtml(item.reason || '') + '</div>' +
      '</div></div></div>';
  }

  function buildFeedHtml(items, date, minutes) {
    if (!items || !items.length) return emptyFeedHtml();
    var html = '<div class="date-label">' + formatDateLabel(date, items.length) + '</div>';
    for (var i = 0; i < items.length; i++) {
      html += renderNewsItem(items[i], i, i === items.length - 1, minutes && minutes[i]);
    }
    return html;
  }

  function normalizeNewsItem(item) {
    if (!item || typeof item !== 'object') return null;
    var title = String(item.title || '').trim();
    if (!title) return null;
    var tags = Array.isArray(item.tags)
      ? item.tags.filter(function (t) { return ALLOWED_TAGS.indexOf(t) !== -1; })
      : [];
    return {
      title: title,
      desc: String(item.desc || ''),
      source: defaultSource(item.source),
      url: String(item.url || ''),
      tags: tags,
      reason: String(item.reason || ''),
      score: normalizeScore(item.score)
    };
  }

  function normalizeNewsList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeNewsItem).filter(Boolean);
  }

  function parseNewsPayload(payload) {
    if (Array.isArray(payload)) return normalizeNewsList(payload);
    if (payload && Array.isArray(payload.items)) return normalizeNewsList(payload.items);
    return [];
  }

  function buildApiRequestBody(dateStr) {
    return {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: '今天是' + dateStr + '。请搜索今天最新的AI热点资讯，包括大模型发布、AI产品更新、研究突破、开源项目等。\n\n返回一个JSON数组，包含10条资讯，每条格式如下：\n{\n  "title": "标题（中文，简洁有力）",\n  "desc": "简介（中文，60字以内，说明核心内容）",\n  "source": "来源网站或媒体名称",\n  "url": "原文链接（如有）",\n  "tags": ["标签1","标签2"],\n  "reason": "推荐理由（20字以内，中文）",\n  "score": 评分数字(60-99)\n}\n\ntags 只从以下选择：' + ALLOWED_TAGS.join('、') + '\n\n只返回纯JSON数组，不要任何markdown格式或多余文字。'
      }]
    };
  }

  function fallbackNews() {
    return [
      { title: 'Claude 4 Sonnet 正式发布，代码能力大幅提升', desc: 'Anthropic发布Claude 4 Sonnet，在代码生成、推理和多步骤任务处理方面有显著进步，支持更长上下文窗口。', source: 'Anthropic Blog', url: 'https://anthropic.com', tags: ['产品更新', '大模型'], reason: '代码能力跃升，多步骤任务更强', score: 88 },
      { title: 'Google Gemini 3.1 Pro 上线，ARC-AGI-2得分77.1%', desc: 'Google DeepMind发布Gemini 3.1 Pro，拥有100万token上下文，ARC-AGI-2得分77.1%，与GPT-5.4并列基准榜第一。', source: 'Google DeepMind', url: 'https://deepmind.google', tags: ['大模型', '产品更新'], reason: '百万token上下文，推理基准全球第一', score: 85 },
      { title: 'Chrome 推出 AI Mode：地址栏变身智能搜索入口', desc: 'Chrome浏览器正式推出AI Mode，通过AI技术重构网页浏览体验，用户无需跳转即可进行智能对话式搜索。', source: 'Google Blog', url: 'https://blog.google', tags: ['产品更新', '搜索'], reason: 'Chrome地址栏变身AI搜索入口', score: 78 },
      { title: 'video-use 开源：Claude Code 自动剪辑视频', desc: 'browser-use团队发布video-use，把素材丢进文件夹，Claude自动裁剪口头语、调色、加字幕，输出final.mp4。', source: 'GitHub', url: 'https://github.com', tags: ['工具', '开源', 'Agent'], reason: 'AI自动剪辑视频，素材进成品出', score: 76 },
      { title: 'Meta Llama 4 开源，支持多模态与本地部署', desc: 'Meta发布Llama 4系列多个规模版本，全面支持多模态输入，开发者可本地运行，开源社区反响热烈。', source: 'Meta AI', url: 'https://ai.meta.com', tags: ['开源', '大模型'], reason: 'Meta旗舰开源，本地跑无需API', score: 82 },
      { title: 'OpenAI 推出 GPT-5.4，专注企业级推理任务', desc: 'OpenAI发布GPT-5.4，针对企业级复杂推理场景优化，在法律文书、财务分析等专业领域表现突出。', source: 'OpenAI Blog', url: 'https://openai.com', tags: ['大模型', '产品更新'], reason: '企业推理专项优化，专业任务更强', score: 80 },
      { title: '具身智能新突破：机器人完成精细外科手术操作', desc: '斯坦福团队展示AI驱动机器人完成精细外科手术，操作精度达到人类外科医生水平，引发医疗AI广泛讨论。', source: 'Stanford AI Lab', url: 'https://ai.stanford.edu', tags: ['具身智能', '研究'], reason: '机器人手术精度达人类水平', score: 74 },
      { title: 'Anthropic 发布 Agent 构建框架正式版', desc: 'Anthropic推出面向开发者的Agent构建工具正式版，支持工具调用、持久记忆和多步推理，大幅降低开发门槛。', source: 'Anthropic', url: 'https://anthropic.com', tags: ['Agent', '产品更新'], reason: '官方框架，Agent开发更简单', score: 75 },
      { title: 'DeepSeek R2 发布，推理速度提升300%', desc: 'DeepSeek发布R2推理模型，推理速度较上代提升300%，成本大幅降低，在数学和代码基准上表现优异。', source: 'DeepSeek', url: 'https://deepseek.com', tags: ['大模型', '开源'], reason: '推理速度提升3倍，成本更低', score: 83 },
      { title: 'Perplexity AI 获得新一轮融资，估值达150亿美元', desc: 'AI搜索引擎Perplexity AI完成新一轮融资，估值达150亿美元，计划扩大模型自研和国际市场布局。', source: 'TechCrunch', url: 'https://techcrunch.com', tags: ['产品更新', '搜索'], reason: 'AI搜索赛道持续升温', score: 70 }
    ];
  }

  return {
    ALLOWED_TAGS: ALLOWED_TAGS,
    escHtml: escHtml,
    isValidApiKey: isValidApiKey,
    filterNews: filterNews,
    extractTextFromApiResponse: extractTextFromApiResponse,
    parseNewsJson: parseNewsJson,
    normalizeScore: normalizeScore,
    isHighScore: isHighScore,
    resolveItemUrl: resolveItemUrl,
    timelineHour: timelineHour,
    formatDateLabel: formatDateLabel,
    formatPromptDate: formatPromptDate,
    formatUpdateTime: formatUpdateTime,
    padMinute: padMinute,
    defaultSource: defaultSource,
    emptyFeedHtml: emptyFeedHtml,
    loadingFeedHtml: loadingFeedHtml,
    errorFeedHtml: errorFeedHtml,
    renderNewsItem: renderNewsItem,
    buildFeedHtml: buildFeedHtml,
    buildApiRequestBody: buildApiRequestBody,
    normalizeNewsItem: normalizeNewsItem,
    normalizeNewsList: normalizeNewsList,
    parseNewsPayload: parseNewsPayload,
    fallbackNews: fallbackNews
  };
});
