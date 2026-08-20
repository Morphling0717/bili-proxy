import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeVideoPage,
  parseCookieHeader,
  signWbiParams,
} from '../lib/browser-videos.mjs';

test('cookie parser preserves values containing equals signs', () => {
  const cookies = parseCookieHeader('SESSDATA=a=b=c; bili_jct=token');
  assert.equal(cookies[0].name, 'SESSDATA');
  assert.equal(cookies[0].value, 'a=b=c');
  assert.equal(cookies[1].value, 'token');
});

test('browser WBI signer is deterministic', () => {
  const query = signWbiParams(
    { mid: '123', pn: 2, keyword: "a!'()*b" },
    '0123456789abcdef0123456789abcdef',
    'fedcba9876543210fedcba9876543210',
    1_700_000_000,
  );
  const params = new URLSearchParams(query);
  assert.equal(params.get('mid'), '123');
  assert.equal(params.get('pn'), '2');
  assert.equal(params.get('keyword'), 'ab');
  assert.match(params.get('w_rid'), /^[a-f0-9]{32}$/u);
});

test('video page normalizer preserves legacy-relevant fields', () => {
  const result = normalizeVideoPage(
    {
      page: { count: 31 },
      list: {
        vlist: [
          {
            aid: 42,
            bvid: 'BV1TEST',
            title: 'Test',
            description: 'Desc',
            pic: '//example.com/a.jpg',
            created: 1_700_000_000,
            length: '01:23',
            play: 100,
            comment: 2,
          },
        ],
      },
    },
    1,
    30,
  );
  assert.equal(result.items[0].url, 'https://www.bilibili.com/video/BV1TEST');
  assert.equal(result.items[0].cover, 'https://example.com/a.jpg');
  assert.equal(result.has_more, true);
  assert.equal(result.next_page, 2);
});
