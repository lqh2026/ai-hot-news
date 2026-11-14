#!/usr/bin/env node
/**
 * 本地调试服务器 —— 不依赖 wrangler，用 Node 原生 http + Web 标准 Request/Response
 * 模拟 Cloudflare Pages 的运行环境（含 KV 的内存替身）。
 *
 *   ANTHROPIC_API_KEY=sk-ant-xxx node dev-server.mjs
 *
 * 也可以把 key 写进 worker/.dev.vars，脚本会自动读取：
 *   ANTHROPIC_API_KEY=sk-ant-xxx
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8788);

// ── 环境变量：优先 process.env，其次 .dev.vars ──
async function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = await fs.readFile(path.join(__dirname, '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* 无 .dev.vars 时忽略 */
  }
  return env;
}

// ── KV 内存替身 ──
function createKV() {
  const store = new Map();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.exp && Date.now() > hit.exp) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, {
        value,
        exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0,
      });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const env = { ...(await loadEnv()), NEWS_KV: createKV() };
const fnUrl = pathToFileURL(path.join(ROOT, 'functions/api/news.js')).href;
const { onRequest } = await import(fnUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 接口路由
  if (url.pathname === '/api/news') {
    const request = new Request(url.href, {
      method: req.method,
      headers: req.headers,
    });
    const context = {
      request,
      env,
      waitUntil(promise) {
        Promise.resolve(promise).catch((e) => console.warn('[waitUntil]', e.message));
      },
    };
    try {
      const response = await onRequest(context);
      const body = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch (err) {
      console.error('[api error]', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'DEV_SERVER_ERROR', message: err.message }));
    }
    return;
  }

  // 静态文件
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AI HOT 本地预览 → http://127.0.0.1:${PORT}`);
  console.log(`  API Key: ${env.ANTHROPIC_API_KEY ? '已配置' : '未配置（/api/news 将返回 NO_API_KEY）'}`);
  console.log(`  KV 绑定: 内存替身（重启即失效）\n`);
});
