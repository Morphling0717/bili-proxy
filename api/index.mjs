import coreHandler from '../lib/core.mjs';
import {
  AppVideoError,
  fetchVideosWithApp,
} from '../lib/app-videos.mjs';
import {
  BrowserVideoError,
  fetchVideosWithBrowser,
} from '../lib/browser-videos.mjs';
import {
  PublicRelationError,
  fetchPublicRelations,
} from '../lib/public-relations.mjs';
import {
  PublicSectionError,
  collectPublicSections,
} from '../lib/public-sections.mjs';

export const config = { maxDuration: 120 };

const VERSION = '3.1.0';

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

function sectionNames(value) {
  return new Set(
    text(value, 'all')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function riskFailure(section) {
  if (!section || section.ok) return false;
  const upstream = section.error?.upstream || {};
  const message = `${section.error?.message || ''} ${upstream.message || ''}`;
  return (
    upstream.code === -101 ||
    upstream.code === -352 ||
    upstream.code === -412 ||
    [403, 412, 429].includes(upstream.http_status) ||
    /风控|未登录|not logged|risk|banned|forbidden|precondition|too many/iu.test(
      message,
    )
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

function recomputeStatus(body, fallbackStatus = 200) {
  if (
    !body?.sections ||
    Array.isArray(body.sections) ||
    typeof body.sections !== 'object'
  ) {
    return fallbackStatus;
  }
  const sections = Object.values(body.sections);
  if (sections.length === 0) return fallbackStatus;
  const successful = sections.filter((section) => section?.ok).length;
  body.success = successful > 0;
  body.partial = successful > 0 && successful < sections.length;
  return successful > 0 ? 200 : 502;
}

function safeFallbackFailure(error, type) {
  return {
    type,
    message: error?.message || String(error),
    diagnostics:
      error instanceof AppVideoError ||
      error instanceof BrowserVideoError ||
      error instanceof PublicRelationError ||
      error instanceof PublicSectionError
        ? error.diagnostics || error.details || {}
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
  captured.statusCode = recomputeStatus(captured.body, captured.statusCode);
}

function mergePublicSection(body, name, incoming) {
  const previous = body.sections?.[name];
  if (incoming?.ok) {
    body.sections[name] = incoming;
    if (name === 'public_extras') body.extras = incoming.data;
    return;
  }
  if (previous?.ok) {
    body.sections[name] = {
      ...previous,
      public_fallback_error: incoming?.error || null,
    };
    return;
  }
  body.sections[name] = {
    ...(previous || {}),
    ok: false,
    error: previous?.error || incoming?.error || {
      type: 'internal',
      message: `${name} failed`,
    },
    public_fallback_error: incoming?.error || null,
  };
}

function installRelationResult(body, name, result) {
  const previous = body.sections?.[name];
  body.sections[name] = {
    ok: true,
    data: result.data,
    source: 'biligame_public_relation',
    ...(previous?.error ? { fallback_from: previous.error } : {}),
  };
  body.relation_fallback = {
    ...(body.relation_fallback || {}),
    [name]: {
      used: true,
      source: 'biligame_public_relation',
      diagnostics: result.diagnostics,
    },
  };
}

function relationKnownTotal(body, name) {
  const statistics = body.sections?.profile?.data?.statistics;
  const candidate =
    name === 'following' ? statistics?.following : statistics?.followers;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
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

function prepareCoreQuery(originalQuery, everything) {
  if (everything) {
    return {
      ...originalQuery,
      section:
        'profile,videos,dynamics,articles,audio,collections,favorites,following,followers',
      complete: originalQuery.complete ?? '1',
      max_pages: originalQuery.max_pages ?? '5',
      request_budget: originalQuery.request_budget ?? '40',
    };
  }

  const raw = text(originalQuery.section || originalQuery.include || 'all');
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const extrasRequested = names.some(
    (name) => name.toLowerCase() === 'public_extras',
  );
  if (!extrasRequested) return originalQuery;
  const coreNames = names.filter(
    (name) => name.toLowerCase() !== 'public_extras',
  );
  return {
    ...originalQuery,
    section: coreNames.length ? coreNames.join(',') : 'profile',
  };
}

function wantsPublicExtras(originalQuery, everything) {
  return (
    everything ||
    bool(originalQuery.extras || originalQuery.public_extras) ||
    sectionNames(originalQuery.section || originalQuery.include).has(
      'public_extras',
    )
  );
}

function wantsRequestedSection(originalQuery, coreQuery, everything, name) {
  if (everything) return true;
  const original = sectionNames(originalQuery.section || originalQuery.include);
  if (original.has('all')) {
    return ['dynamics', 'collections', 'favorites'].includes(name);
  }
  const core = sectionNames(coreQuery.section || coreQuery.include);
  return original.has(name) || core.has(name);
}

export default async function handler(req, res) {
  const started = Date.now();
  const originalQuery = req.query || {};
  const everything = isEverything(originalQuery);
  req.query = prepareCoreQuery(originalQuery, everything);
  const query = req.query || {};

  const captured = new CaptureResponse();
  await coreHandler(req, captured);
  captured.setHeader('X-Bili-Proxy-Version', VERSION);
  if (captured.body && typeof captured.body === 'object') {
    captured.body.version = VERSION;
    if (everything) captured.body.mode = 'everything';
  }

  const body = captured.body;
  if (
    !body?.sections ||
    Array.isArray(body.sections) ||
    typeof body.sections !== 'object'
  ) {
    if (body && bool(originalQuery.help)) {
      body.version = VERSION;
      body.modes = ['all', 'everything'];
      body.public_sections = ['public_extras'];
      body.examples = [
        ...(Array.isArray(body.examples) ? body.examples : []),
        '/api?mid=3546779356235807&section=everything',
        '/api?mid=3546779356235807&section=videos&complete=1&max_pages=10',
      ];
    }
    if (body && typeof body === 'object') body.elapsed_ms = Date.now() - started;
    return replay(captured, req, res);
  }

  const videoSection = body.sections.videos;
  const mid = String(body.uid || query.mid || query.uid || '');
  const page = int(query.page, 1, 1, 10_000);
  const pageSize = int(query.page_size || query.ps, 30, 1, 50);
  const complete = bool(query.complete || query.deep);
  const maxPages = int(query.max_pages, complete ? 5 : 1, 1, 10);
  const debug = bool(query.debug);

  const appEnabled = !['0', 'false', 'off'].includes(
    text(query.app_fallback, process.env.APP_FALLBACK ?? '1').toLowerCase(),
  );
  const forceApp = bool(query.app_force);
  let appFailed = false;

  if (
    req.method !== 'OPTIONS' &&
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
        error: safeFallbackFailure(error, 'app_fallback'),
      };
      body.sections.videos.error = {
        ...(body.sections.videos.error || {}),
        app_fallback: safeFallbackFailure(error, 'app_fallback'),
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
  const currentVideoSection = body.sections.videos;

  if (
    req.method !== 'OPTIONS' &&
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
        error: safeFallbackFailure(error, 'browser_fallback'),
      };
      body.sections.videos.error = {
        ...(body.sections.videos.error || {}),
        browser_fallback: safeFallbackFailure(error, 'browser_fallback'),
      };
    }
  }

  const publicForce = bool(query.public_force || query.enhanced);
  const publicSections = [];
  for (const name of [
    'dynamics',
    'collections',
    'favorites',
    'following',
    'followers',
  ]) {
    if (!wantsRequestedSection(originalQuery, query, everything, name)) continue;
    const current = body.sections[name];
    const ambiguousFavorite =
      name === 'favorites' &&
      current?.ok &&
      (current.data === null ||
        current.data === undefined ||
        !Array.isArray(current.data?.list));
    if (
      everything ||
      publicForce ||
      !current?.ok ||
      riskFailure(current) ||
      ambiguousFavorite
    ) {
      publicSections.push(name);
    }
  }
  if (wantsPublicExtras(originalQuery, everything)) {
    publicSections.push('public_extras');
  }

  if (publicSections.length > 0 && req.method !== 'OPTIONS') {
    try {
      const publicResult = await collectPublicSections({
        mid,
        sections: [...new Set(publicSections)],
        complete,
        maxPages,
        pageSize,
        dynamicOffset: text(query.offset),
        opusOffset: text(query.opus_offset),
        expandFavorites:
          bool(query.expand_favorites || query.favorite_items) || everything,
        favoriteFolderLimit: int(
          query.favorite_folder_limit,
          everything ? 5 : 10,
          1,
          20,
        ),
        timeoutMs: int(query.public_timeout_ms, 10_000, 3_000, 30_000),
        requestBudget: int(
          query.public_request_budget,
          everything ? 80 : 40,
          4,
          80,
        ),
        cookie: process.env.BI_COOKIE || '',
      });
      for (const [name, result] of Object.entries(publicResult.sections)) {
        mergePublicSection(body, name, result);
      }
      body.request = {
        ...(body.request || {}),
        public_collector: [...new Set(publicSections)],
      };
      if (debug) {
        body.diagnostics = {
          ...(body.diagnostics || {}),
          public_collector: publicResult.diagnostics,
        };
      }
    } catch (error) {
      body.public_collector_error = safeFallbackFailure(
        error,
        'public_collector',
      );
    }
  }

  const relationNames = ['following', 'followers'].filter((name) =>
    wantsRequestedSection(originalQuery, query, everything, name),
  );
  const relationDiagnostics = {};
  for (const name of relationNames) {
    const current = body.sections[name];
    if (current?.ok && !publicForce) continue;
    try {
      const relationResult = await fetchPublicRelations({
        mid,
        kind: name,
        page,
        pageSize,
        complete,
        maxPages,
        knownTotal: relationKnownTotal(body, name),
        timeoutMs: int(query.relation_timeout_ms, 10_000, 3_000, 30_000),
      });
      installRelationResult(body, name, relationResult);
      relationDiagnostics[name] = relationResult.diagnostics;
    } catch (error) {
      const fallbackError = safeFallbackFailure(error, 'relation_fallback');
      body.sections[name] = {
        ...(current || {}),
        ok: false,
        error:
          current?.error ||
          fallbackError || {
            type: 'relation_fallback',
            message: `${name} failed`,
          },
        relation_fallback_error: fallbackError,
      };
      relationDiagnostics[name] = fallbackError.diagnostics || {};
    }
  }

  if (relationNames.length > 0) {
    body.request = {
      ...(body.request || {}),
      relation_fallback: relationNames,
    };
    if (debug) {
      body.diagnostics = {
        ...(body.diagnostics || {}),
        relation_fallback: relationDiagnostics,
      };
    }
  }

  captured.statusCode = recomputeStatus(body, captured.statusCode);
  body.elapsed_ms = Date.now() - started;
  return replay(captured, req, res);
}
