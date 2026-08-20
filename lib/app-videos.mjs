import { createHash } from 'node:crypto';

const APP_KEY = '1d8b6e7d45233436';
const APP_SECRET = '560c52ccd288fed045859ed18bffd973';
const APP_UA =
  'Mozilla/5.0 BiliDroid/8.11.0 (bbcallen@gmail.com) os/android model/SM-S9180 mobi_app/android_hd build/2001100 channel/master innerVer/2001100 osVer/13 network/2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toIso = (timestamp) =>
  Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000).toISOString() : null;

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
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(
    sorted.map(([key, value]) => [key, String(value)]),
  ).toString();
  const sign = createHash('md5').update(query + APP_SECRET).digest('hex');
  return `https://app.bilibili.com/x/v2/space/archive/cursor?${query}&sign=${sign}`;
}

async function fetchPage({ mid, page, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(
      signedUrl({
        vmid: mid,
        ps: 20,
        pn: page,
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
      throw new AppVideoError(`APP 投稿接口第 ${page} 页返回非 JSON`, {
        page,
        http_status: response.status,
        body_hint: text.slice(0, 160),
        elapsed_ms: Date.now() - started,
      });
    }
    if (!response.ok || body?.code !== 0) {
      throw new AppVideoError(
        `APP 投稿接口第 ${page} 页失败：${body?.message || `HTTP ${response.status}`}`,
        {
          page,
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
    return {
      items,
      total: Number(
        data?.page?.count ?? data?.page?.total ?? data?.total ?? data?.count ?? 0,
      ),
      ended:
        data?.cursor?.is_end === true ||
        data?.is_end === true ||
        data?.has_more === false ||
        data?.has_more === 0 ||
        items.length === 0,
      meta: {
        page,
        http_status: response.status,
        code: body.code,
        count: items.length,
        elapsed_ms: Date.now() - started,
      },
    };
  } catch (error) {
    if (error instanceof AppVideoError) throw error;
    throw new AppVideoError(
      `APP 投稿接口第 ${page} 页${error?.name === 'AbortError' ? '超时' : '网络失败'}`,
      { page, elapsed_ms: Date.now() - started },
    );
  } finally {
    clearTimeout(timer);
  }
}

function normalize(item) {
  const stat = item?.stat || item?.stats || {};
  const aid = item?.aid ?? item?.id ?? item?.param ?? null;
  const bvid = item?.bvid || item?.bv_id || null;
  const created =
    item?.created ?? item?.pubdate ?? item?.ctime ?? item?.publish_time ?? null;
  const cover = item?.cover || item?.pic || '';
  return {
    aid: aid !== null && aid !== '' ? Number(aid) || aid : null,
    bvid,
    title: String(item?.title || item?.name || ''),
    description: String(item?.description ?? item?.desc ?? ''),
    cover: cover.startsWith?.('//') ? `https:${cover}` : cover,
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

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.bvid || (item.aid ? `av${item.aid}` : `${item.title}:${item.created}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const firstPage = Math.floor(skip / 20) + 1;
  const firstOffset = skip % 20;
  const pagesNeeded = Math.min(
    50,
    Math.max(1, Math.ceil((firstOffset + requestedCount) / 20)),
  );
  const diagnostics = { strategy: 'app_archive_cursor', pages: [] };
  const collected = [];
  let total = 0;
  let ended = false;

  for (let index = 0; index < pagesNeeded; index += 1) {
    const result = await fetchPage({
      mid,
      page: firstPage + index,
      timeoutMs,
    });
    diagnostics.pages.push(result.meta);
    collected.push(...result.items.map(normalize));
    total = Math.max(total, result.total || 0);
    if (result.ended) {
      ended = true;
      break;
    }
    if (index + 1 < pagesNeeded) await sleep(150);
  }

  let items = unique(collected).slice(firstOffset, firstOffset + requestedCount);
  if (keyword) {
    const needle = String(keyword).toLowerCase();
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle),
    );
  }
  if (!items.length && !ended) {
    throw new AppVideoError('APP 投稿接口没有返回可用稿件', diagnostics);
  }
  const consumed = skip + items.length;
  const hasMore = total > 0 ? consumed < total : !ended;
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
      completeness: total > 0 ? 'authoritative_page' : 'best_effort_page',
    },
    diagnostics,
  };
}
