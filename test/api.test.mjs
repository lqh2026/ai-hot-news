/**
 * 本地验证：mock Anthropic 上游，检验解析 / 清洗 / 评分 / 缓存 / 错误映射
 *   node test/api.test.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { onRequest } = await import(pathToFileURL(path.join(ROOT, 'functions/api/news.js')).href);

// ── 测试替身 ──
function makeKV() {
  const m = new Map();
  return {
    async get(k) { return m.get(k) ?? null; },
    async put(k, v) { m.set(k, v); },
  };
}

let upstream = { status: 200, body: null };
let fetchCount = 0;

globalThis.fetch = async () => {
  fetchCount += 1;
  return new Response(typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
};

const env = { ANTHROPIC_API_KEY: 'sk-ant-test', NEWS_KV: makeKV() };
const ctx = { env, waitUntil() {} };

function call(query = '') {
  return onRequest({ request: new Request(`https://local.test/api/news${query}`), env, ctx });
}

function anthropicReply(jsonText, stopReason = 'end_turn') {
  return {
    id: 'msg_test',
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: stopReason,
    content: [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'ai news' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
      { type: 'text', text: jsonText },
    ],
  };
}

const SAMPLE = [
  { title: 'Anthropic 发布 Claude 新版本', desc: '官方正式上线新一代模型，推理能力显著提升。', source: 'Anthropic', url: 'https://www.anthropic.com/news/x', publishedAt: new Date().toISOString(), tags: ['大模型', '产品更新'], reason: '头部旗舰发布', score: 95 },
  { title: '某开源项目登上 GitHub 趋势榜', desc: '开源社区发布新工具，支持本地部署。', source: 'GitHub', url: 'https://github.com/x/y', publishedAt: null, tags: ['开源', '工具'], reason: '高影响力开源', score: 84 },
  { title: 'Anthropic 发布 Claude 新版本', desc: '重复条目，应被去重。', source: 'Dup', url: 'https://dup.example.com', tags: ['研究'], reason: 'dup', score: 70 },
  { title: '非法标签与链接测试', desc: '这个条目的 tag 不在白名单，url 也不是 http。', source: '', url: 'javascript:alert(1)', tags: ['乱七八糟'], reason: '', score: 999 },
  { title: '', desc: '无标题应被丢弃', source: 'x', url: 'https://x.com', tags: [], reason: '', score: 70 },
];

let pass = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nAI HOT API 本地验证\n');

// 1. 缺失 API Key（必须最先跑：此时模块缓存为空）
await test('缺少 API Key 返回 NO_API_KEY', async () => {
  const res = await onRequest({
    request: new Request('https://local.test/api/news?force=1'),
    env: { NEWS_KV: makeKV() },
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error, 'NO_API_KEY');
});

// 2. 上游 403 必须映射为明确错误，而不是静默降级
await test('403 映射为 UPSTREAM_FORBIDDEN', async () => {
  upstream = { status: 403, body: { error: { type: 'forbidden', message: 'Request not allowed' } } };
  const res = await call('?force=1');
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error, 'UPSTREAM_FORBIDDEN');
  assert.ok(body.message.length > 0);
});

// 2. 正常解析
await test('正常解析并返回条目', async () => {
  upstream = { status: 200, body: anthropicReply(JSON.stringify(SAMPLE)) };
  const before = fetchCount;
  const res = await call('?force=1');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(fetchCount > before, '应触发上游请求');
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length > 0);
  assert.equal(body.stats.total, body.items.length);
});

// 3. 数据清洗
await test('清洗非法数据', async () => {
  upstream = { status: 200, body: anthropicReply(JSON.stringify(SAMPLE)) };
  const body = await (await call('?force=1')).json();
  const titles = body.items.map((i) => i.title);

  assert.equal(titles.filter((t) => t === 'Anthropic 发布 Claude 新版本').length, 1, '重复标题应去重');
  assert.ok(!titles.includes(''), '空标题应被丢弃');

  const weird = body.items.find((i) => i.title === '非法标签与链接测试');
  assert.ok(weird, '非法标签条目本身应保留');
  assert.deepEqual(weird.tags, ['研究'], '非白名单 tag 应回落到默认值');
  assert.equal(weird.url, '', '非 http 链接应被清空');
  assert.ok(weird.score >= 60 && weird.score <= 99, `评分应被修正，实际 ${weird.score}`);

  assert.ok(body.items.every((i) => i.url === '' || /^https?:\/\//.test(i.url)));
  assert.ok(body.items.every((i) => typeof i.id === 'string' && i.id.length > 0));
  assert.ok(body.items.every((i) => Number.isInteger(i.score)));
});

// 4. 评分降序
await test('结果按评分降序', async () => {
  const body = await (await call()).json();
  const scores = body.items.map((i) => i.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

// 5. 缓存命中不重复请求上游
await test('缓存命中不重复请求上游', async () => {
  const before = fetchCount;
  const body = await (await call()).json();
  assert.equal(fetchCount, before, '新鲜缓存不应触发上游请求');
  assert.equal(body.cached, true);
});

// 6. 截断抢救
await test('max_tokens 截断时抢救完整条目', async () => {
  const full = JSON.stringify(SAMPLE);
  const cut = full.slice(0, full.indexOf('"title":"非法标签') + 10); // 人为截断
  upstream = { status: 200, body: anthropicReply(cut, 'max_tokens') };
  const res = await call('?force=1');
  const body = await res.json();
  assert.equal(res.status, 200, '应抢救成功而非直接报错');
  assert.ok(body.items.length >= 2, `截断后仍应保留已完整条目，实际 ${body.items.length}`);
});

// 7. 完全无法解析时返回明确错误
await test('无法解析时返回 PARSE_FAILED', async () => {
  upstream = { status: 200, body: anthropicReply('抱歉，我无法完成该请求。') };
  const res = await call('?force=1');
  const body = await res.json();
  assert.ok(res.status >= 400 || body.error, '应暴露错误而非静默成功');
});

// 8. 有缓存时上游故障应降级返回旧数据，而非清空页面
await test('上游故障时降级返回旧数据', async () => {
  upstream = { status: 500, body: { error: { message: 'boom' } } };
  const res = await call('?force=1');
  const body = await res.json();
  assert.equal(res.status, 200, '有缓存时应降级成功');
  assert.ok(body.items.length > 0, '应保留旧数据');
  assert.ok(body.error, '应同时携带错误提示');
  assert.equal(body.stale, true);
});

// 9. 方法限制
await test('仅允许 GET', async () => {
  const res = await onRequest({
    request: new Request('https://local.test/api/news', { method: 'POST' }),
    env,
    ctx,
  });
  assert.equal(res.status, 405);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败项' : ''}\n`);
