import { createHash, randomUUID } from 'node:crypto';

export const config = { maxDuration: 60 };

const VERSION = '2.0.0';
const DEFAULT_MID = '3546779356235807';
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const UA = process.env.BILI_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const DEFAULT_SECTIONS = ['profile','videos','dynamics','articles','audio','collections','favorites'];
const SECTIONS = new Set([...DEFAULT_SECTIONS,'series_items','season_items','favorite_items','following','followers']);

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const int = (v, fallback, min, max) => {
  const n = Number.parseInt(String(Array.isArray(v) ? v[0] : v ?? ''), 10);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};
const bool = (v) => ['1','true','yes','on'].includes(String(Array.isArray(v) ? v[0] : v ?? '').toLowerCase());
const text = (v, fallback = '') => String(Array.isArray(v) ? v[0] : v ?? fallback);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ts) => Number(ts) > 0 ? new Date(Number(ts) * 1000).toISOString() : null;
const image = (url) => typeof url === 'string' && url.startsWith('//') ? 'https:' + url : url || '';

class HttpError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}

class Jar {
  constructor(cookie = '') { this.map = new Map(); this.mergeCookie(cookie); }
  mergeCookie(value) {
    for (const part of String(value || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  mergeSetCookie(value) {
    const first = String(value || '').split(';', 1)[0];
    const i = first.indexOf('=');
    if (i > 0) this.map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  mergeHeaders(headers) {
    if (typeof headers?.getSetCookie === 'function') {
      for (const value of headers.getSetCookie()) this.mergeSetCookie(value);
    } else {
      for (const value of String(headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,\s]+=)/g)) this.mergeSetCookie(value);
    }
  }
  set(k, v) { if (k && v) this.map.set(String(k), String(v)); }
  has(k) { return this.map.has(k); }
  value() { return [...this.map].map(([k,v]) => k + '=' + v).join('; '); }
  summary() { return Object.fromEntries(['SESSDATA','bili_jct','buvid3','buvid4','_uuid'].map((k) => [k, this.has(k)])); }
}

function parseRenderData(html) {
  const match = String(html || '').match(/<script[^>]*id=["']__RENDER_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  for (const candidate of [(() => { try { return decodeURIComponent(match[1]); } catch { return ''; } })(), match[1]]) {
    try { if (candidate) return JSON.parse(candidate); } catch {}
  }
  return null;
}

function sign(params, imgKey, subKey) {
  const raw = String(imgKey || '') + String(subKey || '');
  const key = MIXIN.map((i) => raw[i] || '').join('').slice(0, 32);
  if (!key) throw new HttpError('WBI key unavailable');
  const values = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(values).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(values[k] ?? '').replace(/[!'()*]/g, ''))).join('&');
  return query + '&w_rid=' + createHash('md5').update(query + key).digest('hex');
}

function dmFields() {
  const width = 1242 + Math.floor(Math.random() * 7);
  const height = 1282 + Math.floor(Math.random() * 7);
  const b64 = Buffer.from('no webgl').toString('base64').replace(/=+$/u, '');
  return {
    dm_img_list: JSON.stringify([{ x: 3 * width + 2 * height, y: 4 * width - 5 * height, z: 0, timestamp: 25 + Math.floor(Math.random() * 11), type: 0 }]),
    dm_img_str: b64,
    dm_cover_img_str: b64,
    dm_img_inter: JSON.stringify({ ds: [], wh: [0,0,0], of: [0,0,0] }),
  };
}

class Bili {
  constructor() {
    this.jar = new Jar(process.env.BI_COOKIE || '');
    this.timeout = int(process.env.BILI_TIMEOUT_MS, 7000, 2000, 20000);
    this.mid = '';
    this.imgKey = '';
    this.subKey = '';
    this.accessId = '';
    this.diag = {};
  }
  headers(referer, origin, accept = 'application/json, text/plain, */*') {
    const h = { Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7', 'User-Agent': UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
    if (referer) h.Referer = referer;
    if (origin) h.Origin = origin;
    if (this.jar.value()) h.Cookie = this.jar.value();
    return h;
  }
  async raw(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || this.timeout);
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: this.headers(options.referer, options.origin, options.accept), redirect: 'follow', signal: controller.signal });
      this.jar.mergeHeaders(response.headers);
      const body = await response.text();
      let json = null;
      try { json = JSON.parse(body); } catch {}
      return { ok: response.ok, status: response.status, json, body, elapsed: Date.now() - started };
    } catch (error) {
      return { ok: false, status: 0, json: null, body: '', elapsed: Date.now() - started, message: error?.name === 'AbortError' ? 'Request timeout' : error?.message || 'Network error' };
    } finally { clearTimeout(timer); }
  }
  async json(url, label, options = {}) {
    const result = await this.raw(url, options);
    const code = typeof result.json?.code === 'number' ? result.json.code : null;
    if (!result.ok || !result.json || (code !== null && code !== 0)) {
      const message = result.json?.message || result.json?.msg || result.message || 'HTTP ' + result.status;
      throw new HttpError(label + ': ' + message, { http_status: result.status, code, message, elapsed_ms: result.elapsed });
    }
    return { data: result.json.data ?? result.json.result ?? result.json, meta: { http_status: result.status, code, elapsed_ms: result.elapsed } };
  }
  url(path, params = {}) {
    const url = path.startsWith('http') ? new URL(path) : new URL(path, 'https://api.bilibili.com');
    for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url;
  }
  plain(path, params, label, options = {}) { return this.json(this.url(path, params), label, options); }
  signed(path, params, label, options = {}) {
    if (!this.imgKey || !this.subKey) throw new HttpError(label + ': WBI bootstrap failed', { http_status: this.diag.nav?.http_status || 0, code: this.diag.nav?.code ?? null });
    const values = { ...params, ...dmFields() };
    if (this.accessId) values.w_webid = this.accessId;
    const url = this.url(path);
    url.search = sign(values, this.imgKey, this.subKey);
    return this.json(url, label, options);
  }
  async bootstrap(mid) {
    this.mid = String(mid);
    const referer = 'https://space.bilibili.com/' + mid + '/';
    const finger = await this.raw('https://api.bilibili.com/x/frontend/finger/spi', { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', timeout: 4000 });
    if (finger.json?.code === 0) { this.jar.set('buvid3', finger.json.data?.b_3); this.jar.set('buvid4', finger.json.data?.b_4); }
    if (!this.jar.has('_uuid')) this.jar.set('_uuid', randomUUID().toUpperCase() + 'infoc');
    this.diag.finger = { ok: finger.ok && finger.json?.code === 0, http_status: finger.status, code: finger.json?.code ?? null };

    const spacePromise = this.raw('https://space.bilibili.com/' + mid + '/dynamic', { referer: 'https://www.bilibili.com/', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', timeout: 6500 });
    const navPromise = this.raw('https://api.bilibili.com/x/web-interface/nav', { referer, origin: 'https://space.bilibili.com', timeout: 6000 });
    const [space, nav] = await Promise.all([spacePromise, navPromise]);
    const render = parseRenderData(space.body);
    this.accessId = render?.access_id ? String(render.access_id) : '';
    const wbi = nav.json?.data?.wbi_img;
    this.imgKey = String(wbi?.img_url || '').split('/').pop()?.split('.')[0] || '';
    this.subKey = String(wbi?.sub_url || '').split('/').pop()?.split('.')[0] || '';
    this.diag.space = { ok: space.ok, http_status: space.status, access_id_loaded: Boolean(this.accessId) };
    this.diag.nav = { ok: Boolean(this.imgKey && this.subKey), http_status: nav.status, code: nav.json?.code ?? null };
    return { bootstrap: this.diag, cookie_fields: this.jar.summary(), access_id_loaded: Boolean(this.accessId), wbi_keys_loaded: Boolean(this.imgKey && this.subKey) };
  }
}

function failure(error) {
  return { ok: false, error: { type: error instanceof HttpError ? 'upstream' : 'internal', message: error?.message || String(error), upstream: error?.details || null } };
}
function video(v) {
  const bvid = v?.bvid || null;
  const aid = v?.aid ?? v?.id ?? null;
  const created = v?.created ?? v?.pubdate ?? v?.ctime ?? null;
  return {
    aid, bvid, title: v?.title || '', description: v?.description ?? v?.desc ?? '', cover: image(v?.pic || v?.cover),
    duration: v?.length ?? v?.duration ?? null, created, created_at: iso(created), play: v?.play ?? v?.stat?.view ?? null,
    danmaku: v?.video_review ?? v?.stat?.danmaku ?? null, comment: v?.comment ?? v?.stat?.reply ?? null,
    favorite: v?.stat?.favorite ?? null, coin: v?.stat?.coin ?? null, share: v?.stat?.share ?? null, like: v?.stat?.like ?? null,
    url: bvid ? 'https://www.bilibili.com/video/' + bvid : aid ? 'https://www.bilibili.com/video/av' + aid : null,
  };
}
function videoPage(data, page, pageSize) {
  const raw = data?.list?.vlist || data?.archives || data?.list || [];
  const items = Array.isArray(raw) ? raw.map(video) : [];
  const total = Number(data?.page?.count ?? data?.page?.total ?? data?.total ?? data?.count ?? items.length);
  const more = page * pageSize < total;
  return { items, page, page_size: pageSize, total, has_more: more, next_page: more ? page + 1 : null };
}
function dynamicPage(data, currentOffset) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const next = data?.offset || null;
  return { items, offset: currentOffset || null, has_more: Boolean(data?.has_more && next), next_offset: data?.has_more ? next : null };
}
function listPage(data, page, pageSize) {
  const raw = data?.articles || data?.data || data?.list || data?.songs || data?.medias || data?.archives || data?.items || [];
  const items = Array.isArray(raw) ? raw : [];
  const total = Number(data?.totalSize ?? data?.total ?? data?.count ?? data?.page?.count ?? data?.info?.media_count ?? items.length);
  const more = Boolean(data?.has_more) || page * pageSize < total;
  return { items, page, page_size: pageSize, total, has_more: more, next_page: more ? page + 1 : null, info: data?.info || null };
}
async function settled(named) {
  const entries = Object.entries(named);
  const values = await Promise.allSettled(entries.map(([,p]) => p));
  return Object.fromEntries(values.map((result, i) => {
    const name = entries[i][0];
    return result.status === 'fulfilled' ? [name, { ok: true, ...result.value }] : [name, failure(result.reason)];
  }));
}

async function profile(client, mid) {
  const ref = 'https://space.bilibili.com/' + mid + '/';
  const source = await settled({
    info: client.signed('/x/space/wbi/acc/info', { mid, token: '', platform: 'web', web_location: 1550101 }, 'profile.info', { referer: ref, origin: 'https://space.bilibili.com' }),
    card: client.plain('/x/web-interface/card', { mid, photo: true }, 'profile.card', { referer: ref, origin: 'https://space.bilibili.com' }),
    relation: client.plain('/x/relation/stat', { vmid: mid }, 'profile.relation', { referer: ref }),
    upstat: client.plain('/x/space/upstat', { mid }, 'profile.upstat', { referer: ref }),
    navnum: client.plain('/x/space/navnum', { mid }, 'profile.navnum', { referer: ref }),
    top: client.plain('/x/space/top/arc', { vmid: mid }, 'profile.top', { referer: ref }),
    live: client.plain('https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids', { 'uids[]': mid }, 'profile.live', { referer: 'https://live.bilibili.com/', origin: 'https://live.bilibili.com' }),
  });
  if (!Object.values(source).some((x) => x.ok)) throw new HttpError('profile: all public profile endpoints failed');
  const info = source.info?.ok ? source.info.data : null;
  const cardRoot = source.card?.ok ? source.card.data : null;
  const card = cardRoot?.card || cardRoot || null;
  const relation = source.relation?.ok ? source.relation.data : null;
  const stats = source.upstat?.ok ? source.upstat.data : null;
  const counts = source.navnum?.ok ? source.navnum.data : null;
  const liveRoot = source.live?.ok ? source.live.data : null;
  const live = liveRoot?.[String(mid)] || null;
  return {
    profile: {
      mid: String(mid), name: info?.name ?? card?.name ?? null, avatar: info?.face ?? card?.face ?? null,
      sign: info?.sign ?? card?.sign ?? '', level: info?.level ?? card?.level_info?.current_level ?? null,
      official: info?.official || card?.Official || null, vip: info?.vip || card?.vip || null,
      pendant: info?.pendant || null, top_photo: info?.top_photo ?? card?.space?.l_img ?? null,
      space_url: 'https://space.bilibili.com/' + mid,
    },
    statistics: {
      following: relation?.following ?? card?.attention ?? null, followers: relation?.follower ?? card?.fans ?? null,
      archive_views: stats?.archive?.view ?? null, article_views: stats?.article?.view ?? null, likes: stats?.likes ?? null,
      video_count: counts?.video ?? cardRoot?.archive_count ?? null, article_count: counts?.article ?? null,
      audio_count: counts?.audio ?? null, album_count: counts?.album ?? null, favorite_count: counts?.favorite?.master ?? null,
    },
    live: live ? {
      is_live: live.live_status === 1, status: live.live_status ?? 0, room_id: live.room_id ?? null,
      title: live.title || '', cover: live.cover_from_user || live.keyframe || '', area: live.area_v2_name || live.area_name || '',
      parent_area: live.area_v2_parent_name || live.parent_name || '', url: live.room_id ? 'https://live.bilibili.com/' + live.room_id : '',
    } : null,
    pinned_video: source.top?.ok ? video(source.top.data?.archive || source.top.data) : null,
    sources: Object.fromEntries(Object.entries(source).map(([k,v]) => [k, v.ok ? { ok: true, ...v.meta } : v])),
  };
}

async function load(client, section, req, complete, maxPages, budget) {
  const consume = () => { if (budget.left <= 0) throw new Error('upstream request budget exhausted'); budget.left -= 1; };
  if (section === 'profile') { budget.left -= 7; return profile(client, req.mid); }
  if (section === 'collections') { consume(); return (await client.plain('/x/polymer/web-space/seasons_series_list', { mid: req.mid, page_num: req.page, page_size: req.pageSize }, 'collections', { referer: 'https://space.bilibili.com/' + req.mid + '/lists' })).data; }
  if (section === 'favorites') { consume(); return (await client.plain('/x/v3/fav/folder/created/list-all', { up_mid: req.mid }, 'favorites', { referer: 'https://space.bilibili.com/' + req.mid + '/favlist' })).data; }

  const pages = [];
  let page = req.page;
  let offset = req.offset;
  for (let i = 0; i < (complete ? maxPages : 1); i += 1) {
    consume();
    let data;
    let normalized;
    if (section === 'videos') {
      data = (await client.signed('/x/space/wbi/arc/search', { mid: req.mid, ps: req.pageSize, tid: req.tid, pn: page, keyword: req.keyword, order: req.order, platform: 'web', web_location: 1550101, order_avoided: 'true' }, 'videos', { referer: 'https://space.bilibili.com/' + req.mid + '/video', origin: 'https://space.bilibili.com' })).data;
      normalized = videoPage(data, page, req.pageSize);
    } else if (section === 'dynamics') {
      data = (await client.plain('/x/polymer/web-dynamic/v1/feed/space', { host_mid: req.mid, offset, features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard', web_location: '333.1387' }, 'dynamics', { referer: 'https://space.bilibili.com/' + req.mid + '/dynamic', origin: 'https://space.bilibili.com' })).data;
      normalized = dynamicPage(data, offset);
    } else if (section === 'articles') {
      data = (await client.plain('/x/space/article', { mid: req.mid, pn: page, ps: Math.min(req.pageSize, 30), sort: 'publish_time', jsonp: 'jsonp' }, 'articles', { referer: 'https://space.bilibili.com/' + req.mid + '/article' })).data;
      normalized = listPage(data, page, Math.min(req.pageSize, 30));
    } else if (section === 'audio') {
      try { data = (await client.plain('https://api.bilibili.com/audio/music-service/web/song/upper', { uid: req.mid, pn: page, ps: req.pageSize, order: 1 }, 'audio', { referer: 'https://space.bilibili.com/' + req.mid + '/audio' })).data; }
      catch (e) { data = (await client.plain('https://www.bilibili.com/audio/music-service-c/web/song/upper', { uid: req.mid, pn: page, ps: req.pageSize, order: 1 }, 'audio.fallback', { referer: 'https://space.bilibili.com/' + req.mid + '/audio' })).data; }
      normalized = listPage(data, page, req.pageSize);
    } else if (section === 'series_items') {
      if (!req.seriesId) throw new Error('series_items requires series_id');
      data = (await client.plain('/x/series/archives', { mid: req.mid, series_id: req.seriesId, only_normal: true, sort: 'desc', pn: page, ps: req.pageSize }, 'series_items', { referer: 'https://space.bilibili.com/' + req.mid })).data;
      normalized = videoPage(data, page, req.pageSize);
    } else if (section === 'season_items') {
      if (!req.seasonId) throw new Error('season_items requires season_id');
      data = (await client.plain('/x/polymer/web-space/seasons_archives_list', { mid: req.mid, season_id: req.seasonId, sort_reverse: false, page_num: page, page_size: req.pageSize }, 'season_items', { referer: 'https://space.bilibili.com/' + req.mid })).data;
      normalized = videoPage(data, page, req.pageSize);
    } else if (section === 'favorite_items') {
      if (!req.mediaId) throw new Error('favorite_items requires media_id');
      data = (await client.plain('/x/v3/fav/resource/list', { media_id: req.mediaId, pn: page, ps: Math.min(req.pageSize, 40), keyword: req.keyword, order: req.order || 'mtime', type: 0, tid: 0, platform: 'web' }, 'favorite_items', { referer: 'https://space.bilibili.com/' + req.mid + '/favlist?fid=' + req.mediaId })).data;
      normalized = listPage(data, page, Math.min(req.pageSize, 40));
    } else if (section === 'following' || section === 'followers') {
      const path = section === 'following' ? '/x/relation/followings' : '/x/relation/followers';
      data = (await client.plain(path, { vmid: req.mid, pn: page, ps: req.pageSize, order: 'desc', ...(section === 'following' ? { order_type: 'attention' } : {}) }, section, { referer: 'https://space.bilibili.com/' + req.mid + '/fans' })).data;
      normalized = listPage(data, page, req.pageSize);
    } else throw new Error('unknown section: ' + section);
    pages.push(normalized);
    if (section === 'dynamics') { if (!normalized.has_more) break; offset = normalized.next_offset; }
    else { if (!normalized.has_more) break; page = normalized.next_page; }
  }
  if (pages.length === 1) return pages[0];
  const last = pages.at(-1);
  return { ...last, items: pages.flatMap((p) => p.items || []), pages_fetched: pages.length };
}

function parseSections(q) {
  const raw = text(q.section || q.include || 'all').toLowerCase();
  const list = raw === 'all' ? DEFAULT_SECTIONS : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = list.filter((s) => !SECTIONS.has(s));
  if (invalid.length) throw new Error('unknown section: ' + invalid.join(', '));
  return [...new Set(list)];
}
function legacy(mid, sections) {
  const p = sections.profile?.ok ? sections.profile.data : {};
  const videos = sections.videos?.ok ? sections.videos.data?.items || [] : [];
  return {
    uid: String(mid),
    user: {
      name: p.profile?.name ?? null, face: p.profile?.avatar ?? null, fans: p.statistics?.followers ?? null,
      attention: p.statistics?.following ?? null, is_live: Boolean(p.live?.is_live), live_title: p.live?.title || '',
      live_url: p.live?.url || '', live_cover: p.live?.cover || '', live_area: p.live?.area || '', live_area_parent: p.live?.parent_area || '',
    },
    video_count: videos.length,
    videos: videos.map((v) => ({ title: v.title, desc: v.description, pic: v.cover, bvid: v.bvid, aid: v.aid, url: v.url, created: v.created, length: v.duration, play: v.play, danmaku: v.danmaku, comment: v.comment, like: v.like, date: v.created_at })),
  };
}
function cors(req, res, debug) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept,Content-Type,X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Bili-Proxy-Version', VERSION);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', debug ? 'no-store' : 'public, s-maxage=300, stale-while-revalidate=3600');
}

export default async function handler(req, res) {
  const q = req.query || {};
  const debug = bool(q.debug);
  cors(req, res, debug);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET','HEAD'].includes(req.method)) return res.status(405).json({ success: false, error: 'GET only' });
  if (bool(q.help)) return res.status(200).json({ name: 'bili-proxy', version: VERSION, sections: [...SECTIONS], examples: ['/api?mid=' + DEFAULT_MID, '/api?mid=' + DEFAULT_MID + '&section=videos&complete=1&max_pages=10'] });
  const started = Date.now();
  try {
    const mid = text(q.mid || q.uid || process.env.TARGET_UID || DEFAULT_MID).trim();
    if (!/^\d{1,20}$/u.test(mid) || mid === '0') return res.status(400).json({ success: false, error: 'mid must be a numeric Bilibili UID' });
    const names = parseSections(q);
    const complete = bool(q.complete || q.deep);
    const maxPages = int(q.max_pages, complete ? 5 : 1, 1, 10);
    const request = {
      mid, page: int(q.page, 1, 1, 10000), pageSize: int(q.page_size || q.ps, 30, 1, 50), offset: text(q.offset),
      keyword: text(q.keyword).slice(0,100), order: text(q.order, 'pubdate').slice(0,30), tid: int(q.tid, 0, 0, 999999),
      seriesId: text(q.series_id), seasonId: text(q.season_id), mediaId: text(q.media_id),
    };
    const budget = { left: int(q.request_budget, complete ? 30 : 20, 1, 40) };
    const client = new Bili();
    const diagnostics = await client.bootstrap(mid);
    const sections = {};
    const run = async (name) => { try { sections[name] = { ok: true, data: await load(client, name, request, complete, maxPages, budget) }; } catch (error) { sections[name] = failure(error); } };
    if (names.includes('profile')) await run('profile');
    const rest = names.filter((n) => n !== 'profile');
    for (let i = 0; i < rest.length; i += 2) await Promise.all(rest.slice(i, i + 2).map(run));
    const good = Object.values(sections).filter((s) => s.ok).length;
    const body = {
      success: good > 0, partial: good > 0 && good < names.length, version: VERSION, generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started, request: { mid, sections: names, page: request.page, page_size: request.pageSize, complete, max_pages: maxPages, upstream_requests_remaining: budget.left },
      ...legacy(mid, sections), sections, ...(debug ? { diagnostics } : {}),
    };
    const status = good > 0 ? 200 : 502;
    return req.method === 'HEAD' ? res.status(status).end() : res.status(status).json(body);
  } catch (error) {
    console.error('bili-proxy failed', { name: error?.name, message: error?.message });
    return res.status(500).json({ success: false, version: VERSION, error: error?.message || 'Internal error', elapsed_ms: Date.now() - started });
  }
}
