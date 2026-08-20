const API_ROOT = 'https://line3-h5-mobile-api.biligame.com';
const RELATION_STAT_URL = 'https://api.bilibili.com/x/relation/stat';
const FOLLOWER_PUBLIC_CAP = 100;
const MAX_RELATION_PAGES = 20;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, Number.parseInt(String(value ?? ''), 10) || min));
const finiteNumber = (value) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;

function httpsUrl(value) {
  if (typeof value !== 'string') return value ?? null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('http://')) return `https://${value.slice(7)}`;
  return value;
}

function normalizeRelation(item) {
  const official =
    item?.attestation_display ||
    item?.attention_display ||
    item?.official_verify ||
    item?.official ||
    null;
  const mid = String(item?.mid ?? item?.uid ?? '').trim();
  return {
    mid: mid || null,
    name: item?.uname ?? item?.name ?? item?.nickname ?? null,
    uname: item?.uname ?? item?.name ?? item?.nickname ?? null,
    face: httpsUrl(item?.face || item?.avatar || ''),
    attribute:
      Number.isFinite(Number(item?.attribute)) ? Number(item.attribute) : null,
    mtime: Number.isFinite(Number(item?.mtime)) ? Number(item.mtime) : null,
    official,
    source: 'biligame_public_relation',
  };
}

export class PublicRelationError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'PublicRelationError';
    this.diagnostics = diagnostics;
  }
}

async function fetchRelationStat({ mid, timeoutMs, userAgent }) {
  const url = new URL(RELATION_STAT_URL);
  url.searchParams.set('vmid', String(mid));
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        Referer: `https://space.bilibili.com/${mid}/fans/follow`,
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}

    const diagnostic = {
      source: 'bilibili_relation_stat',
      http_status: response.status,
      code: typeof json?.code === 'number' ? json.code : null,
      elapsed_ms: Date.now() - started,
    };
    if (!response.ok || !json || json.code !== 0) {
      throw new PublicRelationError(
        `relation stat: ${json?.message || json?.msg || `HTTP ${response.status}`}`,
        {
          ...diagnostic,
          body_hint: json ? undefined : body.slice(0, 160),
        },
      );
    }

    return {
      following: finiteNumber(json?.data?.following),
      followers: finiteNumber(json?.data?.follower),
      diagnostic,
    };
  } catch (error) {
    if (error instanceof PublicRelationError) throw error;
    throw new PublicRelationError(
      `relation stat: ${error?.name === 'AbortError' ? '请求超时' : error?.message || '网络失败'}`,
      {
        source: 'bilibili_relation_stat',
        http_status: 0,
        code: null,
        elapsed_ms: Date.now() - started,
        error: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage({ mid, kind, page, pageSize, timeoutMs, userAgent }) {
  const endpoint =
    kind === 'following'
      ? '/game/center/h5/user/relationship/following_list'
      : '/game/center/h5/user/relationship/follower_list';
  const url = new URL(endpoint, API_ROOT);
  url.searchParams.set('vmid', String(mid));
  url.searchParams.set('pn', String(page));
  url.searchParams.set('ps', String(pageSize));

  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        Origin: 'https://game.bilibili.com',
        Referer: 'https://game.bilibili.com/',
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}

    const diagnostic = {
      source: 'biligame_public_relation',
      page,
      page_size: pageSize,
      http_status: response.status,
      code: typeof json?.code === 'number' ? json.code : null,
      elapsed_ms: Date.now() - started,
    };

    if (!response.ok || !json || json.code !== 0) {
      throw new PublicRelationError(
        `${kind}: ${json?.message || json?.msg || `HTTP ${response.status}`}`,
        {
          ...diagnostic,
          body_hint: json ? undefined : body.slice(0, 160),
        },
      );
    }

    const rawList = json?.data?.list;
    const total = finiteNumber(
      json?.data?.total ?? json?.data?.count ?? json?.data?.page?.count,
    );
    return {
      items: Array.isArray(rawList) ? rawList.map(normalizeRelation) : [],
      privacyRestricted: rawList === null,
      total,
      diagnostic,
    };
  } catch (error) {
    if (error instanceof PublicRelationError) throw error;
    throw new PublicRelationError(
      `${kind}: ${error?.name === 'AbortError' ? '请求超时' : error?.message || '网络失败'}`,
      {
        source: 'biligame_public_relation',
        page,
        page_size: pageSize,
        http_status: 0,
        code: null,
        elapsed_ms: Date.now() - started,
        error: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPublicRelations({
  mid,
  kind,
  page = 1,
  pageSize = 20,
  complete = false,
  maxPages = 5,
  knownTotal = null,
  timeoutMs = 10_000,
  userAgent = process.env.BILI_USER_AGENT || DEFAULT_UA,
} = {}) {
  if (!/^\d{1,20}$/u.test(String(mid || '')) || String(mid) === '0') {
    throw new PublicRelationError('公开关系列表缺少有效 mid');
  }
  if (!['following', 'followers'].includes(kind)) {
    throw new PublicRelationError(`未知关系列表类型: ${kind || 'empty'}`);
  }

  const firstPage = clamp(page, 1, 10_000);
  const requestedSize = clamp(pageSize, 1, 20);
  const pagesAllowed = complete ? clamp(maxPages, 1, MAX_RELATION_PAGES) : 1;
  const publicCap = kind === 'followers' ? FOLLOWER_PUBLIC_CAP : null;
  const firstOffset = (firstPage - 1) * requestedSize;
  let resolvedTotal = finiteNumber(knownTotal);
  const diagnostics = {
    source: 'biligame_public_relation',
    public_cap: publicCap,
    total_source: resolvedTotal === null ? null : 'caller',
    relation_stat: null,
    relation_stat_error: null,
    requests: [],
  };

  if (resolvedTotal === null) {
    try {
      const stat = await fetchRelationStat({
        mid,
        timeoutMs: clamp(timeoutMs, 3_000, 30_000),
        userAgent,
      });
      diagnostics.relation_stat = stat.diagnostic;
      resolvedTotal = kind === 'following' ? stat.following : stat.followers;
      if (resolvedTotal !== null) diagnostics.total_source = 'relation_stat';
    } catch (error) {
      diagnostics.relation_stat_error = error?.diagnostics || {
        message: error?.message || String(error),
      };
    }
  }

  if (publicCap !== null && firstOffset >= publicCap) {
    const beyondKnownTotal =
      resolvedTotal !== null && firstOffset >= resolvedTotal;
    const capped =
      !beyondKnownTotal &&
      (resolvedTotal === null || resolvedTotal > publicCap);
    return {
      data: {
        items: [],
        page: firstPage,
        page_size: requestedSize,
        total: resolvedTotal,
        accessible_total: Math.min(publicCap, resolvedTotal ?? publicCap),
        public_cap: publicCap,
        has_more: false,
        next_page: null,
        pages_fetched: 0,
        privacy_restricted: false,
        public_list_unavailable: false,
        capped,
        completeness: capped ? 'public_cap_reached' : 'complete',
      },
      diagnostics,
    };
  }

  const items = [];
  let currentPage = firstPage;
  let lastPageFetched = null;
  let privacyRestricted = false;
  let upstreamHasMore = true;
  let rawItemsConsumed = 0;

  for (let index = 0; index < pagesAllowed; index += 1) {
    const pageOffset = (currentPage - 1) * requestedSize;
    const remaining =
      publicCap === null ? Number.POSITIVE_INFINITY : publicCap - pageOffset;
    if (remaining <= 0) break;

    const result = await fetchPage({
      mid,
      kind,
      page: currentPage,
      pageSize: requestedSize,
      timeoutMs: clamp(timeoutMs, 3_000, 30_000),
      userAgent,
    });
    diagnostics.requests.push(result.diagnostic);
    lastPageFetched = currentPage;
    if (resolvedTotal === null && result.total !== null) {
      resolvedTotal = result.total;
      diagnostics.total_source = 'biligame_response';
    }

    if (result.privacyRestricted) {
      privacyRestricted = true;
      upstreamHasMore = false;
      break;
    }

    const emptyFirstPage = currentPage === 1 && result.items.length === 0;
    if (emptyFirstPage && resolvedTotal !== null && resolvedTotal > 0) {
      if (kind === 'following') {
        privacyRestricted = true;
        upstreamHasMore = false;
        break;
      }
      throw new PublicRelationError(
        `followers: 公开粉丝名单接口返回空列表，但公开计数为 ${resolvedTotal}`,
        {
          source: 'biligame_public_relation',
          reason: 'empty_nonzero_follower_list',
          known_total: resolvedTotal,
          total_source: diagnostics.total_source,
          relation_stat: diagnostics.relation_stat,
          requests: diagnostics.requests,
        },
      );
    }
    if (emptyFirstPage && resolvedTotal === null) {
      throw new PublicRelationError(
        `${kind}: 空列表无法确认是零条、隐私设置还是上游失效`,
        {
          source: 'biligame_public_relation',
          reason: 'indeterminate_empty_list',
          total_source: diagnostics.total_source,
          relation_stat_error: diagnostics.relation_stat_error,
          requests: diagnostics.requests,
        },
      );
    }

    const accepted = result.items.slice(0, remaining);
    items.push(...accepted);
    rawItemsConsumed += accepted.length;

    const pageWasFull = result.items.length >= requestedSize;
    const totalRemaining =
      resolvedTotal === null
        ? null
        : pageOffset + result.items.length < resolvedTotal;
    upstreamHasMore =
      totalRemaining === null ? pageWasFull : totalRemaining && pageWasFull;

    if (!upstreamHasMore || accepted.length < result.items.length) break;
    if (publicCap !== null && pageOffset + accepted.length >= publicCap) break;
    currentPage += 1;
  }

  const uniqueItems = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.mid || `${item.name || ''}:${item.face || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  const endOffset = firstOffset + rawItemsConsumed;
  const knownRemaining =
    resolvedTotal === null ? null : endOffset < resolvedTotal;
  const capped =
    publicCap !== null &&
    endOffset >= publicCap &&
    (resolvedTotal === null || resolvedTotal > publicCap);
  const pageBudgetExhausted =
    complete && diagnostics.requests.length >= pagesAllowed && upstreamHasMore && !capped;
  const upstreamLimited =
    !privacyRestricted &&
    !capped &&
    resolvedTotal !== null &&
    endOffset < resolvedTotal &&
    !upstreamHasMore;
  const hasMore =
    !privacyRestricted &&
    !capped &&
    (knownRemaining === null
      ? upstreamHasMore
      : knownRemaining && upstreamHasMore);

  let completeness = 'public_page';
  if (privacyRestricted) completeness = 'privacy_restricted';
  else if (capped) completeness = 'public_cap_reached';
  else if (pageBudgetExhausted) completeness = 'page_budget_reached';
  else if (upstreamLimited) completeness = 'upstream_limit_reached';
  else if (
    !hasMore &&
    resolvedTotal !== null &&
    endOffset >= resolvedTotal
  ) {
    completeness = 'complete';
  } else if (!hasMore && !upstreamHasMore) {
    completeness = 'upstream_exhausted';
  }

  return {
    data: {
      items: uniqueItems,
      page: firstPage,
      page_size: requestedSize,
      total: resolvedTotal,
      accessible_total:
        privacyRestricted
          ? 0
          : upstreamLimited
            ? endOffset
            : resolvedTotal !== null
              ? publicCap === null
                ? resolvedTotal
                : Math.min(publicCap, resolvedTotal)
              : hasMore
                ? null
                : publicCap === null
                  ? endOffset
                  : Math.min(publicCap, endOffset),
      public_cap: publicCap,
      has_more: hasMore,
      next_page: hasMore && lastPageFetched !== null ? lastPageFetched + 1 : null,
      pages_fetched: diagnostics.requests.length,
      privacy_restricted: privacyRestricted,
      public_list_unavailable: false,
      capped,
      completeness,
    },
    diagnostics,
  };
}

export const _test = {
  httpsUrl,
  normalizeRelation,
  finiteNumber,
  FOLLOWER_PUBLIC_CAP,
  MAX_RELATION_PAGES,
};
