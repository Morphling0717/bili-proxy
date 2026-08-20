import { createHash, randomUUID } from 'node:crypto';

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const DYNAMIC_FEATURES =
  'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const iso = (timestamp) =>
  Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000).toISOString() : null;
const asArray = (value) => (Array.isArray(value) ? value : []);

function httpsUrl(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^http:\/\/[^/]*(?:hdslb|biliimg|bilivideo|bilibili)\./iu.test(value)) {
    return `https://${value.slice(7)}`;
  }
  return value;
}

function sanitize(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') return httpsUrl(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  }
  return value;
}

function parseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class PublicSectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PublicSectionError';
    this.details = details;
  }
}

class CookieJar {
  constructor(value = '') {
    this.map = new Map();
    this.mergeCookie(value);
  }

  mergeCookie(value) {
    for (const part of String(value || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0) {
        this.map.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
      }
    }
  }

  mergeSetCookie(value) {
    const first = String(value || '').split(';', 1)[0];
    const index = first.indexOf('=');
    if (index > 0) {
      this.map.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
  }

  mergeHeaders(headers) {
    if (typeof headers?.getSetCookie === 'function') {
      for (const value of headers.getSetCookie()) this.mergeSetCookie(value);
      return;
    }
    for (const value of String(headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,\s]+=)/gu)) {
      this.mergeSetCookie(value);
    }
  }

  set(key, value) {
    if (key && value) this.map.set(String(key), String(value));
  }

  delete(key) {
    this.map.delete(key);
  }

  stripInvalidAuth() {
    for (const key of [
      'SESSDATA',
      'bili_jct',
      'DedeUserID',
      'DedeUserID__ckMd5',
      'sid',
    ]) {
      this.delete(key);
    }
  }

  value() {
    return [...this.map].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  summary() {
    return Object.fromEntries(
      ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4', '_uuid'].map((key) => [
        key,
        this.map.has(key),
      ]),
    );
  }
}

function signWbi(params, imgKey, subKey) {
  const rawKey = `${imgKey || ''}${subKey || ''}`;
  const mixinKey = MIXIN.map((index) => rawKey[index] || '').join('').slice(0, 32);
  if (!mixinKey) throw new PublicSectionError('WBI key unavailable');
  const values = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(values)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(
          String(values[key] ?? '').replace(/[!'()*]/gu, ''),
        )}`,
    )
    .join('&');
  const digest = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${digest}`;
}

class PublicClient {
  constructor({ cookie = '', timeoutMs = 10_000, requestBudget = 40 } = {}) {
    this.jar = new CookieJar(cookie);
    this.timeoutMs = clamp(Number(timeoutMs) || 10_000, 3_000, 30_000);
    this.requestBudget = clamp(Number(requestBudget) || 40, 4, 80);
    this.requestCount = 0;
    this.ua = process.env.BILI_USER_AGENT || DEFAULT_UA;
    this.imgKey = '';
    this.subKey = '';
    this.diagnostics = { requests: [] };
  }

  headers({ referer, origin, accept = 'application/json, text/plain, */*' } = {}) {
    const headers = {
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': this.ua,
      'Sec-CH-UA': '"Chromium";v="150", "Not_A Brand";v="99"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
    };
    if (referer) headers.Referer = referer;
    if (origin) headers.Origin = origin;
    if (this.jar.value()) headers.Cookie = this.jar.value();
    return headers;
  }

  url(path, params = {}) {
    const url = path.startsWith('http')
      ? new URL(path)
      : new URL(path, 'https://api.bilibili.com');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async raw(url, options = {}) {
    if (this.requestCount >= this.requestBudget) {
      throw new PublicSectionError('公开分区请求预算已用尽', {
        request_budget: this.requestBudget,
        request_count: this.requestCount,
      });
    }
    this.requestCount += 1;
    const controller = new AbortController();
    const timeout = clamp(Number(options.timeoutMs) || this.timeoutMs, 2_000, 30_000);
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers(options),
        redirect: 'follow',
        signal: controller.signal,
      });
      this.jar.mergeHeaders(response.headers);
      const body = await response.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {}
      const meta = {
        label: options.label || 'request',
        http_status: response.status,
        code: typeof json?.code === 'number' ? json.code : null,
        elapsed_ms: Date.now() - started,
      };
      this.diagnostics.requests.push(meta);
      return { response, body, json, meta };
    } catch (error) {
      const meta = {
        label: options.label || 'request',
        http_status: 0,
        code: null,
        elapsed_ms: Date.now() - started,
        error: error?.name === 'AbortError' ? 'timeout' : error?.message || 'network_error',
      };
      this.diagnostics.requests.push(meta);
      throw new PublicSectionError(
        `${options.label || 'request'}: ${error?.name === 'AbortError' ? '请求超时' : '网络失败'}`,
        meta,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async json(path, params, label, options = {}) {
    const url = path instanceof URL ? path : this.url(path, params);
    const result = await this.raw(url, { ...options, label });
    const code = typeof result.json?.code === 'number' ? result.json.code : null;
    if (!result.response.ok || !result.json || (code !== null && code !== 0)) {
      throw new PublicSectionError(
        `${label}: ${result.json?.message || result.json?.msg || `HTTP ${result.response.status}`}`,
        {
          ...result.meta,
          message: result.json?.message || result.json?.msg || '',
          body_hint: result.json ? undefined : result.body.slice(0, 160),
        },
      );
    }
    return {
      data: result.json.data ?? result.json.result ?? result.json,
      root: result.json,
      meta: result.meta,
    };
  }

  plain(path, params, label, options = {}) {
    return this.json(path, params, label, options);
  }

  signed(path, params, label, options = {}) {
    if (!this.imgKey || !this.subKey) {
      return this.plain(path, params, `${label}.unsigned`, options);
    }
    const url = this.url(path);
    url.search = signWbi(params, this.imgKey, this.subKey);
    return this.json(url, null, label, options);
  }

  async bootstrap(mid) {
    const referer = `https://space.bilibili.com/${mid}/`;
    const finger = await this.raw('https://api.bilibili.com/x/frontend/finger/spi', {
      label: 'public.bootstrap.finger',
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      timeoutMs: 5_000,
    }).catch((error) => ({ json: null, meta: error.details || {} }));
    if (finger.json?.code === 0) {
      this.jar.set('buvid3', finger.json.data?.b_3);
      this.jar.set('buvid4', finger.json.data?.b_4);
    }
    if (!this.jar.map.has('_uuid')) {
      this.jar.set('_uuid', `${randomUUID().toUpperCase()}infoc`);
    }

    let nav = await this.raw('https://api.bilibili.com/x/web-interface/nav', {
      label: 'public.bootstrap.nav',
      referer,
      origin: 'https://space.bilibili.com',
      timeoutMs: 6_000,
    }).catch((error) => ({ json: null, meta: error.details || {} }));

    let staleAuthRemoved = false;
    if (nav.json?.code === -101 && this.jar.map.has('SESSDATA')) {
      this.jar.stripInvalidAuth();
      staleAuthRemoved = true;
      nav = await this.raw('https://api.bilibili.com/x/web-interface/nav', {
        label: 'public.bootstrap.nav.anonymous_retry',
        referer,
        origin: 'https://space.bilibili.com',
        timeoutMs: 6_000,
      }).catch((error) => ({ json: null, meta: error.details || {} }));
    }

    const wbi = nav.json?.data?.wbi_img;
    this.imgKey = String(wbi?.img_url || '').split('/').pop()?.split('.')[0] || '';
    this.subKey = String(wbi?.sub_url || '').split('/').pop()?.split('.')[0] || '';
    const diagnostics = {
      finger: {
        ok: finger.json?.code === 0,
        http_status: finger.meta?.http_status ?? 0,
        code: finger.json?.code ?? null,
      },
      nav: {
        ok: Boolean(this.imgKey && this.subKey),
        http_status: nav.meta?.http_status ?? 0,
        code: nav.json?.code ?? null,
      },
      stale_auth_removed: staleAuthRemoved,
      cookie_fields: this.jar.summary(),
      wbi_keys_loaded: Boolean(this.imgKey && this.subKey),
    };
    this.diagnostics.bootstrap = diagnostics;
    return diagnostics;
  }
}

function errorResult(error) {
  return {
    ok: false,
    error: {
      type: error instanceof PublicSectionError ? 'upstream' : 'internal',
      message: error?.message || String(error),
      upstream: error?.details || null,
    },
  };
}

function normalizeLegacyDynamic(card) {
  const desc = card?.desc || {};
  const payload = sanitize(parseJson(card?.card));
  const id = String(desc.dynamic_id_str || desc.dynamic_id || desc.rid_str || desc.rid || '');
  const timestamp = desc.timestamp ?? desc.ctime ?? null;
  return {
    id: id || null,
    type: desc.type ?? null,
    timestamp,
    created_at: iso(timestamp),
    author_mid: desc.user_profile?.info?.uid ?? desc.uid ?? null,
    source: 'legacy_space_history',
    desc: sanitize(desc),
    card: payload,
  };
}

function normalizeOpus(item) {
  const id = String(item?.opus_id || item?.id_str || item?.id || '');
  const author = item?.modules?.module_author || {};
  const dynamic = item?.modules?.module_dynamic || {};
  const timestamp = item?.pub_ts ?? author?.pub_ts ?? null;
  const content =
    item?.content ||
    item?.summary?.text ||
    dynamic?.desc?.text ||
    dynamic?.major?.opus?.summary?.text ||
    '';
  const cover =
    item?.cover ||
    dynamic?.major?.opus?.pics?.[0] ||
    dynamic?.major?.draw?.items?.[0] ||
    null;
  return {
    id: id || null,
    type: 'OPUS',
    timestamp,
    created_at: iso(timestamp),
    author_mid: author?.mid ?? item?.mid ?? null,
    content,
    cover: sanitize(cover),
    jump_url: httpsUrl(item?.jump_url || item?.basic?.jump_url || ''),
    stat: sanitize(item?.stat || item?.modules?.module_stat || null),
    source: 'opus_feed_space',
    raw: sanitize(item),
  };
}

async function fetchLegacyDynamics(client, {
  mid,
  complete,
  maxPages,
  pageSize,
  offset,
}) {
  const target = pageSize * (complete ? maxPages : 1);
  const pages = complete ? maxPages : 1;
  const items = [];
  let cursor = offset || '0';
  let hasMore = false;
  let nextOffset = null;
  const pageDiagnostics = [];

  for (let pageIndex = 1; pageIndex <= pages; pageIndex += 1) {
    const response = await client.plain(
      'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history',
      {
        visitor_uid: 0,
        host_uid: mid,
        offset_dynamic_id: cursor || 0,
        need_top: pageIndex === 1 ? 1 : 0,
        platform: 'web',
      },
      `dynamics.legacy.page_${pageIndex}`,
      {
        referer: `https://space.bilibili.com/${mid}/dynamic`,
        origin: 'https://space.bilibili.com',
      },
    );
    const cards = asArray(response.data?.cards);
    for (const card of cards) items.push(normalizeLegacyDynamic(card));
    hasMore = Boolean(response.data?.has_more);
    nextOffset = response.data?.next_offset
      ? String(response.data.next_offset)
      : cards.length
        ? String(cards.at(-1)?.desc?.dynamic_id_str || cards.at(-1)?.desc?.dynamic_id || '')
        : null;
    pageDiagnostics.push({
      page: pageIndex,
      count: cards.length,
      has_more: hasMore,
      next_offset: nextOffset,
      ...response.meta,
    });
    if (!hasMore || !nextOffset || cards.length === 0 || items.length >= target) break;
    cursor = nextOffset;
    await sleep(100);
  }

  return {
    items: uniqueBy(items, (item) => item.id || `${item.type}:${item.timestamp}`),
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
    diagnostics: pageDiagnostics,
  };
}

async function fetchOpusDynamics(client, {
  mid,
  complete,
  maxPages,
  pageSize,
  offset,
}) {
  const target = pageSize * (complete ? maxPages : 1);
  const pages = complete ? maxPages : 1;
  const items = [];
  let cursor = offset || '';
  let hasMore = false;
  let nextOffset = null;
  const pageDiagnostics = [];

  for (let pageIndex = 1; pageIndex <= pages; pageIndex += 1) {
    const response = await client.signed(
      '/x/polymer/web-dynamic/v1/opus/feed/space',
      {
        host_mid: mid,
        page: pageIndex,
        offset: cursor || undefined,
        type: 'all',
        web_location: '333.1387',
      },
      `dynamics.opus.page_${pageIndex}`,
      {
        referer: `https://space.bilibili.com/${mid}/article`,
        origin: 'https://space.bilibili.com',
      },
    );
    const batch = asArray(response.data?.items);
    items.push(...batch.map(normalizeOpus));
    hasMore = Boolean(response.data?.has_more);
    nextOffset = response.data?.offset ? String(response.data.offset) : null;
    pageDiagnostics.push({
      page: pageIndex,
      count: batch.length,
      has_more: hasMore,
      next_offset: nextOffset,
      ...response.meta,
    });
    if (!hasMore || !nextOffset || batch.length === 0 || items.length >= target) break;
    cursor = nextOffset;
    await sleep(100);
  }

  return {
    items: uniqueBy(items, (item) => item.id || item.jump_url || item.content),
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
    diagnostics: pageDiagnostics,
  };
}

async function collectDynamics(client, options) {
  const [legacy, opus] = await Promise.allSettled([
    fetchLegacyDynamics(client, {
      ...options,
      offset: options.dynamicOffset || '',
    }),
    fetchOpusDynamics(client, {
      ...options,
      offset: options.opusOffset || '',
    }),
  ]);

  const successful = [];
  const diagnostics = {};
  if (legacy.status === 'fulfilled') {
    successful.push(...legacy.value.items);
    diagnostics.legacy_space_history = {
      ok: true,
      count: legacy.value.items.length,
      pages: legacy.value.diagnostics,
    };
  } else {
    diagnostics.legacy_space_history = errorResult(legacy.reason);
  }
  if (opus.status === 'fulfilled') {
    successful.push(...opus.value.items);
    diagnostics.opus_feed_space = {
      ok: true,
      count: opus.value.items.length,
      pages: opus.value.diagnostics,
    };
  } else {
    diagnostics.opus_feed_space = errorResult(opus.reason);
  }

  if (legacy.status === 'rejected' && opus.status === 'rejected') {
    throw new PublicSectionError('动态公开回退接口全部失败', diagnostics);
  }

  const items = uniqueBy(
    successful,
    (item) => item.id || item.jump_url || `${item.type}:${item.timestamp}:${item.content}`,
  );
  return {
    items,
    total_returned: items.length,
    streams: {
      legacy_space_history:
        legacy.status === 'fulfilled'
          ? {
              count: legacy.value.items.length,
              has_more: legacy.value.has_more,
              next_offset: legacy.value.next_offset,
            }
          : null,
      opus_feed_space:
        opus.status === 'fulfilled'
          ? {
              count: opus.value.items.length,
              has_more: opus.value.has_more,
              next_offset: opus.value.next_offset,
            }
          : null,
    },
    completeness: 'best_effort_public',
    diagnostics,
  };
}

function normalizeCollectionGroup(group, kind) {
  const meta = sanitize(group?.meta || {});
  const id =
    kind === 'season'
      ? meta.season_id ?? group?.season_id ?? null
      : meta.series_id ?? group?.series_id ?? null;
  return {
    id,
    kind,
    title: meta.name || group?.name || '',
    description: meta.description || '',
    cover: httpsUrl(meta.cover || group?.cover || ''),
    total: Number(meta.total ?? group?.total ?? asArray(group?.archives).length),
    meta,
    recent_aids: asArray(group?.recent_aids),
    preview_archives: sanitize(asArray(group?.archives)),
    source: 'seasons_series_list',
  };
}

async function requestCollectionsPage(client, { mid, page, pageSize }) {
  const referer = `https://space.bilibili.com/${mid}/lists`;
  const attempts = [
    {
      source: 'seasons_series_list_wbi',
      run: () =>
        client.signed(
          '/x/polymer/web-space/seasons_series_list',
          {
            mid,
            page_num: page,
            page_size: pageSize,
            web_location: '333.999',
          },
          `collections.list_wbi.page_${page}`,
          { referer, origin: 'https://space.bilibili.com' },
        ),
    },
    {
      source: 'seasons_series_list_plain',
      run: () =>
        client.plain(
          '/x/polymer/web-space/seasons_series_list',
          {
            mid,
            page_num: page,
            page_size: pageSize,
            web_location: '333.999',
          },
          `collections.list_plain.page_${page}`,
          { referer, origin: 'https://space.bilibili.com' },
        ),
    },
  ];
  if (page === 1) {
    attempts.push({
      source: 'home_seasons_series_wbi',
      run: () =>
        client.signed(
          '/x/polymer/web-space/home/seasons_series',
          { mid, page_num: page, page_size: pageSize },
          'collections.home_wbi',
          { referer: `https://space.bilibili.com/${mid}/`, origin: 'https://space.bilibili.com' },
        ),
    });
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      return { response: await attempt.run(), source: attempt.source, errors };
    } catch (error) {
      errors.push({ source: attempt.source, ...errorResult(error).error });
    }
  }
  throw new PublicSectionError(`合集第 ${page} 页所有接口均失败`, { attempts: errors });
}

async function collectCollections(client, { mid, complete, maxPages }) {
  const pageSize = 20;
  const pages = complete ? maxPages : 1;
  const seasons = [];
  const series = [];
  const diagnostics = [];
  const sources = new Set();
  let hasMore = false;
  let totalPages = 0;

  for (let page = 1; page <= pages; page += 1) {
    const attempt = await requestCollectionsPage(client, { mid, page, pageSize });
    const response = attempt.response;
    const root = response.data?.items_lists || response.data || {};
    const seasonBatch = asArray(root.seasons_list);
    const seriesBatch = asArray(root.series_list);
    seasons.push(...seasonBatch.map((group) => normalizeCollectionGroup(group, 'season')));
    series.push(...seriesBatch.map((group) => normalizeCollectionGroup(group, 'series')));
    sources.add(attempt.source);
    totalPages = Number(root.page?.total || totalPages || 0);
    hasMore = totalPages > 0 ? page < totalPages : seasonBatch.length + seriesBatch.length >= pageSize;
    diagnostics.push({
      page,
      source: attempt.source,
      seasons: seasonBatch.length,
      series: seriesBatch.length,
      total_pages: totalPages || null,
      prior_attempt_errors: attempt.errors,
      ...response.meta,
    });
    if (
      attempt.source === 'home_seasons_series_wbi' ||
      !hasMore ||
      seasonBatch.length + seriesBatch.length === 0
    ) {
      hasMore = attempt.source === 'home_seasons_series_wbi' ? false : hasMore;
      break;
    }
    await sleep(100);
  }

  const uniqueSeasons = uniqueBy(seasons, (item) => `season:${item.id}`);
  const uniqueSeries = uniqueBy(series, (item) => `series:${item.id}`);
  return {
    seasons: uniqueSeasons,
    series: uniqueSeries,
    items: [...uniqueSeasons, ...uniqueSeries],
    counts: {
      seasons: uniqueSeasons.length,
      series: uniqueSeries.length,
      total: uniqueSeasons.length + uniqueSeries.length,
    },
    page_size: pageSize,
    pages_fetched: diagnostics.length,
    has_more: hasMore,
    next_page: hasMore ? diagnostics.length + 1 : null,
    sources: [...sources],
    completeness: sources.has('home_seasons_series_wbi')
      ? 'series_only_fallback'
      : 'public_page',
    diagnostics,
  };
}

function normalizeFolderState(data, source) {
  if (data === null || data === undefined) {
    return {
      available: false,
      visibility: 'empty_or_not_public',
      count: null,
      items: [],
      source,
    };
  }
  const items = sanitize(asArray(data.list));
  return {
    available: true,
    visibility: 'public',
    count: Number(data.count ?? items.length),
    items,
    source,
  };
}

async function fetchFavoriteFolderContents(client, {
  mid,
  mediaId,
  complete,
  maxPages,
  pageSize,
}) {
  const items = [];
  const diagnostics = [];
  let total = 0;
  let hasMore = false;
  const pages = complete ? maxPages : 1;

  for (let page = 1; page <= pages; page += 1) {
    const response = await client.plain(
      '/x/v3/fav/resource/list',
      {
        media_id: mediaId,
        pn: page,
        ps: Math.min(20, pageSize),
        order: 'mtime',
        type: 0,
        platform: 'web',
      },
      `favorites.folder_${mediaId}.page_${page}`,
      {
        referer: `https://space.bilibili.com/${mid}/favlist?fid=${mediaId}`,
        origin: 'https://space.bilibili.com',
      },
    );
    const batch = sanitize(asArray(response.data?.medias));
    items.push(...batch);
    total = Number(response.data?.info?.media_count ?? response.data?.count ?? total ?? 0);
    hasMore = total > 0 ? items.length < total : batch.length >= Math.min(20, pageSize);
    diagnostics.push({ page, count: batch.length, total: total || null, ...response.meta });
    if (!hasMore || batch.length === 0) break;
    await sleep(100);
  }

  return {
    media_id: mediaId,
    items: uniqueBy(items, (item) => `${item.id}:${item.type}`),
    total: total || items.length,
    has_more: hasMore,
    next_page: hasMore ? diagnostics.length + 1 : null,
    pages_fetched: diagnostics.length,
    diagnostics,
  };
}

async function collectFavorites(client, {
  mid,
  complete,
  maxPages,
  pageSize,
  expandFavorites,
  favoriteFolderLimit,
}) {
  const referer = `https://space.bilibili.com/${mid}/favlist`;
  const [createdResult, collectedResult] = await Promise.allSettled([
    client.plain(
      '/x/v3/fav/folder/created/list-all',
      { up_mid: mid, type: 0, web_location: '333.1387' },
      'favorites.created',
      { referer, origin: 'https://space.bilibili.com' },
    ),
    client.plain(
      '/x/v3/fav/folder/collected/list',
      { up_mid: mid, pn: 1, ps: 70, platform: 'web' },
      'favorites.collected',
      { referer, origin: 'https://space.bilibili.com' },
    ),
  ]);

  const created =
    createdResult.status === 'fulfilled'
      ? normalizeFolderState(createdResult.value.data, 'created_list_all')
      : { ...normalizeFolderState(null, 'created_list_all'), error: errorResult(createdResult.reason).error };
  const collected =
    collectedResult.status === 'fulfilled'
      ? normalizeFolderState(collectedResult.value.data, 'collected_list')
      : { ...normalizeFolderState(null, 'collected_list'), error: errorResult(collectedResult.reason).error };

  if (createdResult.status === 'rejected' && collectedResult.status === 'rejected') {
    throw new PublicSectionError('收藏夹目录接口全部失败', {
      created: errorResult(createdResult.reason),
      collected: errorResult(collectedResult.reason),
    });
  }

  const contents = {};
  const contentErrors = {};
  if (expandFavorites) {
    const folders = uniqueBy(
      [...created.items, ...collected.items],
      (folder) => String(folder?.id || folder?.media_id || ''),
    ).slice(0, favoriteFolderLimit);
    for (const folder of folders) {
      const mediaId = folder?.id || folder?.media_id;
      if (!mediaId) continue;
      try {
        contents[String(mediaId)] = await fetchFavoriteFolderContents(client, {
          mid,
          mediaId,
          complete,
          maxPages,
          pageSize,
        });
      } catch (error) {
        contentErrors[String(mediaId)] = errorResult(error).error;
      }
    }
  }

  return {
    created,
    collected,
    expanded: Boolean(expandFavorites),
    folder_limit: favoriteFolderLimit,
    contents,
    content_errors: contentErrors,
    source: 'public_favorites_bundle',
  };
}

async function collectRelations(client, {
  mid,
  kind,
  complete,
  maxPages,
  pageSize,
}) {
  const isFollowing = kind === 'following';
  const endpoint = isFollowing ? '/x/relation/followings' : '/x/relation/followers';
  const size = Math.min(50, pageSize);
  const pages = complete ? maxPages : 1;
  const items = [];
  const diagnostics = [];
  let total = 0;
  let hasMore = false;

  for (let page = 1; page <= pages; page += 1) {
    const response = await client.plain(
      endpoint,
      {
        vmid: mid,
        pn: page,
        ps: size,
        order: 'desc',
        order_type: isFollowing ? 'attention' : undefined,
      },
      `relations.${kind}.page_${page}`,
      {
        referer: `https://space.bilibili.com/${mid}/${isFollowing ? 'fans/follow' : 'fans/fans'}`,
        origin: 'https://space.bilibili.com',
      },
    );
    const batch = sanitize(asArray(response.data?.list));
    items.push(...batch);
    total = Number(response.data?.total ?? total ?? 0);
    hasMore = total > 0 ? items.length < total : batch.length >= size;
    diagnostics.push({
      page,
      count: batch.length,
      total: total || null,
      ...response.meta,
    });
    if (!hasMore || batch.length === 0) break;
    await sleep(100);
  }

  const unique = uniqueBy(items, (item) => String(item?.mid || item?.uid || ''));
  return {
    items: unique,
    total: total || unique.length,
    page_size: size,
    pages_fetched: diagnostics.length,
    has_more: hasMore,
    next_page: hasMore ? diagnostics.length + 1 : null,
    completeness: hasMore ? 'bounded_public_pages' : 'public_pages',
    source: endpoint,
    diagnostics,
  };
}

async function pageBangumi(client, { mid, type, complete, maxPages, pageSize }) {
  const pages = complete ? maxPages : 1;
  const items = [];
  let total = 0;
  let hasMore = false;
  const diagnostics = [];
  const size = Math.min(30, pageSize);

  for (let page = 1; page <= pages; page += 1) {
    const response = await client.plain(
      '/x/space/bangumi/follow/list',
      { vmid: mid, type, pn: page, ps: size },
      `extras.${type === 1 ? 'bangumi' : 'cinema'}.page_${page}`,
      {
        referer: `https://space.bilibili.com/${mid}/bangumi`,
        origin: 'https://space.bilibili.com',
      },
    );
    const batch = sanitize(asArray(response.data?.list));
    items.push(...batch);
    total = Number(response.data?.total ?? total ?? 0);
    hasMore = total > 0 ? items.length < total : batch.length >= size;
    diagnostics.push({ page, count: batch.length, total: total || null, ...response.meta });
    if (!hasMore || batch.length === 0) break;
    await sleep(100);
  }

  return {
    available: true,
    visibility: 'public',
    items,
    total: total || items.length,
    has_more: hasMore,
    next_page: hasMore ? diagnostics.length + 1 : null,
    pages_fetched: diagnostics.length,
    diagnostics,
  };
}

async function fetchExtra(client, key, path, params, options = {}) {
  try {
    const response = await client.plain(path, params, `extras.${key}`, options);
    if (response.data === null || response.data === undefined) {
      return {
        ok: true,
        data: {
          available: false,
          visibility: 'empty_or_not_public',
          value: null,
        },
        meta: response.meta,
      };
    }
    return { ok: true, data: sanitize(response.data), meta: response.meta };
  } catch (error) {
    return errorResult(error);
  }
}

async function collectExtras(client, { mid, complete, maxPages, pageSize }) {
  const ref = `https://space.bilibili.com/${mid}/`;
  const tasks = {
    masterpieces: fetchExtra(client, 'masterpieces', '/x/space/masterpiece', { vmid: mid }, { referer: ref }),
    tags: fetchExtra(client, 'tags', '/x/space/acc/tags', { mid }, { referer: ref }),
    notice: fetchExtra(client, 'notice', '/x/space/notice', { mid }, { referer: ref }),
    recent_likes: fetchExtra(client, 'recent_likes', '/x/space/like/video', { vmid: mid }, { referer: ref }),
    recent_coins: fetchExtra(client, 'recent_coins', '/x/space/coin/video', { vmid: mid }, { referer: ref }),
    recent_games: fetchExtra(client, 'recent_games', '/x/space/lastplaygame/v2', { mid }, { referer: ref }),
    bangumi: pageBangumi(client, { mid, type: 1, complete, maxPages, pageSize })
      .then((data) => ({ ok: true, data }))
      .catch(errorResult),
    cinema: pageBangumi(client, { mid, type: 2, complete, maxPages, pageSize })
      .then((data) => ({ ok: true, data }))
      .catch(errorResult),
  };

  const entries = await Promise.all(
    Object.entries(tasks).map(async ([key, promise]) => [key, await promise]),
  );
  const data = Object.fromEntries(entries);
  const successful = entries.filter(([, result]) => result.ok).length;
  if (successful === 0) {
    throw new PublicSectionError('公开资料扩展接口全部失败', { fields: data });
  }
  return {
    fields: data,
    successful_fields: successful,
    failed_fields: entries.length - successful,
    source: 'public_space_extras',
  };
}

export async function collectPublicSections({
  mid,
  sections = [],
  complete = false,
  maxPages = 5,
  pageSize = 30,
  dynamicOffset = '',
  opusOffset = '',
  expandFavorites = false,
  favoriteFolderLimit = 10,
  timeoutMs = 10_000,
  requestBudget = 40,
  cookie = process.env.BI_COOKIE || '',
} = {}) {
  if (!/^\d+$/u.test(String(mid || ''))) {
    throw new PublicSectionError('公开分区采集缺少有效 mid');
  }
  const wanted = new Set(sections);
  const client = new PublicClient({ cookie, timeoutMs, requestBudget });
  const bootstrap = await client.bootstrap(String(mid));
  const tasks = {};
  const common = {
    mid: String(mid),
    complete: Boolean(complete),
    maxPages: clamp(Number(maxPages) || 1, 1, 10),
    pageSize: clamp(Number(pageSize) || 30, 1, 50),
    dynamicOffset,
    opusOffset,
    expandFavorites: Boolean(expandFavorites),
    favoriteFolderLimit: clamp(Number(favoriteFolderLimit) || 10, 1, 20),
  };

  if (wanted.has('dynamics')) tasks.dynamics = collectDynamics(client, common);
  if (wanted.has('collections')) tasks.collections = collectCollections(client, common);
  if (wanted.has('favorites')) tasks.favorites = collectFavorites(client, common);
  if (wanted.has('following')) {
    tasks.following = collectRelations(client, { ...common, kind: 'following' });
  }
  if (wanted.has('followers')) {
    tasks.followers = collectRelations(client, { ...common, kind: 'followers' });
  }
  if (wanted.has('public_extras')) tasks.public_extras = collectExtras(client, common);

  const entries = await Promise.allSettled(Object.entries(tasks).map(([, task]) => task));
  const names = Object.keys(tasks);
  const resultSections = Object.fromEntries(
    entries.map((result, index) => {
      const name = names[index];
      if (result.status === 'fulfilled') {
        return [name, { ok: true, data: result.value, source: 'public_fallback_v3' }];
      }
      return [name, errorResult(result.reason)];
    }),
  );

  return {
    sections: resultSections,
    diagnostics: {
      bootstrap,
      request_budget: client.requestBudget,
      request_count: client.requestCount,
      requests: client.diagnostics.requests,
    },
  };
}

export const _test = {
  httpsUrl,
  sanitize,
  normalizeLegacyDynamic,
  normalizeOpus,
  normalizeCollectionGroup,
  normalizeFolderState,
  signWbi,
};
