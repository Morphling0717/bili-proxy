import assert from 'node:assert/strict';
import test from 'node:test';

import { _test } from '../lib/public-sections.mjs';

test('httpsUrl upgrades protocol-relative and Bilibili asset URLs', () => {
  assert.equal(_test.httpsUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(
    _test.httpsUrl('http://i1.hdslb.com/bfs/archive/a.jpg'),
    'https://i1.hdslb.com/bfs/archive/a.jpg',
  );
  assert.equal(_test.httpsUrl('http://example.com/a.jpg'), 'http://example.com/a.jpg');
});

test('normalizeFolderState distinguishes hidden-or-empty from a public empty list', () => {
  assert.deepEqual(_test.normalizeFolderState(null, 'created'), {
    available: false,
    visibility: 'empty_or_not_public',
    count: null,
    items: [],
    source: 'created',
  });
  assert.deepEqual(_test.normalizeFolderState({ count: 0, list: [] }, 'created'), {
    available: true,
    visibility: 'public',
    count: 0,
    items: [],
    source: 'created',
  });
});

test('normalizeLegacyDynamic parses card JSON and sanitizes asset URLs', () => {
  const item = _test.normalizeLegacyDynamic({
    desc: {
      dynamic_id_str: '123',
      type: 8,
      timestamp: 1_700_000_000,
      user_profile: { info: { uid: 42 } },
    },
    card: JSON.stringify({ pic: 'http://i0.hdslb.com/a.jpg' }),
  });
  assert.equal(item.id, '123');
  assert.equal(item.author_mid, 42);
  assert.equal(item.card.pic, 'https://i0.hdslb.com/a.jpg');
  assert.equal(item.source, 'legacy_space_history');
});

test('normalizeCollectionGroup preserves IDs, preview archives, and counts', () => {
  const item = _test.normalizeCollectionGroup(
    {
      meta: { season_id: 9, name: '合集', total: 2, cover: '//i0.hdslb.com/c.jpg' },
      archives: [{ aid: 1 }, { aid: 2 }],
    },
    'season',
  );
  assert.equal(item.id, 9);
  assert.equal(item.title, '合集');
  assert.equal(item.total, 2);
  assert.equal(item.cover, 'https://i0.hdslb.com/c.jpg');
  assert.equal(item.preview_archives.length, 2);
});

test('WBI signatures are deterministic when timestamp is fixed', () => {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const signed = _test.signWbi(
      { mid: 123, page: 1 },
      '7cd084941338484aae1ad9425b84077c',
      '4932caff0ff746eab6f01bf08b70ac45',
    );
    assert.match(signed, /mid=123/);
    assert.match(signed, /page=1/);
    assert.match(signed, /wts=1700000000/);
    assert.match(signed, /w_rid=[a-f0-9]{32}$/);
  } finally {
    Date.now = originalNow;
  }
});
