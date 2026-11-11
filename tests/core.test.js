const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ALLOWED_TAGS,
  escHtml,
  isValidApiKey,
  filterNews,
  extractTextFromApiResponse,
  parseNewsJson,
  normalizeScore,
  isHighScore,
  resolveItemUrl,
  timelineHour,
  formatDateLabel,
  formatPromptDate,
  formatUpdateTime,
  padMinute,
  defaultSource,
  emptyFeedHtml,
  loadingFeedHtml,
  errorFeedHtml,
  renderNewsItem,
  buildFeedHtml,
  buildApiRequestBody,
  fallbackNews
} = require('../js/core.js');

describe('escHtml', () => {
  it('escapes &, <, >, and "', () => {
    assert.equal(escHtml('<script>alert("x&y")</script>'), '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;');
  });

  it('stringifies non-string values', () => {
    assert.equal(escHtml(42), '42');
    assert.equal(escHtml(null), 'null');
  });
});

describe('isValidApiKey', () => {
  it('accepts keys starting with sk-ant', () => {
    assert.equal(isValidApiKey('sk-ant-api03-abc'), true);
    assert.equal(isValidApiKey('  sk-ant-xyz  '), true);
  });

  it('rejects invalid keys', () => {
    assert.equal(isValidApiKey(''), false);
    assert.equal(isValidApiKey('sk-openai'), false);
    assert.equal(isValidApiKey(null), false);
    assert.equal(isValidApiKey(123), false);
  });
});

describe('filterNews', () => {
  const news = [
    { title: 'a', tags: ['大模型', '开源'] },
    { title: 'b', tags: ['Agent'] },
    { title: 'c', tags: [] },
    { title: 'd' }
  ];

  it('returns all items for 全部', () => {
    assert.deepEqual(filterNews(news, '全部'), news);
  });

  it('filters by tag', () => {
    assert.deepEqual(filterNews(news, '大模型'), [news[0]]);
    assert.deepEqual(filterNews(news, 'Agent'), [news[1]]);
  });

  it('returns empty when no match or invalid input', () => {
    assert.deepEqual(filterNews(news, '研究'), []);
    assert.deepEqual(filterNews(null, '全部'), []);
    assert.deepEqual(filterNews(undefined, 'Agent'), []);
  });
});

describe('extractTextFromApiResponse', () => {
  it('joins text blocks and ignores other types', () => {
    const data = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'web_search' },
        { type: 'text', text: ' world' }
      ]
    };
    assert.equal(extractTextFromApiResponse(data), 'hello world');
  });

  it('handles missing or empty content', () => {
    assert.equal(extractTextFromApiResponse({}), '');
    assert.equal(extractTextFromApiResponse(null), '');
    assert.equal(extractTextFromApiResponse({ content: [] }), '');
  });
});

describe('parseNewsJson', () => {
  const sample = [
    { title: 't1', tags: ['大模型'], score: 80 },
    { title: 't2', tags: ['开源'], score: 70 }
  ];

  it('parses a raw JSON array', () => {
    assert.deepEqual(parseNewsJson(JSON.stringify(sample)), sample);
  });

  it('strips markdown fences and surrounding text', () => {
    const wrapped = 'here is data:\n```json\n' + JSON.stringify(sample) + '\n```\nthanks';
    assert.deepEqual(parseNewsJson(wrapped), sample);
  });

  it('throws when no array is present', () => {
    assert.throws(() => parseNewsJson('no array here'), /no json array/);
  });

  it('throws when array is empty', () => {
    assert.throws(() => parseNewsJson('[]'), /empty/);
  });

  it('throws on invalid JSON inside brackets', () => {
    assert.throws(() => parseNewsJson('[{bad]'));
  });
});

describe('normalizeScore / isHighScore', () => {
  it('keeps numeric scores', () => {
    assert.equal(normalizeScore(88), 88);
    assert.equal(normalizeScore('90'), 90);
  });

  it('defaults invalid scores to 72', () => {
    assert.equal(normalizeScore(undefined), 72);
    assert.equal(normalizeScore(null), 72);
    assert.equal(normalizeScore('abc'), 72);
    assert.equal(normalizeScore(0), 72);
  });

  it('marks scores >= 80 as high', () => {
    assert.equal(isHighScore(80), true);
    assert.equal(isHighScore(99), true);
    assert.equal(isHighScore(79), false);
    assert.equal(isHighScore(undefined), false);
  });
});

describe('resolveItemUrl', () => {
  it('opens http(s) urls', () => {
    assert.deepEqual(resolveItemUrl({ url: 'https://example.com', title: 'x' }), {
      open: true,
      url: 'https://example.com'
    });
    assert.deepEqual(resolveItemUrl({ url: 'http://example.com' }), {
      open: true,
      url: 'http://example.com'
    });
  });

  it('falls back to title when url is missing or invalid', () => {
    assert.deepEqual(resolveItemUrl({ title: 'no link' }), { open: false, title: 'no link' });
    assert.deepEqual(resolveItemUrl({ url: 'javascript:alert(1)', title: 'xss' }), {
      open: false,
      title: 'xss'
    });
    assert.deepEqual(resolveItemUrl(null), { open: false, title: '' });
  });
});

describe('timelineHour', () => {
  it('decreases by floor(index * 0.7) and never goes below 0', () => {
    assert.equal(timelineHour(0), '06');
    assert.equal(timelineHour(1), '06');
    assert.equal(timelineHour(2), '05');
    assert.equal(timelineHour(10), '00');
    assert.equal(timelineHour(20), '00');
  });
});

describe('formatDateLabel', () => {
  it('includes localized date and item count', () => {
    const date = new Date(2026, 10, 11);
    const label = formatDateLabel(date, 10);
    assert.match(label, /11/);
    assert.match(label, /共 10 条/);
  });
});

describe('fallbackNews', () => {
  it('returns 10 items with required fields and allowed tags', () => {
    const items = fallbackNews();
    assert.equal(items.length, 10);
    for (const item of items) {
      assert.equal(typeof item.title, 'string');
      assert.ok(item.title.length > 0);
      assert.equal(typeof item.desc, 'string');
      assert.equal(typeof item.source, 'string');
      assert.ok(item.url.startsWith('http'));
      assert.ok(Array.isArray(item.tags));
      assert.ok(item.tags.length > 0);
      for (const tag of item.tags) {
        assert.ok(ALLOWED_TAGS.includes(tag), `unexpected tag: ${tag}`);
      }
      assert.equal(typeof item.reason, 'string');
      assert.ok(item.score >= 60 && item.score <= 99);
    }
  });

  it('covers every allowed tag at least once', () => {
    const tags = new Set(fallbackNews().flatMap((n) => n.tags));
    for (const tag of ALLOWED_TAGS) {
      assert.ok(tags.has(tag), `missing tag: ${tag}`);
    }
  });
});

describe('padMinute', () => {
  it('zero-pads values in 0-59', () => {
    assert.equal(padMinute(0), '00');
    assert.equal(padMinute(9), '09');
    assert.equal(padMinute(59), '59');
  });

  it('wraps overflow and defaults invalid input', () => {
    assert.equal(padMinute(60), '00');
    assert.equal(padMinute(61), '01');
    assert.equal(padMinute(undefined), '00');
  });
});

describe('defaultSource', () => {
  it('keeps provided source and defaults empty values', () => {
    assert.equal(defaultSource('TechCrunch'), 'TechCrunch');
    assert.equal(defaultSource(''), 'AI资讯');
    assert.equal(defaultSource(null), 'AI资讯');
    assert.equal(defaultSource(undefined), 'AI资讯');
  });
});

describe('formatPromptDate / formatUpdateTime', () => {
  it('includes year month day in prompt date', () => {
    const date = new Date(2026, 10, 11);
    const text = formatPromptDate(date);
    assert.match(text, /2026/);
    assert.match(text, /11/);
  });

  it('prefixes update time', () => {
    const text = formatUpdateTime(new Date(2026, 10, 11, 14, 5));
    assert.match(text, /^更新于 /);
    assert.match(text, /14/);
  });
});

describe('errorFeedHtml / loadingFeedHtml / emptyFeedHtml', () => {
  it('renders loading copy', () => {
    const html = loadingFeedHtml();
    assert.match(html, /正在抓取最新 AI 资讯/);
    assert.match(html, /联网搜索中/);
  });

  it('renders empty copy', () => {
    assert.match(emptyFeedHtml(), /该分类暂无资讯/);
  });

  it('escapes error message and optionally shows reset button', () => {
    const withReset = errorFeedHtml('<script>x</script>', true);
    assert.match(withReset, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.match(withReset, /resetApiKey/);
    const withoutReset = errorFeedHtml('失败', false);
    assert.equal(withoutReset.includes('resetApiKey'), false);
    assert.match(withoutReset, /失败/);
  });
});

describe('renderNewsItem / buildFeedHtml', () => {
  const item = {
    title: '<b>Claude</b>',
    desc: 'desc & more',
    source: 'Blog',
    tags: ['大模型', '开源'],
    reason: '推荐"理由"',
    score: 88
  };

  it('escapes fields, marks high score, and omits line on last item', () => {
    const html = renderNewsItem(item, 0, true, 7);
    assert.match(html, /06:07/);
    assert.match(html, /&lt;b&gt;Claude&lt;\/b&gt;/);
    assert.match(html, /desc &amp; more/);
    assert.match(html, /推荐&quot;理由&quot;/);
    assert.match(html, /card-score high/);
    assert.match(html, /onclick="openItem\(0\)"/);
    assert.equal(html.includes('tl-line'), false);
  });

  it('keeps timeline line for non-last items and defaults missing fields', () => {
    const html = renderNewsItem({ title: 't' }, 2, false, 3);
    assert.match(html, /tl-line/);
    assert.match(html, /AI资讯/);
    assert.match(html, />72</);
    assert.equal(html.includes('card-score high'), false);
  });

  it('returns empty state when list is empty', () => {
    assert.equal(buildFeedHtml([], new Date(2026, 10, 11), []), emptyFeedHtml());
    assert.equal(buildFeedHtml(null, new Date(), []), emptyFeedHtml());
  });

  it('builds a feed with date label and one card per item', () => {
    const items = [item, { title: 'second', score: 70, tags: ['工具'] }];
    const html = buildFeedHtml(items, new Date(2026, 10, 11), [1, 2]);
    assert.match(html, /共 2 条/);
    assert.equal((html.match(/tl-item/g) || []).length, 2);
    assert.equal((html.match(/tl-line/g) || []).length, 1);
  });
});

describe('buildApiRequestBody', () => {
  it('embeds date and allowed tags in the user prompt', () => {
    const body = buildApiRequestBody('2026年11月11日');
    assert.equal(body.model, 'claude-sonnet-4-20250514');
    assert.equal(body.max_tokens, 2000);
    assert.equal(body.tools[0].name, 'web_search');
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /2026年11月11日/);
    for (const tag of ALLOWED_TAGS) {
      assert.match(body.messages[0].content, new RegExp(tag));
    }
  });
});
