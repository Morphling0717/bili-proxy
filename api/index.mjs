import coreHandler from '../lib/core.mjs';
import {
  BrowserVideoError,
  fetchVideosWithBrowser,
} from '../lib/browser-videos.mjs';

export const config = { maxDuration: 120 };

const VERSION = '2.1.0';

const bool = (value) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(Array.isArray(value) ? value[0] : value ?? '').toLowerCase(),
  );
const int = (value, fallback, min, max) => {
  const parsed = Number.parseInt(
    String(Array.isArray(value) ? value[0] : value ?? ''),
    10,
  );
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
};
const text = (value, fallback = '') =>
  String(Array.isArray(value) ? value[0] : value ?? fallback);

class CaptureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = undefined;
    this.ended = false;
  }
  setHeader(name, value) {
    this.headers.set(String(name), value);
    return this;
  }
  getHeader(name) {
    const target = String(name).toLowerCase();
    for (const [key, value] of this.headers) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
  }
  removeHeader(name) {
    const target = String(name).toLowerCase();
    for (const key of this.headers.keys()) {
      if (key.toLowerCase() === target) this.headers.delete(key);
    }
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(value) {
    this.body = value;
    this.ended = true;
    return this;
  }
  send(value) {
    this.body = value;
    this.ended = true;
    return this;
  }
  end(value) {
    if (value !== undefined) this.body = value;
    this.ended = true;
    return this;
  }
}

function riskFailure(section) {
  if (!section || section.ok) return false;
  const upstream = section.error?.upstream || {};
  const message = `${section.error?.message || ''} ${upstream.message || ''}`;
  return (
    upstream.code === -352 ||
    [403, 412, 429].includes(upstream.http_status) ||
    /风控|risk|forbidden|precondition|too many/iu.test(message)
  );
}

function legacyVideo(item) {
  return {
    title: item.title,
    desc: item.description,
    pic: item.cover,
    bvid: item.bvid,
    aid: item.aid,
    url: item.url,
    created: item.created,
    length: item.duration,
    play: item.play,
    danmaku: item.danmaku,
    comment: item.comment,
    like: item.like,
    date: item.created_at,
  };
}

function recomputeStatus(body) {
  const sections = Object.values(body?.sections || {});
  const successful = sections.filter((section) => section?.ok).length;
  body.success = successful > 0;
  body.partial = successful > 0 && successful < sections.length;
  return successful > 0 ? 200 : 502;
}

function safeBrowserFailure(error) {
  return {
    type: 'browser_fallback',
    message: error?.message || String(error),
    diagnostics:
      error instanceof BrowserVideoError ? error.diagnostics || {} : {},
  };
}

function replay(captured, req, res) {
  for (const [name, value] of captured.headers) res.setHeader(name, value);
  const status = captured.statusCode || 200;
  if (req.method === 'HEAD' || captured.body === undefined) {
    return res.status(status).end();
  }
  if (
    captured.body !== null &&
    typeof captured.body === 'object' &&
    !Buffer.isBuffer(captured.body)
  ) {
    return res.status(status).json(captured.body);
  }
  return res.status(status).send(captured.body);
}

export default async function handler(req, res) {
  const started = Date.now();
  const captured = new CaptureResponse();
  await coreHandler(req, captured);
  captured.setHeader('X-Bili-Proxy-Version', VERSION);
  if (captured.body && typeof captured.body === 'object') {
    captured.body.version = VERSION;
  }

  const query = req.query || {};
  const videoSection = captured.body?.sections?.videos;
  const browserEnabled = !['0', 'false', 'off'].includes(
    text(query.browser, process.env.BROWSER_FALLBACK ?? '1').toLowerCase(),
  );
  const forceBrowser = bool(query.browser_force);

  if (
    req.method !== 'OPTIONS' &&
    captured.body &&
    browserEnabled &&
    videoSection &&
    (forceBrowser || riskFailure(videoSection))
  ) {
    try {
      const page = int(query.page, 1, 1, 10_000);
      const pageSize = int(query.page_size || query.ps, 30, 1, 50);
      const complete = bool(query.complete || query.deep);
      const maxPages = int(query.max_pages, complete ? 5 : 1, 1, 10);
      const mid = String(captured.body.uid || query.mid || query.uid || '');
      const browserResult = await fetchVideosWithBrowser({
        mid,
        page,
        pageSize,
        complete,
        maxPages,
        tid: int(query.tid, 0, 0, 999_999),
        keyword: text(query.keyword).slice(0, 100),
        order: text(query.order, 'pubdate').slice(0, 30),
        cookie: process.env.BI_COOKIE || '',
        timeoutMs: int(query.browser_timeout_ms, 42_000, 15_000, 55_000),
      });

      captured.body.sections.videos = {
        ok: true,
        data: browserResult.data,
        source: 'browser',
      };
      captured.body.videos = browserResult.data.items.map(legacyVideo);
      captured.body.video_count = captured.body.videos.length;
      captured.body.browser_fallback = {
        used: true,
        diagnostics: browserResult.diagnostics,
      };
      captured.body.request = {
        ...(captured.body.request || {}),
        browser_fallback: 'used',
      };
      captured.statusCode = recomputeStatus(captured.body);
    } catch (error) {
      captured.body.browser_fallback = {
        used: false,
        error: safeBrowserFailure(error),
      };
      captured.body.request = {
        ...(captured.body.request || {}),
        browser_fallback: 'failed',
      };
      captured.body.sections.videos.error = {
        ...(captured.body.sections.videos.error || {}),
        browser_fallback: safeBrowserFailure(error),
      };
      captured.statusCode = recomputeStatus(captured.body);
    }
  }

  if (captured.body && typeof captured.body === 'object') {
    captured.body.elapsed_ms = Date.now() - started;
  }
  return replay(captured, req, res);
}
