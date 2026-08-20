import { createHash } from 'node:crypto';

const APP_KEY = '1d8b6e7d45233436';
const APP_SECRET = '560c52ccd288fed045859ed18bffd973';
const APP_UA =
  'Mozilla/5.0 BiliDroid/8.11.0 (bbcallen@gmail.com) os/android model/SM-S9180 mobi_app/android_hd build/2001100 channel/master innerVer/2001100 osVer/13 network/2';
const APP_PAGE_SIZE = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toIso = (timestamp) =>
  Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000).toISOString() : null;
const httpsImage = (value) => {
  const url = String(value || '');
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
};

export class AppVideoError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'AppVideoError';
    this.diagnostics = diagnostics;
  }
}

function signedUrl(params) {
  const values = {
    build: '2001100',
    version: '2.0.1',
    mobi_app: 'android_hd',
    platform: 'android',
    channel: 'master',
    device: 'pad',
    fnval: '976',
    fnver: '0',
    fourk: '1',
    ts: Math.floor(Date.now() / 1000),
    ...params,
    appkey: APP_KEY,
  };
  const sorted = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(
    sorted.map(([key, value]) => [key, String(value)]),
  ).toString();
  const sign = createHash('md5').update(query + APP_SECRET).digest('hex');
  return `https://app.bilibili.com/x/v2/space/archive/cursor?${query}&sign=${sign}`;
}

function rawAid(item) {
  const value = item?.aid ?? item?.id ?? item?.param ?? null;
  return value === null || value === undefined || value === '' ? null : String(value);
}

async function fetchPage({ mid, cursorAid, pageIndex, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(
      signedUrl({
        vmid: mid,
        ps: APP_PAGE_SIZE,
        aid: cursorAid || undefined,
        order: 'pubdate',
        sort: 'desc',
      }),
      {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent': APP_UA,
        },
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppVideoError(`APP 投稿接口第 ${pageIndex} 批返回非 JSON`, {
        page_index: pageIndex,
        cursor_in: cursorAid || null,
        http_status: response.status,
        body_hint: text.slice(0, 160),
        elapsed_ms: Date.now() - started,
      });
    }
    if (!response.ok || body?.code !== 0) {
      throw new AppVideoError(
        `APP 投稿接口第 ${pageIndex} 批失败：${body?.message || `HTTP ${response.status}`}`,
        {
          page_index: pageIndex,
          cursor_in: cursorAid || null,
          http_status: response.status,
          code: body?.code ?? null,
          message: body?.message || '',
          elapsed_ms: Date.now() - started,
        },
      );
    }
    const data = body.data || {};
    const items = Array.isArray(data.item)
      ? data.item
      : Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.archives)
          ? data.archives
          : [];
    const nextAid = rawAid(items.at(-1));
    const total = Number(
      data?.page?.count ?? data?.page?.total ?? data?.total ?? data?.count ?? 0,
    );
    return {
      items,
      total,
      nextAid,
      explicitlyEnded:
        data?.cursor?.is_end === true ||
        data?.is_end === true ||
        data?.has_more === false ||
        data?.has_more === 0 ||
        items.length === 0,
      meta: {
        page_index: pageIndex,
        cursor_in: cursorAid || null,
        cursor_out: nextAid,
        http_status: response.status,
        code: body.code,
        count: items.length,
        total: total || null,
        elapsed_ms: Date.now() - started,
      },
    };
  } catch (error) {
    if (error instanceof AppVideoError) throw error;
    throw new AppVideoError(
      `APP 投稿接口第 ${pageIndex} 批${error?.name === 'AbortError' ? '超时' : '网络失败'}`,
      {
        page_index: pageIndex,
        cursor_in: cursorAid || null,
        elapsed_ms: Date.now() - started,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function normalize(item) {
  const stat = item?.stat || item?.stats || {};
  const aidValue = rawAid(item);
  const aid = aidValue === null ? null : Number(aidValue) || aidValue;
  const bvid = item?.bvid || item?.bv_id || null;
  const created =
    item?.created ?? item?.pubdate ?? item?.ctime ?? item?.publish_time ?? null;
  return {
    aid,
    bvid,
    title: String(item?.title || item?.name || ''),
    description: String(item?.description ?? item?.desc ?? ''),
    cover: httpsImage(item?.cover || item?.pic),
    duration: item?.duration ?? item?.length ?? null,
    created,
    created_at: toIso(created),
    play: item?.play ?? stat?.view ?? null,
    danmaku: item?.danmaku ?? item?.video_review ?? stat?.danmaku ?? null,
    comment: item?.comment ?? stat?.reply ?? null,
    favorite: item?.favorite ?? item?.favorites ?? stat?.favorite ?? null,
    coin: item?.coin ?? stat?.coin ?? null,
    share: item?.share ?? stat?.share ?? null,
    like: item?.like ?? stat?.like ?? null,
    author: item?.author || item?.owner?.name || null,
    author_mid: item?.mid ?? item?.owner?.mid ?? null,
    source: 'app_archive_cursor',
    url: bvid
      ? `https://www.bilibili.com/video/${bvid}`
      : aid
        ? `https://www.bilibili.com/video/av${aid}`
        : null,
  };
}

function keyOf(item) {
  return item.bvid || (item.aid ? `av${item.aid}` : `${item.title}:${item.created}`);
}

export async function fetchVideosWithApp({
  mid,
  page = 1,
  pageSize = 30,
  complete = false,
  maxPages = 5,
  keyword = '',
  timeoutMs = 12_000,
} = {}) {
  if (!/^\d+$/.test(String(mid || ''))) {
    throw new AppVideoError('APP 投稿回退缺少有效 mid');
  }

  const requestedCount = pageSize * (complete ? maxPages : 1);
  const skip = Math.max(0, (page - 1) * pageSize);
  const neededFromStart = skip + requestedCount;
  const maxApiPages = Math.min(100, Math.max(1, Math.ceil(neededFromStart / APP_PAGE_SIZE) + 1));
  const diagnostics = {
    strategy: 'app_archive_cursor',
    pagination: 'aid_cursor',
    pages: [],
  };
  const collected = [];
  const seen = new Set();
  let total = 0;
  let cursorAid = null;
  let ended = false;

  for (let pageIndex = 1; pageIndex <= maxApiPages; pageIndex += 1) {
    const result = await fetchPage({ mid, cursorAid, pageIndex, timeoutMs });
    diagnostics.pages.push(result.meta);
    total = Math.max(total, result.total || 0);

    let newItems = 0;
    for (const raw of result.items) {
      const item = normalize(raw);
      const key = keyOf(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      newItems += 1;
    }

    const reachedTotal = total > 0 && collected.length >= total;
    const cursorRepeated = Boolean(cursorAid && result.nextAid === cursorAid);
    const noCursor = result.items.length > 0 && !result.nextAid;
    ended =
      result.explicitlyEnded ||
      result.items.length < APP_PAGE_SIZE ||
      reachedTotal ||
      cursorRepeated ||
      noCursor ||
      newItems === 0;

    if (ended || collected.length >= neededFromStart) break;
    cursorAid = result.nextAid;
    if (pageIndex < maxApiPages) await sleep(150);
  }

  let items = collected.slice(skip, skip + requestedCount);
  if (keyword) {
    const needle = String(keyword).toLowerCase();
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle),
    );
  }

  if (!items.length && !ended && skip < (total || Number.POSITIVE_INFINITY)) {
    throw new AppVideoError('APP 投稿接口没有返回请求范围内的稿件', diagnostics);
  }

  const consumed = skip + items.length;
  const hasMore = total > 0 ? consumed < total : !ended;
  diagnostics.unique_items_fetched = collected.length;
  diagnostics.ended = ended;

  return {
    data: {
      items,
      page,
      page_size: pageSize,
      total: total || null,
      has_more: hasMore,
      next_page: hasMore ? page + (complete ? maxPages : 1) : null,
      pages_fetched: diagnostics.pages.length,
      source: 'app_archive_cursor',
      completeness:
        total > 0 && collected.length >= Math.min(total, neededFromStart)
          ? 'authoritative_page'
          : 'best_effort_page',
    },
    diagnostics,
  };
}
