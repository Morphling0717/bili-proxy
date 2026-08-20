import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PublicRelationError,
  fetchPublicRelations,
} from '../lib/public-relations.mjs';

const originalFetch = globalThis.fetch;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function relation(mid, name, face = '//i0.hdslb.com/avatar.jpg') {
  return { mid, uname: name, face, attribute: 2, mtime: 123 };
}

async function withFetch(mock, run) {
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('normalizes a visible following page and exposes the next page', async () => {
  let calls = 0;
  await withFetch(async (url) => {
    calls += 1;
    assert.match(String(url), /following_list/u);
    return jsonResponse({
      code: 0,
      data: {
        list: [
          relation(1, 'A'),
          relation(2, 'B', 'http://i1.hdslb.com/b.jpg'),
        ],
      },
    });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '293793435',
      kind: 'following',
      pageSize: 2,
      knownTotal: 3,
    });

    assert.equal(calls, 1);
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].mid, '1');
    assert.equal(result.data.items[0].face, 'https://i0.hdslb.com/avatar.jpg');
    assert.equal(result.data.items[1].face, 'https://i1.hdslb.com/b.jpg');
    assert.equal(result.data.total, 3);
    assert.equal(result.data.has_more, true);
    assert.equal(result.data.next_page, 2);
    assert.equal(result.data.completeness, 'public_page');
  });
});

test('relation stat supplies the total for a relation-only request', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('/x/relation/stat')) {
      return jsonResponse({
        code: 0,
        data: { following: 2, follower: 9 },
      });
    }
    return jsonResponse({
      code: 0,
      data: { list: [relation(11, '甲'), relation(12, '乙')] },
    });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '293793435',
      kind: 'following',
      pageSize: 20,
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0], /x\/relation\/stat/u);
    assert.match(calls[1], /following_list/u);
    assert.equal(result.data.total, 2);
    assert.equal(result.data.has_more, false);
    assert.equal(result.data.completeness, 'complete');
    assert.equal(result.diagnostics.total_source, 'relation_stat');
  });
});

test('complete mode follows pages until the known total is exhausted', async () => {
  const pages = [];
  await withFetch(async (url) => {
    const page = Number(new URL(url).searchParams.get('pn'));
    pages.push(page);
    const start = (page - 1) * 10;
    const count = page < 3 ? 10 : 5;
    return jsonResponse({
      code: 0,
      data: {
        list: Array.from({ length: count }, (_, index) =>
          relation(start + index + 1, `u${start + index + 1}`),
        ),
      },
    });
  }, async () => {
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
    assert.equal(result.data.completeness, 'complete');
  });
});

test('empty following list with a positive public count is marked private', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    const result = await fetchPublicRelations({
      mid: '3546779356235807',
      kind: 'following',
      knownTotal: 121,
    });

    assert.equal(result.data.total, 121);
    assert.equal(result.data.items.length, 0);
    assert.equal(result.data.accessible_total, 0);
    assert.equal(result.data.privacy_restricted, true);
    assert.equal(result.data.public_list_unavailable, false);
    assert.equal(result.data.completeness, 'privacy_restricted');
  });
});

test('empty follower window with a positive count is unavailable, not private or fatal', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    const result = await fetchPublicRelations({
      mid: '3546779356235807',
      kind: 'followers',
      knownTotal: 2057,
    });

    assert.equal(result.data.total, 2057);
    assert.equal(result.data.items.length, 0);
    assert.equal(result.data.accessible_total, 0);
    assert.equal(result.data.privacy_restricted, false);
    assert.equal(result.data.public_list_unavailable, true);
    assert.equal(result.data.has_more, false);
    assert.equal(result.data.completeness, 'public_list_unavailable');
  });
});

test('a relation-only follower request preserves the count when its public list is unavailable', async () => {
  const paths = [];
  await withFetch(async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === '/x/relation/stat') {
      return jsonResponse({
        code: 0,
        data: { following: 121, follower: 2057 },
      });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '3546779356235807',
      kind: 'followers',
    });

    assert.deepEqual(paths, [
      '/x/relation/stat',
      '/game/center/h5/user/relationship/follower_list',
    ]);
    assert.equal(result.data.total, 2057);
    assert.equal(result.data.public_cap, 100);
    assert.equal(result.data.public_list_unavailable, true);
    assert.equal(result.data.completeness, 'public_list_unavailable');
    assert.equal(result.diagnostics.total_source, 'relation_stat');
  });
});

test('an empty list stays explicitly indeterminate when relation stat is unavailable', async () => {
  await withFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/x/relation/stat') {
      return jsonResponse({ code: -352, message: '-352', data: null });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '42',
      kind: 'following',
    });

    assert.equal(result.data.total, null);
    assert.equal(result.data.accessible_total, 0);
    assert.equal(result.data.privacy_restricted, null);
    assert.equal(result.data.public_list_unavailable, true);
    assert.equal(result.data.completeness, 'indeterminate_empty_list');
    assert.equal(result.diagnostics.relation_stat, null);
    assert.equal(result.diagnostics.relation_stat_error.code, -352);
  });
});

test('a verified zero total remains a complete public empty list', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    const result = await fetchPublicRelations({
      mid: '1',
      kind: 'following',
      knownTotal: 0,
    });

    assert.equal(result.data.total, 0);
    assert.equal(result.data.privacy_restricted, false);
    assert.equal(result.data.public_list_unavailable, false);
    assert.equal(result.data.accessible_total, 0);
    assert.equal(result.data.completeness, 'complete');
  });
});

test('the follower first-100 cap avoids unnecessary upstream calls', async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    throw new Error('should not fetch');
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '504140200',
      kind: 'followers',
      page: 6,
      pageSize: 20,
      knownTotal: 1000,
    });

    assert.equal(called, false);
    assert.equal(result.data.items.length, 0);
    assert.equal(result.data.public_cap, 100);
    assert.equal(result.data.accessible_total, 100);
    assert.equal(result.data.capped, true);
    assert.equal(result.data.completeness, 'public_cap_reached');
  });
});

test('a follower page that straddles the public cap is trimmed', async () => {
  let requestedSize = null;
  await withFetch(async (url) => {
    requestedSize = Number(new URL(url).searchParams.get('ps'));
    return jsonResponse({
      code: 0,
      data: {
        list: Array.from({ length: 7 }, (_, index) =>
          relation(99 + index, `u${99 + index}`),
        ),
      },
    });
  }, async () => {
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
});

test('complete mode exposes a next page when its request budget is reached', async () => {
  await withFetch(async (url) => {
    const page = Number(new URL(url).searchParams.get('pn'));
    const start = (page - 1) * 10;
    return jsonResponse({
      code: 0,
      data: {
        list: Array.from({ length: 10 }, (_, index) =>
          relation(start + index + 1, `u${start + index + 1}`),
        ),
      },
    });
  }, async () => {
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
});

test('public following pagination can continue past 100', async () => {
  const pages = [];
  await withFetch(async (url) => {
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
  }, async () => {
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
});

test('an upstream stop before the known following total is explicit', async () => {
  await withFetch(async (url) => {
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
  }, async () => {
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
});

test('invalid relation kinds fail clearly', async () => {
  await assert.rejects(
    () => fetchPublicRelations({ mid: '42', kind: 'friends' }),
    (error) =>
      error instanceof PublicRelationError &&
      /未知关系列表类型/u.test(error.message),
  );
});
