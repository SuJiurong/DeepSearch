// Real Wrangler + HTTP mock upstream. No requests to the real DeepSeek API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let upstreamCalls = 0;
const mock = createServer(async (req, res) => {
  upstreamCalls++;
  let body = '';
  for await (const chunk of req) body += chunk;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer mock-only');
  const data = JSON.parse(body);
  assert.equal(data.need_content, false);
  res.setHeader('Content-Type', 'application/json');
  if (data.query === 'rate') { res.writeHead(429); res.end('private upstream message'); return; }
  if (data.query === 'error') { res.writeHead(500); res.end('private upstream message'); return; }
  if (data.query === 'invalid') { res.end('{"unexpected":true}'); return; }
  if (data.query === 'timeout') return;
  res.end(JSON.stringify({ results: data.query === 'empty' ? [] : [{ title: 'Mock 搜索结果', url: 'https://example.com/search', snippet: '这是本地 HTTP mock 数据，非 DeepSeek 联网结果。' }] }));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const mockPort = mock.address().port;
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const state = await mkdtemp(join(tmpdir(), 'deepsearch-test-'));
let worker;
let output = '';
async function stop() {
  if (worker && worker.exitCode === null) {
    const exited = once(worker, 'exit');
    worker.kill('SIGTERM');
    await exited;
  }
}
async function start(key) {
  output = '';
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state,
    '--var', `DEEPSEEK_API_KEY:${key}`, '--var', `DEEPSEEK_SEARCH_URL:http://127.0.0.1:${mockPort}/search`, '--var', 'ALLOW_LOCAL_MOCK:true'],
  { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', chunk => { output += chunk; });
  worker.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 150; i++) {
    if (worker.exitCode !== null) throw new Error(output);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(200);
  }
  throw new Error(`Wrangler did not become ready: ${output}`);
}
try {
  await start('');
  assert.equal((await fetch(`${base}/api/search?q=test`)).status, 503);
  assert.equal(upstreamCalls, 0);
  console.log('PASS real Worker: missing credentials -> 503, no upstream call');
  await stop();
  await start('mock-only');
  for (const path of ['/', '/search?q=test', '/app.js', '/style.css', '/favicon.svg']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    if (path.startsWith('/search') || path === '/') {
      assert.match(await response.text(), /id="search-form"/);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
  }
  console.log('PASS real Worker: home, search route and static assets');
  for (const query of ['', 'q=%20', `q=${'a'.repeat(129)}`, 'q=x&count=51', 'q=x&q=y']) {
    const before = upstreamCalls;
    assert.equal((await fetch(`${base}/api/search?${query}`)).status, 400);
    assert.equal(upstreamCalls, before);
  }
  assert.equal((await fetch(`${base}/api/search?q=a`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  console.log('PASS real Worker: input and method validation');
  for (const [query, expected] of [['hello', 200], ['empty', 200], ['rate', 429], ['error', 502], ['invalid', 502], ['timeout', 504]]) {
    const response = await fetch(`${base}/api/search?q=${query}`);
    const text = await response.text();
    if (response.status !== expected) await delay(200);
    assert.equal(response.status, expected, `${query}: ${text}; upstreamCalls=${upstreamCalls}; ${output}`);
    assert.ok(!text.includes('mock-only') && !text.includes('private upstream message'));
    if (expected === 200) {
      const data = JSON.parse(text);
      assert.equal(data.source, 'mock');
      assert.equal(data.results.length, query === 'empty' ? 0 : 1);
    }
    console.log(`PASS HTTP mock upstream: ${query} -> ${expected}`);
  }
  console.log('Integration passed. Real DeepSeek upstream NOT tested.');
} finally {
  await stop();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await rm(state, { recursive: true, force: true });
}
