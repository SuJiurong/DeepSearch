const form = document.querySelector('#search-form');
const input = document.querySelector('#query');
const area = document.querySelector('#results-area');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const retry = document.querySelector('#retry');
let active;

async function render() {
  active?.abort();
  const controller = new AbortController();
  active = controller;
  const query = new URL(location.href).searchParams.get('q') ?? '';
  input.value = query;
  const showing = location.pathname === '/search' || query.length > 0;
  document.body.classList.toggle('results-mode', showing);
  area.hidden = !showing;
  results.replaceChildren();
  retry.hidden = true;
  status.className = '';
  area.setAttribute('aria-busy', 'false');
  document.title = showing ? `${query || '搜索'} - DeepSearch` : 'DeepSearch · 发现值得探索的答案';
  if (!showing) return;
  if (!query.trim() || [...query.trim()].length > 128) {
    status.textContent = '请输入 1–128 个字符的搜索内容。';
    status.className = 'error';
    return;
  }
  status.textContent = '正在搜索网页…';
  status.className = 'loading';
  area.setAttribute('aria-busy', 'true');
  const timer = setTimeout(() => controller.abort('timeout'), 15000);
  try {
    const response = await fetch(`/api/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '搜索失败，请稍后重试。');
    if (active !== controller) return;
    status.className = '';
    status.textContent = data.results.length ? `本次返回 ${data.results.length} 条结果` : '没有找到相关网页，试试更简短的关键词或不同的表达。';
    if (data.source === 'mock') status.textContent = `本地 Mock 测试数据 · ${status.textContent}`;
    for (const item of data.results) {
      const article = document.createElement('article');
      article.className = 'result';
      const link = document.createElement('a');
      link.href = item.url;
      link.rel = 'noreferrer';
      const url = document.createElement('span');
      url.className = 'result-url';
      url.textContent = item.url;
      const title = document.createElement('h2');
      title.textContent = item.title || item.url;
      const snippet = document.createElement('p');
      snippet.textContent = item.snippet;
      link.append(url, title);
      article.append(link, snippet);
      results.append(article);
    }
  } catch (error) {
    if (active !== controller) return;
    status.className = 'error';
    status.textContent = controller.signal.aborted ? '搜索请求超时，请重试。' : error.message;
    retry.hidden = false;
  } finally {
    clearTimeout(timer);
    if (active === controller) area.setAttribute('aria-busy', 'false');
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  const url = new URL(location.href);
  url.pathname = '/search';
  url.searchParams.set('q', input.value.trim());
  history.pushState({}, '', url);
  render();
});
retry.addEventListener('click', render);
window.addEventListener('popstate', render);
render();
