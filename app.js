'use strict';

// 集中配置：模型 ID 或 API 版本失效时，只需修改这里并用 Models API 核对。
const CONFIG = {
  API_URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  MODEL: 'claude-sonnet-4-20250514',
  MAX_TOKENS: 4000,
  TIMEOUT_MS: 60000,
  STORAGE_KEY: 'ai_hot_api_key',
  ALLOWED_TAGS: ['Agent', '产品更新', '大模型', '具身智能', '开源', '研究', '工具', '搜索'],
};

const $ = (id) => document.getElementById(id);

let allNews = [];
let visibleNews = [];
let activeFilter = '全部';
let API_KEY = '';
let loading = false;
let lastFetchedAt = null;

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function parseModelText(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  const candidate = (start !== -1 && end > start) ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(candidate);
}

// 对模型返回的每条数据做类型校验与白名单过滤，避免渲染层因脏数据抛错。
function normalizeNews(value) {
  if (!Array.isArray(value)) throw new Error('模型返回内容不是数组');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
    if (!title) return null;

    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === 'string' && CONFIG.ALLOWED_TAGS.includes(t)).slice(0, 4)
      : [];
    const numericScore = Number(raw.score);
    const score = Number.isFinite(numericScore)
      ? Math.min(99, Math.max(0, Math.round(numericScore)))
      : null;
    const parsedDate = typeof raw.publishedAt === 'string' && raw.publishedAt
      ? new Date(raw.publishedAt)
      : null;

    return {
      title,
      desc: typeof raw.desc === 'string' ? raw.desc.trim().slice(0, 300) : '',
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 80) : '未标注来源',
      url: safeUrl(raw.url),
      tags,
      reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 80) : '',
      score,
      publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    };
  }).filter(Boolean);
}

function setUpdateLabel(text) {
  $('update-time').textContent = text;
}

function renderState(title, detail, actions) {
  const feed = $('feed');
  feed.textContent = '';
  const box = document.createElement('div');
  box.className = 'state-box';

  const heading = document.createElement('div');
  heading.className = 'state-text';
  heading.textContent = title;
  box.appendChild(heading);

  if (detail) {
    const description = document.createElement('div');
    description.className = 'state-detail';
    description.textContent = detail;
    box.appendChild(description);
  }

  if (actions && actions.length) {
    const row = document.createElement('div');
    row.className = 'state-actions';
    actions.forEach((entry) => {
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.dataset.action = entry.action;
      button.textContent = entry.label;
      row.appendChild(button);
    });
    box.appendChild(row);
  }

  feed.appendChild(box);
}

function showError(title, detail, canResetKey) {
  setUpdateLabel('获取失败');
  const actions = [{ action: 'refresh', label: '重试' }];
  if (canResetKey) actions.push({ action: 'reset-key', label: '重新设置 API Key' });
  renderState(title, detail, actions);
}

function syncFilterButtons() {
  document.querySelectorAll('.tag-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
  });
}

function renderNews() {
  const filtered = activeFilter === '全部'
    ? allNews.slice()
    : allNews.filter((item) => item.tags.includes(activeFilter));
  visibleNews = filtered;

  if (!visibleNews.length) {
    renderState('该分类暂无资讯', '切换到「全部」，或点击右上角「刷新」重新获取。');
    return;
  }

  const datePart = lastFetchedAt
    ? lastFetchedAt.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' · '
    : '';
  const timePart = lastFetchedAt
    ? '数据获取于 ' + lastFetchedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' · '
    : '';
  const header = `<div class="date-label">${escHtml(datePart + timePart + '共 ' + visibleNews.length + ' 条')}</div>`;

  const parts = [header];
  visibleNews.forEach((item, index) => {
    const isLast = index === visibleNews.length - 1;
    const time = item.publishedAt
      ? item.publishedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '--:--';
    const tags = item.tags.map((tag) => `<span class="card-tag">${escHtml(tag)}</span>`).join('');
    const score = item.score === null ? '-' : String(item.score);
    const high = item.score !== null && item.score >= 80;

    parts.push(`
      <div class="tl-item">
        <div class="tl-left">
          <span class="tl-time">${escHtml(time)}</span>
          <div class="tl-dot"></div>
          ${isLast ? '' : '<div class="tl-line"></div>'}
        </div>
        <div class="tl-card" data-index="${index}" role="link" tabindex="0">
          <div class="card-source">${escHtml(item.source)}</div>
          <div class="card-title">${escHtml(item.title)}</div>
          <div class="card-desc">${escHtml(item.desc)}</div>
          <div class="card-tags">${tags}</div>
          <div class="card-footer">
            <div class="card-score${high ? ' high' : ''}">${escHtml(score)}</div>
            <div class="card-reason">${escHtml(item.reason)}</div>
          </div>
        </div>
      </div>`);
  });

  $('feed').innerHTML = parts.join('');
}

function openItem(index) {
  const item = visibleNews[Number(index)];
  if (!item) return;
  if (item.url) {
    window.open(item.url, '_blank', 'noopener,noreferrer');
  } else {
    window.alert('该资讯暂无原文链接。\n\n标题：' + item.title);
  }
}

async function loadNews() {
  if (loading) return;
  if (!API_KEY) { showKeyModal(); return; }

  loading = true;
  const button = $('refresh-btn');
  button.disabled = true;
  button.classList.add('spinning');
  renderState('正在抓取最新 AI 资讯...', '正在调用 Anthropic API 联网搜索，请稍候');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': CONFIG.API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        max_tokens: CONFIG.MAX_TOKENS,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_callers: ['direct'],
          max_uses: 5,
        }],
        messages: [{
          role: 'user',
          content: `今天是${dateStr}。请使用联网搜索，找出今天最新的 AI 热点资讯，涵盖大模型发布、AI 产品更新、研究突破、开源项目等。

返回一个 JSON 数组，包含 10 条资讯，每条格式如下：
{
  "title": "中文标题，简洁有力",
  "desc": "中文简介，60 字以内",
  "source": "来源网站或媒体名称",
  "url": "原文完整链接；无法确认则留空字符串",
  "publishedAt": "原文发布时间，ISO 8601 格式；无法确认则留空字符串",
  "tags": ["标签1","标签2"],
  "reason": "推荐理由，20 字以内，中文",
  "score": 60 到 99 之间的整数
}

tags 只能从以下值中选择：Agent、产品更新、大模型、具身智能、开源、研究、工具、搜索。
不要编造资讯或链接；无法确认发布时间时 publishedAt 留空。
只返回纯 JSON 数组，不要 markdown 代码块或任何多余文字。`,
        }],
      }),
    });

    let data = null;
    try { data = await response.json(); } catch (_) { /* 非 JSON 响应用状态码说明 */ }

    if (!response.ok) {
      const apiMessage = data && data.error && typeof data.error.message === 'string'
        ? data.error.message
        : '';
      throw new Error(`API 返回 ${response.status}${apiMessage ? '：' + apiMessage : ''}`);
    }
    if (data && data.stop_reason === 'max_tokens') {
      throw new Error('模型输出被截断（max_tokens 不足），请调大 CONFIG.MAX_TOKENS 后重试');
    }

    const blocks = (data && Array.isArray(data.content)) ? data.content : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) throw new Error('API 响应中没有可解析的文本内容');

    const items = normalizeNews(parseModelText(text));
    if (!items.length) throw new Error('未解析到有效资讯');

    allNews = items;
    lastFetchedAt = new Date();
    setUpdateLabel('获取于 ' + lastFetchedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    renderNews();
  } catch (error) {
    console.error('[ai-hot-news]', error);
    const message = error && error.message ? String(error.message) : String(error);
    const aborted = error && error.name === 'AbortError';
    showError(
      aborted ? '请求超时' : '获取资讯失败',
      aborted ? `超过 ${CONFIG.TIMEOUT_MS / 1000} 秒未响应，请检查网络后重试。` : message,
      /401|API Key/i.test(message)
    );
  } finally {
    clearTimeout(timer);
    loading = false;
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

function showKeyModal() {
  $('api-modal').style.display = 'flex';
  setUpdateLabel('尚未获取数据');
  renderState('请先设置 API Key', '在弹窗中填入你自己的 Anthropic API Key 后即可联网抓取。');
}

function saveApiKey() {
  const value = $('api-key-input').value.trim();
  if (!value.startsWith('sk-ant')) {
    $('api-key-error').textContent = '请输入以 sk-ant 开头的 Anthropic API Key';
    return;
  }
  $('api-key-error').textContent = '';
  API_KEY = value;
  try { localStorage.setItem(CONFIG.STORAGE_KEY, value); } catch (_) { /* 隐私模式下仅本次会话有效 */ }
  $('api-modal').style.display = 'none';
  loadNews();
}

function resetApiKey() {
  try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) { /* no-op */ }
  API_KEY = '';
  allNews = [];
  visibleNews = [];
  lastFetchedAt = null;
  activeFilter = '全部';
  syncFilterButtons();
  $('api-key-input').value = '';
  $('api-key-error').textContent = '';
  showKeyModal();
}

function toggleSidebar() {
  $('sidebar').classList.toggle('open');
}

function handleNav(element) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
  element.classList.add('active');
  $('page-title').textContent = element.dataset.nav;
  $('sidebar').classList.remove('open');

  if (element.dataset.available === 'false') {
    renderState(`「${element.dataset.nav}」尚未实现`, '当前版本仅提供资讯流与标签筛选，其余入口为规划占位，详见 README 的「已知限制」。');
    return;
  }

  activeFilter = '全部';
  syncFilterButtons();
  if (allNews.length) {
    renderNews();
  } else {
    renderState('尚未获取数据', '点击右上角「刷新」开始联网抓取。', [{ action: 'refresh', label: '立即刷新' }]);
  }
}

function setFilter(element) {
  activeFilter = element.dataset.filter;
  syncFilterButtons();
  if (allNews.length) renderNews();
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const actionElement = target.closest('[data-action]');
  if (actionElement) {
    switch (actionElement.dataset.action) {
      case 'save-key': saveApiKey(); return;
      case 'reset-key': resetApiKey(); return;
      case 'refresh': loadNews(); return;
      case 'toggle-sidebar': toggleSidebar(); return;
      default: break;
    }
  }

  const navElement = target.closest('[data-nav]');
  if (navElement) { handleNav(navElement); return; }

  const filterElement = target.closest('[data-filter]');
  if (filterElement) { setFilter(filterElement); return; }

  const cardElement = target.closest('[data-index]');
  if (cardElement) openItem(cardElement.dataset.index);
});

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  if (!active) return;
  if (active.id === 'api-key-input' && event.key === 'Enter') {
    saveApiKey();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && active.matches('[data-index], [data-nav], [data-action]')) {
    event.preventDefault();
    active.click();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  try { API_KEY = localStorage.getItem(CONFIG.STORAGE_KEY) || ''; } catch (_) { API_KEY = ''; }
  if (API_KEY) {
    $('api-modal').style.display = 'none';
    loadNews();
  } else {
    renderState('请先设置 API Key', '在弹窗中填入你自己的 Anthropic API Key 后即可联网抓取。');
  }
});
