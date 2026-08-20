import baseHandler from './index.mjs';
import {
  PublicRelationError,
  fetchPublicRelations,
} from '../lib/public-relations.mjs';

export const config = {
  maxDuration: 300,
};

const VERSION = '3.1.0';
const RELATIONS = ['following', 'followers'];

class CaptureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = undefined;
    this.finished = false;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), { name, value });
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase())?.value;
  }

  removeHeader(name) {
    this.headers.delete(String(name).toLowerCase());
  }

  status(code) {
    this.statusCode = Number(code) || 200;
    return this;
  }

  json(value) {
    this.body = value;
    this.finished = true;
    return this;
  }

  send(value) {
    this.body = value;
    this.finished = true;
    return this;
  }

  end(value) {
    if (value !== undefined) this.body = value;
    this.finished = true;
    return this;
  }
}

function replay(captured, res) {
  for (const { name, value } of captured.headers.values()) {
    if (String(name).toLowerCase() === 'content-length') continue;
    res.setHeader(name, value);
  }
  res.setHeader('X-Bili-Proxy-Version', VERSION);
  res.status(captured.statusCode);
  if (captured.body === undefined) return res.end();
  if (
    typeof captured.body === 'string' ||
    Buffer.isBuffer(captured.body) ||
    captured.body instanceof Uint8Array
  ) {
    return res.send(captured.body);
  }
  return res.json(captured.body);
}

function text(value, fallback = '') {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function bool(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function int(value, fallback, min, max) {
  if (Array.isArray(value)) value = value[0];
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function sectionNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return new Set(
    values
      .flatMap((entry) => String(entry || '').split(','))
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isEverything(query) {
  const names = sectionNames(query.section || query.include);
  return (
    names.has('everything') ||
    names.has('full') ||
    bool(query.everything) ||
    bool(query.full)
  );
}

function requestedRelations(query, sections) {
  const names = sectionNames(query.section || query.include);
  if (isEverything(query) || names.size === 0 || names.has('all')) {
    return [...RELATIONS];
  }
  return RELATIONS.filter(
    (name) => names.has(name) || Object.hasOwn(sections || {}, name),
  );
}

function knownTotal(body, name) {
  const profile = body?.sections?.profile?.data || {};
  const statistics = profile.statistics || profile.stats || {};
  const candidates =
    name === 'following'
      ? [
          statistics.following,
          profile.following,
          profile.attention,
          body?.user?.attention,
        ]
      : [
          statistics.followers,
          statistics.follower,
          profile.followers,
          profile.follower,
          profile.fans,
          body?.user?.fans,
        ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function relationItems(section) {
  const items = section?.data?.items ?? section?.data?.list;
  return Array.isArray(items) ? items : null;
}

function shouldRecover(section, total, force) {
  if (force || !section?.ok) return true;
  const items = relationItems(section);
  return Number(total) > 0 && (!items || items.length === 0);
}

function safeError(error, stage) {
  return {
    stage,
    name: error?.name || 'Error',
    message: error?.message || '公开关系接口失败',
    diagnostics:
      error instanceof PublicRelationError ? error.diagnostics : undefined,
  };
}

function installRelation(body, name, result, previous) {
  body.sections[name] = {
    ok: true,
    source: 'biligame_public_relation',
    data: result.data,
    recovered_from:
      previous && !previous.ok
        ? {
            source: previous.source || 'web_relation',
            error: previous.error || null,
          }
        : undefined,
  };
}

function refreshSummary(body) {
  const states = Object.values(body.sections || {}).filter(
    (section) => section && typeof section.ok === 'boolean',
  );
  const succeeded = states.filter((section) => section.ok).length;
  const failed = states.length - succeeded;
  body.success = succeeded > 0;
  body.partial = succeeded > 0 && failed > 0;
  body.summary = {
    ...(body.summary || {}),
    requested: states.length,
    succeeded,
    failed,
  };
}

export default async function handler(req, res) {
  const started = Date.now();
  const originalQuery = { ...(req.query || {}) };
  const captured = new CaptureResponse();

  try {
    await baseHandler(req, captured);
  } catch (error) {
    captured.statusCode = 500;
    captured.body = {
      success: false,
      version: VERSION,
      error: error?.message || '基础采集器异常',
    };
  }

  const body = captured.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return replay(captured, res);
  }

  body.version = VERSION;
  if (bool(originalQuery.help)) {
    body.modes = [...new Set([...(body.modes || []), 'all', 'everything'])];
    body.public_sections = [
      ...new Set([
        ...(body.public_sections || []),
        'following',
        'followers',
      ]),
    ];
    body.public_relation_limit = {
      following: '公开游戏端接口分页；隐私关闭时返回受限标记',
      followers: '匿名公开窗口最多前 100 人',
    };
    body.examples = [
      ...(Array.isArray(body.examples) ? body.examples : []),
      '/api?mid=3546779356235807&section=following&complete=1&relation_max_pages=20',
      '/api?mid=3546779356235807&section=followers&complete=1',
    ];
    body.elapsed_ms = Date.now() - started;
    return replay(captured, res);
  }

  if (
    req.method === 'OPTIONS' ||
    !body.sections ||
    Array.isArray(body.sections) ||
    typeof body.sections !== 'object'
  ) {
    body.elapsed_ms = Date.now() - started;
    return replay(captured, res);
  }

  const enabled = !['0', 'false', 'off'].includes(
    text(
      originalQuery.relation_fallback,
      process.env.RELATION_FALLBACK ?? '1',
    ).toLowerCase(),
  );
  const force = bool(originalQuery.relation_force);
  const wanted = requestedRelations(originalQuery, body.sections).filter(
    (name) =>
      shouldRecover(body.sections[name], knownTotal(body, name), force),
  );

  if (enabled && wanted.length > 0) {
    const page = int(originalQuery.page, 1, 1, 10_000);
    const requestedPageSize = int(
      originalQuery.page_size || originalQuery.ps,
      20,
      1,
      50,
    );
    const pageSize = int(
      originalQuery.relation_page_size,
      Math.min(requestedPageSize, 20),
      1,
      20,
    );
    const complete =
      bool(originalQuery.relation_complete) ||
      bool(originalQuery.complete || originalQuery.deep) ||
      isEverything(originalQuery);
    const baseMaxPages = int(
      originalQuery.max_pages,
      complete ? 5 : 1,
      1,
      10,
    );
    const maxPages = int(
      originalQuery.relation_max_pages,
      Math.min(baseMaxPages, 20),
      1,
      20,
    );
    const timeoutMs = int(
      originalQuery.relation_timeout_ms,
      10_000,
      3_000,
      30_000,
    );

    const settled = await Promise.allSettled(
      wanted.map((name) =>
        fetchPublicRelations({
          mid: String(body.uid || originalQuery.mid || originalQuery.uid || ''),
          kind: name,
          page,
          pageSize,
          complete,
          maxPages,
          knownTotal: knownTotal(body, name),
          timeoutMs,
        }),
      ),
    );

    body.request = {
      ...(body.request || {}),
      relation_fallback: wanted,
    };

    const diagnostics = {};
    settled.forEach((outcome, index) => {
      const name = wanted[index];
      const previous = body.sections[name];
      if (outcome.status === 'fulfilled') {
        installRelation(body, name, outcome.value, previous);
        diagnostics[name] = outcome.value.diagnostics;
        return;
      }
      diagnostics[name] = safeError(outcome.reason, name);
      if (!previous) {
        body.sections[name] = {
          ok: false,
          source: 'biligame_public_relation',
          error: safeError(outcome.reason, name),
        };
      } else {
        previous.public_relation_fallback_error = safeError(
          outcome.reason,
          name,
        );
      }
    });

    if (bool(originalQuery.debug)) {
      body.diagnostics = {
        ...(body.diagnostics || {}),
        public_relations: diagnostics,
      };
    }
  }

  refreshSummary(body);
  if (body.success && captured.statusCode >= 500) captured.statusCode = 200;
  body.elapsed_ms = Date.now() - started;
  return replay(captured, res);
}
