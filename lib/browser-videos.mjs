import { createHash } from 'node:crypto';

const API_PATH = '/x/space/wbi/arc/search';
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const DEFAULT_TIMEOUT_MS = 42_000;
const NORMAL_UA =
  process.env.BILI_BROWSER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export class BrowserVideoError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'BrowserVideoError';
    this.diagnostics = diagnostics;
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const image = (url) =>
  typeof url === 'string' && url.startsWith('//') ? `https:${url}` : url || '';
const iso = (timestamp) =>
  Number(timestamp) > 0
    ? new Date(Number(timestamp) * 1000).toISOString()
    : null;

export function parseCookieHeader(cookieHeader) {
  const cookies = [];
  for (const part of String(cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || !value) continue;
    cookies.push({
      name,
      value,
      domain: '.bilibili.com',
      path: '/',
      secure: true,
    });
  }
  return cookies;
}

export function signWbiParams(params, imgKey, subKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const rawKey = `${imgKey || ''}${subKey || ''}`;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((index) => rawKey[index] || '')
    .join('')
    .slice(0, 32);
  if (!mixinKey) throw new BrowserVideoError('浏览器会话没有拿到 WBI key');

  const values = { ...params, wts: nowSeconds };
  delete values.w_rid;
  const query = Object.keys(values)
    .sort()
    .map((key) => {
      const clean = String(values[key] ?? '').replace(/[!'()*]/gu, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(clean)}`;
    })
    .join('&');
  const digest = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${digest}`;
}

export function normalizeVideo(item) {
  const bvid = item?.bvid || null;
  const aid = item?.aid ?? item?.id ?? null;
  const created = item?.created ?? item?.pubdate ?? item?.ctime ?? null;
  return {
    aid,
    bvid,
    title: item?.title || '',
    description: item?.description ?? item?.desc ?? '',
    cover: image(item?.pic || item?.cover),
    duration: item?.length ?? item?.duration ?? null,
    created,
    created_at: iso(created),
    play: item?.play ?? item?.stat?.view ?? null,
    danmaku: item?.video_review ?? item?.stat?.danmaku ?? null,
    comment: item?.comment ?? item?.stat?.reply ?? null,
    favorite: item?.stat?.favorite ?? null,
    coin: item?.stat?.coin ?? null,
    share: item?.stat?.share ?? null,
    like: item?.stat?.like ?? null,
    url: bvid
      ? `https://www.bilibili.com/video/${bvid}`
      : aid
        ? `https://www.bilibili.com/video/av${aid}`
        : null,
  };
}

export function normalizeVideoPage(data, page, pageSize) {
  const raw = data?.list?.vlist || data?.archives || data?.list || [];
  const items = Array.isArray(raw) ? raw.map(normalizeVideo) : [];
  const total = Number(
    data?.page?.count ?? data?.page?.total ?? data?.total ?? data?.count ?? items.length,
  );
  const hasMore = page * pageSize < total;
  return {
    items,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    next_page: hasMore ? page + 1 : null,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiResult(payload, httpStatus, elapsedMs, label) {
  const code = typeof payload?.code === 'number' ? payload.code : null;
  if (!payload || httpStatus < 200 || httpStatus >= 300 || code !== 0) {
    const message = payload?.message || payload?.msg || `HTTP ${httpStatus}`;
    throw new BrowserVideoError(`${label}: ${message}`, {
      stage: label,
      http_status: httpStatus,
      code,
      elapsed_ms: elapsedMs,
    });
  }
  return payload.data || {};
}

function requestMatches(response, mid) {
  try {
    const url = new URL(response.url());
    return (
      url.pathname === API_PATH &&
      url.searchParams.get('mid') === String(mid) &&
      response.request().method() === 'GET'
    );
  } catch {
    return false;
  }
}

async function waitForInitialVideoRequest(page, mid, timeoutMs) {
  const routes = [
    `https://space.bilibili.com/${mid}/video`,
    `https://space.bilibili.com/${mid}/upload/video`,
  ];
  let lastError = null;
  let lastUpstreamFailure = null;

  for (const route of routes) {
    let acceptedPayload = null;
    const responsePromise = page.waitForResponse(
      async (response) => {
        if (!requestMatches(response, mid)) return false;
        try {
          const payload = safeJson(await response.text());
          if (response.status() >= 200 && response.status() < 300 && payload?.code === 0) {
            acceptedPayload = payload;
            return true;
          }
          lastUpstreamFailure = {
            http_status: response.status(),
            code: payload?.code ?? null,
            message: payload?.message || payload?.msg || '',
          };
        } catch (error) {
          lastError = error;
        }
        return false;
      },
      { timeout: timeoutMs },
    );
    try {
      await page.goto(route, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    } catch (error) {
      lastError = error;
    }

    try {
      const response = await responsePromise;
      const data = apiResult(
        acceptedPayload,
        response.status(),
        0,
        'browser.initial',
      );
      return {
        data,
        requestUrl: response.request().url(),
        httpStatus: response.status(),
        route,
      };
    } catch (error) {
      lastError = error;
    }
  }

  let pageHint = '';
  try {
    pageHint = await page.evaluate(() =>
      String(document.body?.innerText || '')
        .replace(/\s+/gu, ' ')
        .slice(0, 180),
    );
  } catch {}

  throw new BrowserVideoError(
    `浏览器没有收到投稿列表接口${lastError?.message ? `：${lastError.message}` : ''}`,
    {
      stage: 'browser.navigation',
      page_url: page.url(),
      page_hint: pageHint,
      last_upstream_failure: lastUpstreamFailure,
    },
  );
}

async function readWbiKeysInPage(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    return {
      status: response.status,
      text: await response.text(),
    };
  });
  const payload = safeJson(result.text);
  const wbi = payload?.data?.wbi_img;
  const imgKey = String(wbi?.img_url || '').split('/').pop()?.split('.')[0] || '';
  const subKey = String(wbi?.sub_url || '').split('/').pop()?.split('.')[0] || '';
  if (payload?.code !== 0 || !imgKey || !subKey) {
    throw new BrowserVideoError('浏览器会话无法读取 WBI key', {
      stage: 'browser.nav',
      http_status: result.status,
      code: payload?.code ?? null,
    });
  }
  return { imgKey, subKey };
}

async function fetchSignedPageInBrowser(page, requestUrl, pageNumber, pageSize, options) {
  const template = new URL(requestUrl);
  const params = Object.fromEntries(template.searchParams.entries());
  delete params.w_rid;
  delete params.wts;
  params.mid = String(options.mid);
  params.pn = String(pageNumber);
  params.ps = String(pageSize);
  params.tid = String(options.tid || 0);
  params.keyword = options.keyword || '';
  params.order = options.order || 'pubdate';
  params.platform = params.platform || 'web';
  params.web_location = params.web_location || '1550101';
  params.order_avoided = params.order_avoided || 'true';

  const signed = signWbiParams(params, options.imgKey, options.subKey);
  const target = new URL(API_PATH, 'https://api.bilibili.com');
  target.search = signed;
  const started = Date.now();
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    return { status: response.status, text: await response.text() };
  }, target.toString());
  const payload = safeJson(result.text);
  return apiResult(
    payload,
    result.status,
    Date.now() - started,
    `browser.page.${pageNumber}`,
  );
}

async function launchBrowser() {
  const [puppeteerModule, chromiumModule] = await Promise.all([
    import('puppeteer-core'),
    import('@sparticuz/chromium'),
  ]);
  const puppeteer = puppeteerModule.default || puppeteerModule;
  const chromium = chromiumModule.default || chromiumModule;
  chromium.setGraphicsMode = false;

  const executablePath = process.env.CHROME_EXECUTABLE_PATH
    ? process.env.CHROME_EXECUTABLE_PATH
    : await chromium.executablePath();
  const args = puppeteer.defaultArgs({
    args: chromium.args,
    headless: 'shell',
  });

  return puppeteer.launch({
    args,
    defaultViewport: {
      deviceScaleFactor: 1,
      hasTouch: false,
      height: 900,
      isLandscape: true,
      isMobile: false,
      width: 1440,
    },
    executablePath,
    headless: 'shell',
    timeout: 25_000,
  });
}

/**
 * Fetches public video pages through the same browser flow used by Bilibili's
 * public space page. It does not solve CAPTCHAs or access private data.
 */
export async function fetchVideosWithBrowser(options) {
  const mid = String(options?.mid || '');
  if (!/^\d{1,20}$/u.test(mid)) {
    throw new BrowserVideoError('浏览器兜底收到无效 UID');
  }

  const pageNumber = clamp(Number(options.page) || 1, 1, 10_000);
  const pageSize = clamp(Number(options.pageSize) || 30, 1, 50);
  const complete = Boolean(options.complete);
  const maxPages = clamp(Number(options.maxPages) || 1, 1, 10);
  const timeoutMs = clamp(
    Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
    15_000,
    55_000,
  );
  const browser = await launchBrowser();
  const diagnostics = {
    engine: 'chromium',
    requested_page: pageNumber,
    requested_pages: complete ? maxPages : 1,
  };

  try {
    const page = await browser.newPage();
    await page.setUserAgent(NORMAL_UA);
    await page.setExtraHTTPHeaders({
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
    });
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);

    const cookies = parseCookieHeader(options.cookie || '');
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      diagnostics.configured_cookie_fields = cookies.map((cookie) => cookie.name);
    } else {
      diagnostics.configured_cookie_fields = [];
    }

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      if (type === 'media' || type === 'websocket' || type === 'eventsource') {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    const initial = await waitForInitialVideoRequest(page, mid, timeoutMs);
    const initialUrl = new URL(initial.requestUrl);
    const initialPage = Number(initialUrl.searchParams.get('pn') || 1);
    diagnostics.initial_route = initial.route.replace(mid, ':mid');
    diagnostics.initial_page = initialPage;
    diagnostics.initial_http_status = initial.httpStatus;

    const { imgKey, subKey } = await readWbiKeysInPage(page);
    const pages = [];
    const pageCount = complete ? maxPages : 1;
    let currentPage = pageNumber;

    for (let index = 0; index < pageCount; index += 1) {
      const data =
        currentPage === initialPage
          ? initial.data
          : await fetchSignedPageInBrowser(
              page,
              initial.requestUrl,
              currentPage,
              pageSize,
              {
                mid,
                tid: options.tid,
                keyword: options.keyword,
                order: options.order,
                imgKey,
                subKey,
              },
            );
      const normalized = normalizeVideoPage(data, currentPage, pageSize);
      pages.push(normalized);
      if (!normalized.has_more) break;
      currentPage = normalized.next_page;
    }

    const last = pages.at(-1) || normalizeVideoPage({}, pageNumber, pageSize);
    const merged = {
      ...last,
      items: pages.flatMap((entry) => entry.items || []),
      pages_fetched: pages.length,
      source: 'browser',
    };
    diagnostics.pages_fetched = pages.length;
    diagnostics.items_fetched = merged.items.length;
    return { data: merged, diagnostics };
  } catch (error) {
    if (error instanceof BrowserVideoError) throw error;
    throw new BrowserVideoError(`浏览器兜底失败：${error?.message || String(error)}`, {
      ...diagnostics,
      stage: 'browser.runtime',
      error_name: error?.name || 'Error',
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
