import coreHandler from '../lib/core.mjs';
import {
  AppVideoError,
  fetchVideosWithApp,
} from '../lib/app-videos.mjs';
import {
  BrowserVideoError,
  fetchVideosWithBrowser,
} from '../lib/browser-videos.mjs';

export const config = { maxDuration: 120 };

const VERSION = '2.2.0';

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
    upstream.code === -412 ||
    [403, 412, 429].includes(upstream.http_status) ||
    /风控|risk|banned|forbidden|precondition|too many/iu.test(message)
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

function safeVideoFailure(error, type) {
  return {
    type,
    message: error?.message || String(error),
    diagnostics:
      error instanceof AppVideoError || error instanceof BrowserVideoError
        ? error.diagnostics || {}
        : {},
  };
}

function installVideoResult(captured, result, source) {
  captured.body.sections.videos = {
    ok: true,
    data: result.data,
    source,
  };
  captured.body.videos = result.data.items.map(legacyVideo);
  captured.body.video_count = captured.body.videos.length;
  captured.body.video_fallback = {
    used: true,
    source,
    diagnostics: result.diagnostics,
  };
  captured.body.request = {
    ...(captured.body.request || {}),
    video_fallback: source,
  };
  captured.statusCode = recomputeStatus(captured.body);
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

function isEverything(query) {
  const section = text(query.section || query.include || 'all')
    .toLowerCase()
    .trim();
  return ['everything', 'full', 'all_public'].includes(section);
}

export default async function handler(req, res) {
  const started = Date.now();
  const originalQuery = req.query || {};
  const everything = isEverything(originalQuery);
  if (everything) {
    req.query = {
      ...originalQuery,
      section:
        'profile,videos,dynamics,articles,audio,collections,favorites,following,followers',
      complete: originalQuery.complete ?? '1',
      max_pages: originalQuery.max_pages ?? '5',
      request_budget: originalQuery.request_budget ?? '40',
    };
  }

  const query = req.query || {};
  const captured = new CaptureResponse();
  await coreHandler(req, captured);
  captured.setHeader('X-Bili-Proxy-Version', VERSION);
  if (captured.body && typeof captured.body === 'object') {
    captured.body.version = VERSION;
    if (everything) captured.body.mode = 'everything';
  }

  const body = captured.body;
  const videoSection = body?.sections?.videos;
  const mid = String(body?.uid || query.mid || query.uid || '');
  const page = int(query.page, 1, 1, 10_000);
  const pageSize = int(query.page_size || query.ps, 30, 1, 50);
  const complete = bool(query.complete || query.deep);
  const maxPages = int(query.max_pages, complete ? 5 : 1, 1, 10);

  const appEnabled = !['0', 'false', 'off'].includes(
    text(query.app_fallback, process.env.APP_FALLBACK ?? '1').toLowerCase(),
  );
  const forceApp = bool(query.app_force);
  let appFailed = false;

  if (
    req.method !== 'OPTIONS' &&
    body &&
    appEnabled &&
    videoSection &&
    (forceApp || !videoSection.ok || riskFailure(videoSection))
  ) {
    try {
      const appResult = await fetchVideosWithApp({
        mid,
        page,
        pageSize,
        complete,
        maxPages,
        keyword: text(query.keyword).slice(0, 100),
        timeoutMs: int(query.app_timeout_ms, 12_000, 4_000, 30_000),
      });
      installVideoResult(captured, appResult, 'app_archive_cursor');
    } catch (error) {
      appFailed = true;
      body.video_fallback = {
        used: false,
        source: 'app_archive_cursor',
        error: safeVideoFailure(error, 'app_fallback'),
      };
      body.sections.videos.error = {
        ...(body.sections.videos.error || {}),
        app_fallback: safeVideoFailure(error, 'app_fallback'),
      };
      body.request = {
        ...(body.request || {}),
        video_fallback: 'app_failed',
      };
    }
  }

  const browserEnabled = ['1', 'true', 'yes', 'on'].includes(
    text(query.browser, process.env.BROWSER_FALLBACK ?? '0').toLowerCase(),
  );
  const forceBrowser = bool(query.browser_force);
  const currentVideoSection = body?.sections?.videos;

  if (
    req.method !== 'OPTIONS' &&
    body &&
    browserEnabled &&
    currentVideoSection &&
    (forceBrowser || (appFailed && riskFailure(currentVideoSection)))
  ) {
    try {
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
      installVideoResult(captured, browserResult, 'browser');
      body.browser_fallback = {
        used: true,
        diagnostics: browserResult.diagnostics,
      };
    } catch (error) {
      body.browser_fallback = {
        used: false,
        error: safeVideoFailure(error, 'browser_fallback'),
      };
      body.sections.videos.error = {
        ...(body.sections.videos.error || {}),
        browser_fallback: safeVideoFailure(error, 'browser_fallback'),
      };
    }
  }

  if (body && typeof body === 'object') {
    captured.statusCode = recomputeStatus(body);
    body.elapsed_ms = Date.now() - started;
  }
  return replay(captured, req, res);
}
