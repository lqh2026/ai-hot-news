/**
 * AI HOT · 资讯聚合接口
 * Cloudflare Pages Function —— 自动映射到 GET /api/news
 *
 * 设计要点：
 *  1. API Key 只存在服务端环境变量（ANTHROPIC_API_KEY），永不下发浏览器。
 *  2. 抓取结果写入 KV 缓存，所有访客共享同一份数据 —— 这是"同步"的前提。
 *  3. 缓存新鲜期 25 分钟；过期后先返回旧数据再后台刷新（stale-while-revalidate），
 *     避免访客卡在 30~50 秒的联网搜索上。
 *  4. 模型走降级链，某个模型下线自动切下一个，不再因硬编码模型 ID 整体失效。
 */

const DEFAULT_MODEL_CHAIN =
  'claude-sonnet-4-5-20250929,claude-sonnet-4-20250514,claude-3-7-sonnet-20250219';

const ALLOWED_TAGS = ['Agent', '产品更新', '大模型', '具身智能', '开源', '研究', '工具', '搜索'];

const CACHE_KEY = 'news:v1';
const FRESH_MS = 25 * 60 * 1000;      // 25 分钟内视为新鲜
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 超过 12 小时的数据不再展示
const UPSTREAM_TIMEOUT_MS = 55_000;
const TARGET_COUNT = 14;
const MAX_ITEMS = 30;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// Pages Functions 实例会被复用，未配置 KV 时退化为进程内缓存
const memCache = new Map();

class UpstreamError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── 入口 ──────────────────────────────────────────────
export const onRequest = async (context) => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' }, 405);

  return handle(request, env, context);
};

async function handle(request, env, ctx) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  const cached = await cacheGet(env);

  // 命中新鲜缓存：直接返回，零上游请求
  if (cached && !force && isFresh(cached)) {
    return json({ ...cached, cached: true });
  }

  // 缓存过期但可用：先给旧数据，后台刷新
  if (cached && !force && isUsable(cached)) {
    ctx?.waitUntil?.(refresh(env).catch((e) => console.warn('bg refresh failed:', e.code, e.message)));
    return json({ ...cached, cached: true, revalidating: true });
  }

  // 无缓存或强制刷新：同步抓取
  try {
    const fresh = await refresh(env);
    return json({ ...fresh, cached: false });
  } catch (err) {
    console.error('refresh failed:', err.code, err.message);
    // 强制刷新失败时仍回退旧数据，不让页面变空
    if (cached) {
      return json({ ...cached, cached: true, stale: true, error: err.message }, 200);
    }
    return json({ error: err.code || 'UPSTREAM_ERROR', message: err.message }, err.status || 502);
  }
}

// ── 抓取 ──────────────────────────────────────────────
async function refresh(env) {
  const payload = await fetchNews(env);
  await cachePut(env, payload);
  return payload;
}

async function fetchNews(env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new UpstreamError('NO_API_KEY', '服务端未配置 ANTHROPIC_API_KEY 环境变量', 500);
  }

  const models = String(env.MODEL_CHAIN || DEFAULT_MODEL_CHAIN)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let lastErr;
  for (const model of models) {
    try {
      const items = await callClaude(env, model);
      if (!items.length) throw new UpstreamError('NO_RESULT', `模型 ${model} 未返回有效资讯`);
      return {
        updatedAt: new Date().toISOString(),
        model,
        items,
        stats: {
          total: items.length,
          avgScore: Math.round(items.reduce((a, b) => a + b.score, 0) / items.length),
          sources: new Set(items.map((i) => i.source)).size,
        },
      };
    } catch (err) {
      lastErr = err;
      // 模型不存在或参数被拒 → 换下一个模型；其余错误直接上抛
      if (err.code === 'MODEL_NOT_FOUND' || err.code === 'BAD_REQUEST') continue;
      throw err;
    }
  }
  throw lastErr;
}

async function callClaude(env, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        // web_search 的搜索结果块会占用上下文，2000 必然截断，给足 4096
        max_tokens: 4096,
        temperature: 0.3,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content: buildPrompt() }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError('UPSTREAM_TIMEOUT', `上游超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）`);
    }
    throw new UpstreamError('UPSTREAM_UNREACHABLE', `无法连接 Anthropic API：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw await mapHttpError(res);

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new UpstreamError('EMPTY_CONTENT', '上游未返回文本内容（可能仅有搜索结果）');
  }

  const raw = parseJsonArray(text, data.stop_reason === 'max_tokens');
  if (!raw) {
    throw new UpstreamError('PARSE_FAILED', `无法从模型输出中解析 JSON 数组（stop_reason=${data.stop_reason}）`);
  }

  return sanitizeItems(raw);
}

async function mapHttpError(res) {
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    detail = JSON.parse(body)?.error?.message || detail;
  } catch {
    /* 保留原始片段 */
  }

  switch (res.status) {
    case 401:
      return new UpstreamError('UPSTREAM_AUTH', '服务端 API Key 无效或已失效', 502);
    case 403:
      return new UpstreamError(
        'UPSTREAM_FORBIDDEN',
        '调用被 Anthropic 拒绝：可能为部署区域限制或 Key 权限不足',
        502
      );
    case 404:
      return new UpstreamError('MODEL_NOT_FOUND', `模型不可用：${detail}`);
    case 429:
      return new UpstreamError('UPSTREAM_RATE_LIMIT', '上游限流，请稍后重试', 429);
    case 400:
      return new UpstreamError('BAD_REQUEST', `请求参数被拒绝：${detail}`);
    default:
      return new UpstreamError('UPSTREAM_ERROR', `上游返回 ${res.status}：${detail}`);
  }
}

function buildPrompt() {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  const dateStr = `${now.getUTCFullYear()}年${now.getUTCMonth() + 1}月${now.getUTCDate()}日`;

  return `今天是 ${dateStr}（东八区）。

请使用 web_search 检索过去 24 小时内全球 AI 领域最重要的科技动态，覆盖：大模型发布与迭代、AI 产品功能更新、研究突破、开源项目、具身智能、AI 搜索与 Agent 工具。

要求：
1. 只收录 ${TARGET_COUNT} 条以内真实、可溯源的信息，禁止杜撰或推测。每条必须有真实可访问的原文链接。
2. 用中文重写标题与摘要，不要逐字机翻。
3. 按重要性从高到低排序。

评分规则（score 为 60–99 的整数），依据信源权威性、事件影响力、时效性综合判定：
- 90–99：头部实验室或公司正式发布旗舰模型 / 重大产品
- 80–89：重要产品更新、关键性能突破、高影响力开源
- 70–79：常规版本更新、有实用价值的工具或论文
- 60–69：一般行业动态

严格只输出一个 JSON 数组，不要 markdown 代码块，不要任何解释文字：
[
  {
    "title": "中文标题，不超过 30 字",
    "desc": "中文摘要，不超过 70 字，说明核心事实",
    "source": "来源媒体或机构名称",
    "url": "原文链接，https 开头",
    "publishedAt": "ISO8601 时间如 2026-11-11T08:30:00Z，未知填 null",
    "tags": ["从允许列表选 1-2 个"],
    "reason": "入选理由，不超过 20 字",
    "score": 88
  }
]

tags 允许值：${ALLOWED_TAGS.join('、')}`;
}

// ── 解析 ──────────────────────────────────────────────
/** 平衡括号扫描，避免被正文中的 "[" 误导 */
function parseJsonArray(text, truncated) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return safeParse(cleaned.slice(start, i + 1), truncated);
    }
  }

  // 未闭合：说明输出被 max_tokens 截断，尽力抢救已完整的对象
  return safeParse(repairTruncated(cleaned.slice(start)), truncated);
}

function repairTruncated(str) {
  const idx = str.lastIndexOf('}');
  if (idx === -1) return str + ']';
  return str.slice(0, idx + 1) + ']';
}

function safeParse(str, truncated) {
  try {
    const v = JSON.parse(str);
    if (Array.isArray(v) && truncated) console.warn('parsed truncated array, kept', v.length, 'items');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ── 清洗 ──────────────────────────────────────────────
function sanitizeItems(raw) {
  const out = [];
  const seen = new Set();

  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;

    const title = clip(it.title, 80);
    if (!title) continue;

    const dedupeKey = title.replace(/[\s\p{P}]/gu, '').slice(0, 24);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const url = normalizeUrl(it.url);
    const tags = (Array.isArray(it.tags) ? it.tags : [])
      .map((t) => String(t).trim())
      .filter((t) => ALLOWED_TAGS.includes(t))
      .slice(0, 3);

    out.push({
      id: hashString(url || title),
      title,
      desc: clip(it.desc ?? it.summary ?? it.description, 200),
      source: clip(it.source, 40) || hostOf(url) || 'AI 资讯',
      url,
      publishedAt: normalizeTime(it.publishedAt ?? it.time ?? it.date),
      tags: tags.length ? tags : ['研究'],
      reason: clip(it.reason, 40),
      score: normalizeScore(it.score, it, url),
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, MAX_ITEMS);
}

function clip(v, max) {
  if (v == null) return '';
  const s = String(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function normalizeUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    return new URL(s).href;
  } catch {
    return '';
  }
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  // 拒绝明显异常的时间（未来 1 天以上 / 远期历史）
  if (d.getTime() > now + 864e5 || d.getTime() < now - 365 * 864e5) return null;
  return d.toISOString();
}

function normalizeScore(v, item, url) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 60 && n <= 99) return Math.round(n);
  return ruleScore(item, url);
}

/** 模型未给分时的确定性兜底，保证同一份数据评分恒定 */
function ruleScore(item, url) {
  let s = 66;
  const text = `${item.title || ''} ${item.desc || ''}`;
  const source = String(item.source || '');

  if (/anthropic|openai|deepmind|google|meta|microsoft|nvidia|deepseek|qwen|通义|阿里|字节|moonshot|智谱/i.test(source)) s += 8;
  if (/arxiv|nature|science|acl|cvpr|neurips/i.test(url)) s += 5;
  if (/github\.com/i.test(url)) s += 3;
  if (/发布|推出|正式|上线|开源|突破|刷新|登顶|融资|收购|首次|超越/i.test(text)) s += 8;
  if (/更新|升级|新增|支持|优化|改进/i.test(text)) s += 3;
  if (/传闻|或将|据称|可能|预计/i.test(text)) s -= 8;

  return Math.max(60, Math.min(99, s));
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── 缓存 ──────────────────────────────────────────────
async function cacheGet(env) {
  if (env.NEWS_KV) {
    try {
      // 不依赖 get(key,'json') 的隐式反序列化，兼容不同 KV 实现
      const raw = await env.NEWS_KV.get(CACHE_KEY);
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.warn('KV read failed:', e.message);
    }
  }
  return memCache.get(CACHE_KEY) || null;
}

async function cachePut(env, payload) {
  memCache.set(CACHE_KEY, payload);
  if (env.NEWS_KV) {
    try {
      await env.NEWS_KV.put(CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: Math.floor(ABSOLUTE_MS / 1000),
      });
    } catch (e) {
      console.warn('KV write failed:', e.message);
    }
  }
}

function isFresh(p) {
  const t = Date.parse(p?.updatedAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

function isUsable(p) {
  const t = Date.parse(p?.updatedAt);
  return Array.isArray(p?.items) && p.items.length > 0 && Number.isFinite(t) && Date.now() - t < ABSOLUTE_MS;
}

// ── 响应 ──────────────────────────────────────────────
function json(body, status = 200) {
  const headers = { 'content-type': 'application/json; charset=utf-8', ...CORS };
  if (status === 200) headers['cache-control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}
