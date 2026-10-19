import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/worker.js';

const env = { DEEPSEEK_API_KEY: 'test-secret' };
const req = (query, method = 'GET') => new Request(`https://local/api/search?${query}`, { method });
const noFetch = () => { throw new Error('Must not contact upstream'); };

test('invalid queries and counts are rejected before upstream', async () => {
  for (const q of ['', 'q=', 'q=%20', `q=${'字'.repeat(129)}`, 'q=a&q=b', 'q=a&count=0', 'q=a&count=51', 'q=a&count=1.5', 'q=a&count=2&count=3']) {
    assert.equal((await search(req(q), env, noFetch)).status, 400, q);
  }
  assert.equal((await search(req('q=a', 'POST'), env, noFetch)).status, 405);
});
test('missing credentials and insecure endpoints fail closed', async () => {
  assert.equal((await search(req('q=a'), {}, noFetch)).status, 503);
  assert.equal((await search(req('q=a'), { ...env, DEEPSEEK_SEARCH_URL: 'http://example.com' }, noFetch)).status, 503);
});
test('official request contract, Unicode limit, normalized safe results', async () => {
  const query = '😀'.repeat(128);
  const response = await search(req(`q=${query}&count=2`), env, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(JSON.parse(options.body), { query, count: 2, need_content: false });
    return Response.json({ results: [
      { title: '<script>alert(1)</script>', url: 'https://example.com/', snippet: 'Actual snippet', content: 'not exposed' },
      { title: 'bad', url: 'javascript:alert(1)', snippet: '' },
      { title: 'bad', url: 'https://user:pass@example.com', snippet: '' },
    ] });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.results.length, 1);
  assert.equal(data.source, 'deepseek');
  assert.equal(data.results[0].content, undefined);
  assert.ok(!JSON.stringify(data).includes('test-secret'));
});
test('empty result is a successful search', async () => {
  const response = await search(req('q=none'), env, async () => Response.json({ results: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results, []);
});
test('upstream errors never expose upstream bodies or secrets', async () => {
  for (const [upstream, expected] of [[302, 502], [401, 502], [402, 502], [403, 502], [429, 429], [500, 502], [408, 504], [504, 504]]) {
    const response = await search(req('q=a'), env, async () => new Response('test-secret raw error', { status: upstream }));
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes('test-secret'));
  }
});
test('malformed JSON and invalid schemas fail explicitly', async () => {
  for (const body of ['not json', '{}', 'null', '{"results":[{}]}']) {
    assert.equal((await search(req('q=a'), env, async () => new Response(body))).status, 502);
  }
});
test('network failure and timeout', async () => {
  assert.equal((await search(req('q=a'), env, async () => { throw new Error('secret'); })).status, 502);
  const response = await search(req('q=a'), env, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), 10);
  assert.equal(response.status, 504);
});

test('maximum count forwards only documented fields and returns up to 50 results', async () => {
  const response = await search(req('q=many&count=50'), env, async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { query: 'many', count: 50, need_content: false });
    return Response.json({ results: Array.from({ length: 53 }, (_, i) => ({ title: String(i), url: `https://example.com/${i}`, snippet: 'mock' })) });
  });
  assert.equal((await response.json()).results.length, 50);
});
