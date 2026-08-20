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

async function withFetch(mock, run) {
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('public following list normalizes items and exposes the next page', async () => {
  let calls = 0;
  await withFetch(async (url) => {
    calls += 1;
    assert.match(String(url), /following_list/);
    return jsonResponse({
      code: 0,
      data: {
        list: [
          { mid: 1, uname: 'A', face: '//i0.hdslb.com/a.jpg' },
          { mid: 2, uname: 'B', face: 'http://i1.hdslb.com/b.jpg' },
        ],
      },
    });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '293793435',
      kind: 'following',
      page: 1,
      pageSize: 2,
      knownTotal: 3,
    });

    assert.equal(calls, 1);
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].mid, '1');
    assert.equal(result.data.items[0].face, 'https://i0.hdslb.com/a.jpg');
    assert.equal(result.data.items[1].face, 'https://i1.hdslb.com/b.jpg');
    assert.equal(result.data.total, 3);
    assert.equal(result.data.has_more, true);
    assert.equal(result.data.next_page, 2);
  });
});

test('relation stat supplies an authoritative total for relation-only requests', async () => {
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
      data: {
        list: [
          { mid: 11, uname: '甲' },
          { mid: 12, uname: '乙' },
        ],
      },
    });
  }, async () => {
    const result = await fetchPublicRelations({
      mid: '293793435',
      kind: 'following',
      pageSize: 20,
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0], /x\/relation\/stat/);
    assert.equal(result.data.total, 2);
    assert.equal(result.data.has_more, false);
    assert.equal(result.data.completeness, 'complete');
    assert.equal(result.diagnostics.total_source, 'relation_stat');
  });
});

test('empty following list with a positive public count is marked private', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    const result = await fetchPublicRelations({
      mid: '3546779356235807',
      kind: 'following',
      knownTotal: 121,
      pageSize: 20,
    });

    assert.equal(result.data.total, 121);
    assert.equal(result.data.accessible_total, 0);
    assert.equal(result.data.privacy_restricted, true);
    assert.equal(result.data.has_more, false);
    assert.equal(result.data.completeness, 'privacy_restricted');
  });
});

test('empty follower list with a positive public count is rejected as unavailable', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    await assert.rejects(
      fetchPublicRelations({
        mid: '3546779356235807',
        kind: 'followers',
        knownTotal: 2057,
        pageSize: 20,
      }),
      (error) => {
        assert.ok(error instanceof PublicRelationError);
        assert.equal(error.diagnostics.reason, 'empty_nonzero_follower_list');
        assert.equal(error.diagnostics.known_total, 2057);
        return true;
      },
    );
  });
});

test('follower public cap stops before making an unnecessary upstream request', async () => {
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

test('a verified zero total remains a public empty list, not a privacy error', async () => {
  await withFetch(async () =>
    jsonResponse({ code: 0, data: { list: [] } }), async () => {
    const result = await fetchPublicRelations({
      mid: '1',
      kind: 'following',
      knownTotal: 0,
    });

    assert.equal(result.data.total, 0);
    assert.equal(result.data.privacy_restricted, false);
    assert.equal(result.data.completeness, 'complete');
  });
});
