#!/usr/bin/env python3
"""AI 热点中转服务（零依赖，仅用 Python 标准库）

作用：浏览器无法跨域读取 RSS（源站不带 CORS 头），且 rss2json / Jina 在当前网络下不可用。
本服务在本地把 RSS 抓下来、解析成 JSON，用与 rss2json 完全相同的结构返回，
页面无需改动解析逻辑即可拿到真实资讯。

用法：
    python3 hotspots_relay.py            # 默认 127.0.0.1:8787
    PORT=9000 python3 hotspots_relay.py

接口：
    GET /api/rss?url=<encoded>   抓取并解析 RSS/Atom
    GET /health                  健康检查
"""

from __future__ import annotations

import datetime
import io
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import format_datetime, parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET

# 默认监听所有网卡，便于同一 WiFi 下的手机访问；设为 127.0.0.1 可回到仅本机
HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8787"))
TIMEOUT = float(os.environ.get("RELAY_TIMEOUT", "12"))

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# SSRF 防护：只允许抓取白名单内的域名
ALLOWED_HOSTS = {
    "36kr.com", "www.36kr.com",
    "qbitai.com", "www.qbitai.com",
    "sspai.com", "www.sspai.com",
    "solidot.org", "www.solidot.org",
    "ifanr.com", "www.ifanr.com",
    "geekpark.net", "www.geekpark.net",
    "rssforever.com", "rsshub.rssforever.com",
    "tisi.org", "www.tisi.org",
    "jiqizhixin.com", "www.jiqizhixin.com",
    "ithome.com", "www.ithome.com",
    "huxiu.com", "www.huxiu.com",
    "cls.cn", "www.cls.cn", "api3.cls.cn",
    "technologyreview.com", "www.technologyreview.com",
    "openai.com", "www.openai.com",
    "anthropic.com", "www.anthropic.com",
    "deepmind.google",
    "rsshub.app",
    "github.com", "www.github.com",
    "hnrss.org",
    "wechat2rss.xlab.app",   # 微信公众号公开 RSS 转换服务（用户自定义信源）
    "arxiv.org", "export.arxiv.org",
}

EXTRA_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("RELAY_EXTRA_HOSTS", "").split(",")
    if h.strip()
}

# 抓取结果缓存：避免频繁刷新打爆源站；抓取失败时用最近一次成功结果兜底
FEED_TTL = float(os.environ.get("RELAY_FEED_TTL", "90"))
FEED_STALE_MAX = 30 * 60
FEED_CACHE: dict[str, tuple[float, dict]] = {}
FEED_CACHE_LOCK = threading.Lock()


def cache_get(url: str, allow_stale: bool = False):
    with FEED_CACHE_LOCK:
        hit = FEED_CACHE.get(url)
    if not hit:
        return None
    timestamp, payload = hit
    age = time.time() - timestamp
    if age < FEED_TTL:
        return payload
    if allow_stale and age < FEED_STALE_MAX:
        return payload
    return None


def cache_put(url: str, payload: dict) -> None:
    with FEED_CACHE_LOCK:
        FEED_CACHE[url] = (time.time(), payload)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def text_of(node: ET.Element, *names: str) -> str:
    for child in node:
        if local_name(child.tag) in names:
            value = "".join(child.itertext()).strip()
            if value:
                return value
    return ""


def link_of(node: ET.Element) -> str:
    value = text_of(node, "link")
    if value:
        return value
    for child in node:
        if local_name(child.tag) == "link" and child.get("href"):
            return child.get("href", "").strip()
    return ""


def parse_feed(raw: bytes) -> tuple[str, list[dict]]:
    root = ET.fromstring(raw)

    feed_title = ""
    for child in root:
        if local_name(child.tag) in ("channel", "head"):
            feed_title = text_of(child, "title")
            break
    if not feed_title:
        feed_title = text_of(root, "title")

    items = []
    for node in root.iter():
        if local_name(node.tag) not in ("item", "entry"):
            continue
        title = text_of(node, "title")
        link = link_of(node)
        description = text_of(node, "description", "summary", "content", "encoded")
        published = text_of(node, "pubDate", "published", "updated", "date", "issued")
        if not title or not link:
            continue
        items.append({
            "title": title,
            "link": link,
            "description": description,
            "pubDate": published,
            "author": text_of(node, "author", "creator", "name"),
        })

    return feed_title, items


def host_allowed(url: str) -> bool:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    host = host.lower()
    if host in ALLOWED_HOSTS or host in EXTRA_HOSTS:
        return True
    return any(host.endswith("." + allowed) for allowed in (ALLOWED_HOSTS | EXTRA_HOSTS))


def clean_text(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", unescape(text)).strip()


def pub_timestamp(value: str) -> float:
    if not value:
        return 0.0
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def sort_and_limit(items: list[dict], limit: int = 40) -> list[dict]:
    """官方 RSS 常有上千条历史文章，先按时间取最新的一批，避免无谓传输。"""
    items.sort(key=lambda it: pub_timestamp(it.get("pubDate", "")), reverse=True)
    return items[:limit]


class _AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.stack: list[list[str]] = []
        self.pairs: list[tuple[str, str]] = []

    def handle_starttag(self, tag, attrs) -> None:
        if tag == "a":
            self.stack.append([dict(attrs).get("href", ""), ""])

    def handle_data(self, data) -> None:
        for entry in self.stack:
            entry[1] += data

    def handle_endtag(self, tag) -> None:
        if tag == "a" and self.stack:
            href, text = self.stack.pop()
            self.pairs.append((href, clean_text(text)))


def fetch_sitemap_times(host_scheme: str) -> dict[str, str]:
    """Anthropic 的 /news 卡片不都带 <time>，用 sitemap 的 lastmod 兜底。"""
    url = f"{host_scheme}://www.anthropic.com/sitemap.xml"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read().decode("utf-8", "ignore")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return {}

    result: dict[str, str] = {}
    for loc, lastmod in re.findall(
        r"<loc>(https://www\.anthropic\.com/news/[^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", raw
    ):
        result[loc.rstrip("/")] = lastmod.strip()
    return result


class _AnthropicParser(HTMLParser):
    """Anthropic 新闻卡片：<a href="/news/slug"> 内同时包含 <h3> 标题与 <p> 摘要。"""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict] = []
        self.times: list[str] = []
        self.current: dict | None = None
        self.heading = 0
        self.in_time = False
        self.time_buf = ""

    def handle_starttag(self, tag, attrs) -> None:
        href = dict(attrs).get("href", "")
        if tag == "a" and href.startswith("/news/"):
            self.current = {
                "href": href.split("?")[0].split("#")[0].rstrip("/"),
                "title": "",
                "text": [],
            }
        elif tag in ("h2", "h3") and self.current:
            self.heading += 1
        elif tag == "time":
            self.in_time = True
            self.time_buf = ""

    def handle_data(self, data) -> None:
        if self.current:
            self.current["text"].append(data)
            if self.heading:
                self.current["title"] += data
        if self.in_time:
            self.time_buf += data

    def handle_endtag(self, tag) -> None:
        if tag in ("h2", "h3") and self.heading:
            self.heading -= 1
        elif tag == "time":
            self.times.append(clean_text(self.time_buf))
            self.in_time = False
        elif tag == "a" and self.current:
            record, self.current = self.current, None
            title = clean_text(record["title"])
            if len(title) >= 8:
                self.records.append({
                    "title": title,
                    "href": record["href"],
                    "summary": clean_text("".join(record["text"]))[:300],
                })


def parse_anthropic(raw: bytes, sitemap: dict[str, str]) -> tuple[str, list[dict]]:
    text = raw.decode("utf-8", "ignore")
    parser = _AnthropicParser()
    parser.feed(text)

    items: list[dict] = []
    seen: set[str] = set()
    for index, record in enumerate(parser.records):
        link = "https://www.anthropic.com" + record["href"]
        if link in seen:
            continue
        seen.add(link)

        pub_date = ""
        iso = sitemap.get(link)
        if iso:
            try:
                pub_date = format_datetime(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")))
            except ValueError:
                pub_date = ""
        if not pub_date and index < len(parser.times):
            pub_date = parser.times[index]

        items.append({
            "title": record["title"],
            "link": link,
            "description": record["summary"],
            "pubDate": pub_date,
        })

    return "Anthropic News", sort_and_limit(items)


def parse_huxiu(raw: bytes) -> tuple[str, list[dict]]:
    text = raw.decode("utf-8", "ignore")

    # Nuxt SSR 数据里带 dateline / publish_time（10 位 Unix 秒）
    times: dict[str, int] = {}
    patterns = (
        r'"https://www\.huxiu\.com/article/(\d+)\.html","[^"]*",(\d{10})',
        r'"https://www\.huxiu\.com/article/(\d+)\.html",(?:true|false),(?:true|false),(\d{10})',
    )
    for pattern in patterns:
        for aid, stamp in re.findall(pattern, text):
            times.setdefault(aid, int(stamp))

    parser = _AnchorParser()
    parser.feed(text)

    items: list[dict] = []
    seen: set[str] = set()
    for href, title in parser.pairs:
        match = re.search(r"/article/(\d+)\.html$", href or "")
        if not match or len(title) < 8 or href in seen:
            continue
        seen.add(href)

        stamp = times.get(match.group(1))
        pub_date = (
            format_datetime(datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc))
            if stamp else ""
        )
        items.append({
            "title": title,
            "link": href,
            "description": "",
            "pubDate": pub_date,
        })

    return "虎嗅网", sort_and_limit(items)


def parse_html_page(url: str, raw: bytes) -> tuple[str, list[dict]]:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if "anthropic.com" in host:
        scheme = urllib.parse.urlparse(url).scheme
        return parse_anthropic(raw, fetch_sitemap_times(scheme))
    if "huxiu.com" in host:
        return parse_huxiu(raw)
    return "", []


def fetch_via_curl(url: str) -> bytes | None:
    """部分站点用 WAF 拦截 urllib 的 TLS 指纹，改走 curl 重试一次。"""
    try:
        result = subprocess.run(
            ["curl", "-sL", "--compressed", "--max-time", str(max(5, int(TIMEOUT))),
             "-A", USER_AGENT, url],
            capture_output=True,
            timeout=TIMEOUT + 5,
            check=False,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    return result.stdout if result.returncode == 0 and result.stdout else None


def parse_sogou_wechat(raw: bytes, query: str) -> tuple[str, list[dict]]:
    """解析搜狗微信文章搜索页，按公众号名优先排序；兼容页面结构变体。"""
    text = raw.decode("utf-8", "ignore")
    items: list[dict] = []
    seen: set[str] = set()

    blocks = re.split(r'<div[^>]*class=["\'][^"\']*txt-box[^"\']*["\'][^>]*>', text)[1:]
    if not blocks:
        blocks = re.split(r'<li[^>]*id=["\'][^"\']*box_\d+', text)[1:]

    for block in blocks:
        heading = re.search(r"<h3[^>]*>(.*?)</h3>", block, re.S)
        if not heading:
            continue
        anchor = re.search(
            r'<a[^>]*?href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', heading.group(1), re.S
        )
        if not anchor:
            continue

        title = clean_text(re.sub(r"<!--.*?-->", "", anchor.group(2)))
        if len(title) < 6:
            continue

        href = unescape(anchor.group(1))
        if href.startswith("/"):
            href = "https://weixin.sogou.com" + href
        if href in seen:
            continue
        seen.add(href)

        summary = ""
        desc = re.search(r'<p[^>]*class=["\'][^"\']*txt-info[^"\']*["\'][^>]*>(.*?)</p>', block, re.S)
        if desc:
            summary = clean_text(re.sub(r"<!--.*?-->", "", desc.group(1)))[:300]

        account = ""
        acc = re.search(r'<span[^>]*class=["\'][^"\']*all-time-y2[^"\']*["\'][^>]*>(.*?)</span>', block, re.S)
        if acc:
            account = clean_text(acc.group(1))

        pub_date = ""
        stamp = re.search(r"timeConvert\(\s*['\"](\d+)['\"]", block)
        if stamp:
            pub_date = format_datetime(
                datetime.datetime.fromtimestamp(int(stamp.group(1)), datetime.timezone.utc)
            )
        else:
            clock = re.search(r'<span[^>]*class=["\'][^"\']*s2[^"\']*["\'][^>]*>(.*?)</span>', block, re.S)
            if clock:
                pub_date = clean_text(clock.group(1))

        items.append({
            "title": title,
            "link": href,
            "description": summary,
            "pubDate": pub_date,
            "account": account,
            "exact": bool(account and (account == query or query in account)),
        })

    items.sort(key=lambda it: (bool(it["exact"]), pub_timestamp(it.get("pubDate", ""))), reverse=True)
    return f"公众号·{query}", items[:20]


def looks_like_feed(raw: bytes) -> bool:
    head = raw[:400].lstrip().lower()
    return head.startswith(b"<?xml") or b"<rss" in head or b"<feed" in head


def lan_addresses() -> list[str]:
    """获取本机在局域网中的地址，供手机扫码访问。"""
    found: list[str] = []
    for iface in ("en0", "en1", "en2", "en3"):
        try:
            address = subprocess.check_output(
                ["ipconfig", "getifaddr", iface], timeout=2, text=True
            ).strip()
        except (subprocess.SubprocessError, FileNotFoundError, OSError):
            continue
        if address and not address.startswith("127.") and address not in found:
            found.append(address)

    if not found:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
            if address and not address.startswith("127."):
                found.append(address)
        except OSError:
            pass
        finally:
            probe.close()

    return found


def page_urls() -> list[str]:
    return [f"http://{ip}:{PORT}/ai-hotspots-online.html" for ip in lan_addresses()]


def ai_host_allowed(base_url: str) -> tuple[bool, str]:
    """允许任意公网 HTTPS 兼容端点；默认拒绝内网/本机，防止 SSRF。"""
    try:
        parsed = urllib.parse.urlparse(base_url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False, "Base URL 格式无效"

    if parsed.scheme not in ("http", "https"):
        return False, "Base URL 仅支持 http/https"
    if not host:
        return False, "Base URL 缺少域名"

    allow_local = os.environ.get("RELAY_ALLOW_LOCAL_AI") == "1"

    # 本机 / 内网直连（含本地 Ollama），需显式放开
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            if not allow_local:
                return False, "默认禁止访问内网地址；本地模型请设置 RELAY_ALLOW_LOCAL_AI=1"
            return True, ""
    except ValueError:
        pass

    if host in ("localhost", "localhost.localdomain") or host.endswith((".localhost", ".local", ".internal")):
        if not allow_local:
            return False, "默认禁止访问本机地址；本地模型请设置 RELAY_ALLOW_LOCAL_AI=1"
        return True, ""

    return True, ""


def call_ai_models(payload: dict) -> tuple[int, dict]:
    """仅探测 /models，不产生 chat 费用。"""
    base = str(payload.get("baseUrl") or "").strip().rstrip("/")
    key = str(payload.get("apiKey") or "").strip()
    if not base or not key:
        return 400, {"error": {"code": "BAD_REQUEST", "message": "缺少 baseUrl / apiKey"}}

    allowed, reason = ai_host_allowed(base)
    if not allowed:
        return 400, {"error": {"code": "HOST_NOT_ALLOWED", "message": reason}}

    request = urllib.request.Request(
        base + "/models",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")[:300]
        return 502, {"error": {"code": "AI_UPSTREAM", "message": f"HTTP {exc.code}: {detail}"}}
    except urllib.error.URLError as exc:
        return 502, {"error": {"code": "AI_UNREACHABLE", "message": f"网络错误：{exc.reason}"}}
    except TimeoutError:
        return 502, {"error": {"code": "AI_TIMEOUT", "message": "接口响应超时"}}

    try:
        return 200, json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return 502, {"error": {"code": "AI_BAD_JSON", "message": "上游返回的不是合法 JSON"}}


def call_ai(payload: dict) -> tuple[int, dict]:
    base = str(payload.get("baseUrl") or "").strip().rstrip("/")
    key = str(payload.get("apiKey") or "").strip()
    model = str(payload.get("model") or "").strip()
    messages = payload.get("messages")

    if not base or not key or not model or not isinstance(messages, list) or not messages:
        return 400, {"error": {"code": "BAD_REQUEST", "message": "缺少 baseUrl / apiKey / model / messages"}}

    allowed, reason = ai_host_allowed(base)
    if not allowed:
        return 400, {"error": {"code": "HOST_NOT_ALLOWED", "message": reason}}

    try:
        max_tokens = max(256, min(int(payload.get("maxTokens", 1800)), 4096))
    except (TypeError, ValueError):
        max_tokens = 1800

    body = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    if payload.get("jsonMode"):
        body["response_format"] = {"type": "json_object"}

    request = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")[:300]
        return 502, {"error": {"code": "AI_UPSTREAM", "message": f"HTTP {exc.code}: {detail}"}}
    except urllib.error.URLError as exc:
        return 502, {"error": {"code": "AI_UNREACHABLE", "message": f"网络错误：{exc.reason}"}}
    except TimeoutError:
        return 502, {"error": {"code": "AI_TIMEOUT", "message": "AI 接口响应超时"}}

    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return 502, {"error": {"code": "AI_BAD_JSON", "message": "上游返回的不是合法 JSON"}}

    return 200, data


def fetch_feed(url: str) -> dict:
    if not url.lower().startswith(("http://", "https://")):
        return {"status": "error", "message": "仅支持 http/https"}
    if not host_allowed(url):
        return {"status": "error", "message": f"域名不在白名单：{url}"}

    fresh = cache_get(url)
    if fresh is not None:
        return fresh

    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })

    raw = None
    failure = ""
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read()
            failure = ""
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")[:160]
            failure = f"HTTP {exc.code}: {detail}" if detail else f"HTTP {exc.code}"
            if exc.code < 500:
                break
        except urllib.error.URLError as exc:
            failure = f"网络错误：{exc.reason}"
        except TimeoutError:
            failure = "请求超时"
        except OSError as exc:
            failure = f"网络错误：{exc}"
        if attempt == 0:
            time.sleep(0.5)

    def fallback(reason: str) -> dict:
        stale = cache_get(url, allow_stale=True)
        if stale:
            return {**stale, "stale": True, "message": reason}
        return {"status": "error", "message": reason}

    if raw is None:
        return fallback(failure)

    if looks_like_feed(raw):
        try:
            title, items = parse_feed(raw)
        except ET.ParseError as exc:
            return fallback(f"XML 解析失败：{exc}")
        items = sort_and_limit(items)
    else:
        # 官方站没有 RSS 时，服务端直接解析 HTML 页面，绕过 Jina 与浏览器 CORS
        title, items = parse_html_page(url, raw)
        if not items:
            # 可能被 WAF 挑战页拦下（urllib 指纹），用 curl 再试一次
            alternate = fetch_via_curl(url)
            if alternate:
                title, items = parse_html_page(url, alternate)
        if not items:
            return fallback("页面未解析出条目（缺少该站点的适配规则）")

    payload = {
        "status": "ok",
        "feed": {"title": title, "url": url},
        "items": items,
    }
    cache_put(url, payload)
    return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "HotspotRelay/1.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def _send(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            self._json(200, {"status": "ok", "service": "hotspot-relay", "port": PORT})
            return

        if parsed.path == "/api/lan":
            self._json(200, {
                "status": "ok",
                "addresses": lan_addresses(),
                "port": PORT,
                "urls": page_urls(),
            })
            return

        if parsed.path == "/api/qr":
            text = (urllib.parse.parse_qs(parsed.query).get("text") or [""])[0][:500]
            if not text:
                self._json(400, {"error": {"code": "BAD_REQUEST", "message": "缺少 text 参数"}})
                return
            try:
                import segno
                qr = segno.make(text, error="m")
                buffer = io.BytesIO()
                qr.save(buffer, kind="svg", scale=6, border=2, dark="#14211f", light="#ffffff")
                self._send(200, buffer.getvalue(), "image/svg+xml; charset=utf-8")
            except ImportError:
                # 未安装 segno 时降级到在线二维码服务，页面仍可显示完整 URL
                target = (
                    "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data="
                    + urllib.parse.quote(text, safe="")
                )
                self.send_response(302)
                self.send_header("Location", target)
                self.end_headers()
            return

        if parsed.path == "/api/wechat":
            name = (urllib.parse.parse_qs(parsed.query).get("name") or [""])[0].strip()[:60]
            if not name:
                self._json(400, {"error": {"code": "BAD_REQUEST", "message": "缺少 name 参数"}})
                return
            search_url = (
                "https://weixin.sogou.com/weixin?type=2&query="
                + urllib.parse.quote(name, safe="")
            )

            # 双通道抓取：urllib 优先，拿不到文章结构再用 curl（绕过部分 WAF 指纹）
            raw = None
            request = urllib.request.Request(search_url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                    raw = response.read()
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
                raw = None

            if not raw or b"txt-box" not in raw:
                alternate = fetch_via_curl(search_url)
                if alternate and (b"txt-box" in alternate or raw is None or len(alternate) > len(raw)):
                    raw = alternate

            if not raw:
                self._json(502, {"error": {"code": "WECHAT_FAILED", "message": "公众号搜索抓取失败"}})
                return

            title, items = parse_sogou_wechat(raw, name)
            if not items:
                self._json(502, {"error": {
                    "code": "WECHAT_EMPTY",
                    "message": f"未找到「{name}」的相关文章（源站返回 {len(raw)} 字节）",
                    "raw_head": raw[:160].decode("utf-8", "ignore"),
                }})
                return
            self._json(200, {
                "status": "ok",
                "feed": {"title": title, "url": search_url},
                "items": items,
            })
            return

        if parsed.path == "/api/rss":
            params = urllib.parse.parse_qs(parsed.query)
            target = (params.get("url") or [""])[0]
            if not target:
                self._json(400, {"status": "error", "message": "缺少 url 参数"})
                return
            result = fetch_feed(target)
            self._json(200 if result.get("status") == "ok" else 502, result)
            return

        # 顺带托管页面，使其与接口同源，彻底规避 file:// 的跨域限制
        static_pages = {
            "/": "ai-hotspots-online.html",
            "/index.html": "ai-hotspots-online.html",
            "/ai-hotspots-online.html": "ai-hotspots-online.html",
            "/mobile": "ai-hotspots-mobile.html",
            "/ai-hotspots-mobile.html": "ai-hotspots-mobile.html",
        }
        if parsed.path in static_pages:
            page = Path(__file__).resolve().parent / static_pages[parsed.path]
            if page.exists():
                self._send(200, page.read_bytes(), "text/html; charset=utf-8")
                return
            self._json(404, {"status": "error", "message": "页面文件不存在"})
            return

        self._json(404, {"status": "error", "message": "未知路径"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/api/ai", "/api/ai/models"):
            self._json(404, {"status": "error", "message": "未知路径"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 200_000:
            self._json(400, {"error": {"code": "BAD_REQUEST", "message": "请求体为空或过大"}})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": {"code": "BAD_REQUEST", "message": "请求体不是合法 JSON"}})
            return

        status, result = (
            call_ai_models(payload) if parsed.path == "/api/ai/models" else call_ai(payload)
        )
        self._json(status, result)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\n  AI 热点中转服务已启动")
    print(f"  本机：http://127.0.0.1:{PORT}/ai-hotspots-online.html")
    for url in page_urls():
        print(f"  手机（同一 WiFi）：{url}")
    if not page_urls():
        print("  未检测到局域网地址，手机访问需先连接 WiFi")
    print(f"  健康检查：http://127.0.0.1:{PORT}/health")
    print(f"\n  服务已开放局域网访问，仅建议在同一 WiFi 下使用。")
    print(f"  保持此窗口开着，回到网页点击「刷新热点」。Ctrl+C 停止。\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止\n")


if __name__ == "__main__":
    main()
