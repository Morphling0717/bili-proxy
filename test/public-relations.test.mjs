import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchPublicRelations,
  PublicRelationError,
} from '../lib/public-relations.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function relation(mid, name, face = '//i0.hdslb.com/avatar.jpg') {
  return { mid, uname: name, face, attribute: 2, mtime: 123 };
}

test('returns a normalized public following page and a correct next page', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return jsonResponse({
      code: 0,
      data: {
        total: 3,
        list: [relation(1, 'one'), relation(2, 'two')],
      },
    });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'following',
    pageSize: 2,
  });

  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, '/game/center/h5/user/relationship/following_list');
  assert.equal(urls[0].searchParams.get('vmid'), '42');
  assert.equal(urls[0].searchParams.get('pn'), '1');
  assert.equal(urls[0].searchParams.get('ps'), '2');
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.items[0].face, 'https://i0.hdslb.com/avatar.jpg');
  assert.equal(result.data.total, 3);
  assert.equal(result.data.has_more, true);
  assert.equal(result.data.next_page, 2);
  assert.equal(result.data.completeness, 'public_page');
});

test('complete mode follows pages until the known total is exhausted', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pages = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('pn'));
    pages.push(page);
    const start = (page - 1) * 10;
    const count = page < 3 ? 10 : 5;
    const list = Array.from({ length: count }, (_, index) =>
      relation(start + index + 1, `u${start + index + 1}`),
    );
    return jsonResponse({ code: 0, data: { total: 25, list } });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'followers',
    pageSize: 10,
    complete: true,
    maxPages: 5,
    knownTotal: 25,
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.data.items.length, 25);
  assert.equal(result.data.pages_fetched, 3);
  assert.equal(result.data.has_more, false);
  assert.equal(result.data.next_page, null);
  assert.equal(result.data.completeness, 'complete');
});

test('an empty first page with a positive known total is marked private', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ code: 0, data: { list: [] } });

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'following',
    knownTotal: 121,
  });

  assert.equal(result.data.items.length, 0);
  assert.equal(result.data.privacy_restricted, true);
  assert.equal(result.data.has_more, false);
  assert.equal(result.data.completeness, 'privacy_restricted');
});

test('requests beyond the public first-100 window do not hit upstream', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must not be called');
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'followers',
    page: 6,
    pageSize: 20,
    knownTotal: 2057,
  });

  assert.equal(called, false);
  assert.equal(result.data.capped, true);
  assert.equal(result.data.public_cap, 100);
  assert.equal(result.data.accessible_total, 100);
  assert.equal(result.data.completeness, 'public_cap_reached');
});

test('complete mode preserves a next page when its page budget is reached', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('pn'));
    const start = (page - 1) * 10;
    return jsonResponse({
      code: 0,
      data: {
        total: 80,
        list: Array.from({ length: 10 }, (_, index) =>
          relation(start + index + 1, `u${start + index + 1}`),
        ),
      },
    });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'followers',
    pageSize: 10,
    complete: true,
    maxPages: 2,
    knownTotal: 80,
  });

  assert.equal(result.data.items.length, 20);
  assert.equal(result.data.has_more, true);
  assert.equal(result.data.next_page, 3);
  assert.equal(result.data.completeness, 'page_budget_reached');
});

test('a page straddling the public cap is trimmed without changing ps', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestedSize = null;
  globalThis.fetch = async (url) => {
    requestedSize = Number(new URL(url).searchParams.get('ps'));
    return jsonResponse({
      code: 0,
      data: {
        total: 121,
        list: Array.from({ length: 7 }, (_, index) =>
          relation(99 + index, `u${99 + index}`),
        ),
      },
    });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'followers',
    page: 15,
    pageSize: 7,
    knownTotal: 121,
  });

  assert.equal(requestedSize, 7);
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.capped, true);
  assert.equal(result.data.has_more, false);
  assert.equal(result.data.completeness, 'public_cap_reached');
});

test('public following pages can continue past 100 until the known total', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pages = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('pn'));
    pages.push(page);
    const start = (page - 1) * 20;
    const count = page < 7 ? 20 : 1;
    return jsonResponse({
      code: 0,
      data: {
        list: Array.from({ length: count }, (_, index) =>
          relation(start + index + 1, `u${start + index + 1}`),
        ),
      },
    });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'following',
    pageSize: 20,
    complete: true,
    maxPages: 10,
    knownTotal: 121,
  });

  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.data.items.length, 121);
  assert.equal(result.data.public_cap, null);
  assert.equal(result.data.has_more, false);
  assert.equal(result.data.completeness, 'complete');
});

test('an upstream stop before the known following total is explicit', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('pn'));
    const start = (page - 1) * 20;
    const count = page <= 5 ? 20 : 0;
    return jsonResponse({
      code: 0,
      data: {
        list: Array.from({ length: count }, (_, index) =>
          relation(start + index + 1, `u${start + index + 1}`),
        ),
      },
    });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'following',
    pageSize: 20,
    complete: true,
    maxPages: 10,
    knownTotal: 121,
  });

  assert.equal(result.data.items.length, 100);
  assert.equal(result.data.accessible_total, 100);
  assert.equal(result.data.has_more, false);
  assert.equal(result.data.completeness, 'upstream_limit_reached');
});

test('invalid relation kinds fail clearly', async () => {
  await assert.rejects(
    () => fetchPublicRelations({ mid: '42', kind: 'friends' }),
    (error) => error instanceof PublicRelationError && /未知关系列表类型/u.test(error.message),
  );
});

test('an empty relation-only request uses public relation stats to prove privacy', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const paths = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === '/x/relation/stat') {
      return jsonResponse({
        code: 0,
        data: { following: 121, follower: 2057 },
      });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  };

  const result = await fetchPublicRelations({
    mid: '3546779356235807',
    kind: 'following',
  });

  assert.deepEqual(paths, [
    '/game/center/h5/user/relationship/following_list',
    '/x/relation/stat',
  ]);
  assert.equal(result.data.total, 121);
  assert.equal(result.data.privacy_restricted, true);
  assert.equal(result.data.accessible_total, 0);
  assert.equal(result.data.completeness, 'privacy_restricted');
  assert.equal(result.diagnostics.relation_stat.ok, true);
});

test('an empty public relation with a confirmed zero total is complete', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/x/relation/stat') {
      return jsonResponse({
        code: 0,
        data: { following: 0, follower: 0 },
      });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'followers',
  });

  assert.equal(result.data.total, 0);
  assert.equal(result.data.privacy_restricted, false);
  assert.equal(result.data.accessible_total, 0);
  assert.equal(result.data.completeness, 'complete');
});

test('an empty list stays explicitly ambiguous if relation stats are unavailable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/x/relation/stat') {
      return jsonResponse({ code: -352, message: '-352', data: null });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  };

  const result = await fetchPublicRelations({
    mid: '42',
    kind: 'following',
  });

  assert.equal(result.data.total, null);
  assert.equal(result.data.privacy_restricted, null);
  assert.equal(result.data.accessible_total, null);
  assert.equal(result.data.completeness, 'empty_or_private');
  assert.equal(result.diagnostics.relation_stat.ok, false);
  assert.equal(result.diagnostics.relation_stat.code, -352);
});
