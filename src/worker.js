const ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const TIMEOUT_MS = 10000;

function json(body, status = 200, extra = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}
function error(code, message, status) {
  return json({ error: { code, message } }, status);
}
function validURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// Injectable transport is used only by tests; runtime uses native fetch.
export async function search(request, env, transport = fetch, timeoutMs = TIMEOUT_MS) {
  if (request.method !== 'GET') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET 请求。' } }, 405, { Allow: 'GET' });
  }
  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  if (params.getAll('q').length !== 1 || !query || [...query].length > 128) {
    return error('INVALID_QUERY', '请输入 1–128 个字符的搜索内容。', 400);
  }
  const countText = params.get('count') ?? '10';
  if (params.getAll('count').length > 1 || !/^[1-9]\d?$/.test(countText) || Number(countText) > 50) {
    return error('INVALID_COUNT', '结果数量必须是 1–50 的整数。', 400);
  }
  if (!env.DEEPSEEK_API_KEY?.trim()) {
    return error('NOT_CONFIGURED', '搜索服务尚未配置，请在服务端设置 DeepSeek API Key。', 503);
  }
  const endpoint = env.DEEPSEEK_SEARCH_URL || ENDPOINT;
  if (!validURL(endpoint)) return error('INVALID_CONFIG', '搜索服务配置无效。', 503);
  const target = new URL(endpoint);
  const localMock = env.ALLOW_LOCAL_MOCK === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !localMock) {
    return error('INVALID_CONFIG', '搜索服务地址必须使用 HTTPS。', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, count: Number(countText), need_content: false }),
    });
    if (!response.ok) {
      if (response.status === 429) return error('UPSTREAM_RATE_LIMIT', '搜索请求过于频繁，请稍后重试。', 429);
      if ([408, 504].includes(response.status)) return error('UPSTREAM_TIMEOUT', '搜索服务响应超时，请重试。', 504);
      if ([401, 402, 403].includes(response.status)) return error('UPSTREAM_ACCOUNT', '搜索服务账户不可用，请检查服务端密钥、权限和余额。', 502);
      return error('UPSTREAM_ERROR', '搜索服务暂时不可用，请稍后重试。', 502);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.results) || data.results.some(item =>
      !item || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.snippet !== 'string'
    )) return error('INVALID_RESPONSE', '搜索服务返回了无法识别的数据。', 502);
    const results = data.results.filter(item => validURL(item.url)).slice(0, Number(countText)).map(item => ({
      title: item.title, url: item.url, snippet: item.snippet,
      ...(typeof item.site_name === 'string' && item.site_name.trim() ? { site_name: item.site_name.trim().slice(0, 200) } : {}),
      ...Object.fromEntries(['favicon', 'thumbnail'].flatMap(key => {
        const value = item[key];
        return typeof value === 'string' && validURL(value) && new URL(value).protocol === 'https:' ? [[key, value]] : [];
      })),
    }));
    return json({ query, results, source: localMock ? 'mock' : 'deepseek' });
  } catch {
    return controller.signal.aborted
      ? error('UPSTREAM_TIMEOUT', '搜索服务响应超时，请重试。', 504)
      : error('UPSTREAM_ERROR', '搜索服务连接失败或返回格式无效，请稍后重试。', 502);
  } finally { clearTimeout(timer); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search') return search(request, env);
    if (url.pathname.startsWith('/api/')) return error('NOT_FOUND', '接口不存在。', 404);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (url.pathname === '/' || url.pathname === '/search') url.pathname = '/index.html';
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const response = new Response(asset.body, asset);
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  },
};
