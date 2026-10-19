const form = document.querySelector('#search-form');
const input = document.querySelector('#query');
const area = document.querySelector('#results-area');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const retry = document.querySelector('#retry');
const pagination = document.querySelector('#pagination');
const relatedImages = document.querySelector('#related-images');
const layout = document.querySelector('.results-layout');
const PAGE_SIZE = 10;
const MAX_RESULTS = 50;
// Keep fulfilled and in-flight queries for this document only. Refresh starts anew.
const searches = new Map();
let revision = 0;

function search(query) {
  if (!searches.has(query)) {
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: query, count: String(MAX_RESULTS) })}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || '搜索失败，请稍后重试。');
        return { ...data, results: data.results.slice(0, MAX_RESULTS) };
      } catch (error) {
        searches.delete(query);
        throw new Error(controller.signal.aborted ? '搜索请求超时，请重试。' : error.message);
      } finally { clearTimeout(timer); }
    })();
    searches.set(query, promise);
  }
  return searches.get(query);
}

// Render matches as text nodes; upstream text is never interpreted as HTML.
function highlight(node, text, query) {
  const terms = [...new Set((query.match(/[\p{L}\p{N}]+/gu) || []).filter(term => !['site', 'filetype'].includes(term.toLowerCase())))];
  if (!terms.length) { node.textContent = text; return; }
  const pattern = new RegExp(terms.sort((a, b) => b.length - a.length).join('|'), 'giu');
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(document.createTextNode(text.slice(end, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    node.append(mark);
    end = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(end)));
}

function imageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function image(src, className, onError) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => { img.remove(); onError?.(); }, { once: true });
  img.src = src;
  return img;
}

function breadcrumb(address) {
  const parts = address.pathname.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return [address.hostname, ...parts].join(' › ');
}

function renderImages(items) {
  const seen = new Set();
  const images = items.filter(item => {
    const src = imageURL(item.thumbnail);
    if (!src || seen.has(src)) return false;
    seen.add(src);
    return true;
  }).slice(0, 6);
  if (images.length < 2) return;
  const heading = document.createElement('h2');
  heading.textContent = '结果中的图片';
  const grid = document.createElement('div');
  grid.className = 'image-grid';
  const update = () => {
    const visible = grid.childElementCount >= 2;
    relatedImages.hidden = !visible;
    layout.classList.toggle('has-sidebar', visible);
  };
  for (const item of images) {
    const link = document.createElement('a');
    link.href = item.url;
    link.rel = 'noreferrer';
    link.setAttribute('aria-label', item.title || item.url);
    link.append(image(item.thumbnail, 'related-thumbnail', () => { link.remove(); update(); }));
    grid.append(link);
  }
  relatedImages.append(heading, grid);
  update();
}

function pageURL(page) {
  const url = new URL(location.href);
  url.searchParams.set('page', String(page));
  return url;
}

function navigate(url) {
  history.pushState({}, '', url);
  render();
  window.scrollTo(0, 0);
}

function renderPagination(current, total) {
  pagination.hidden = total <= 1;
  const add = (page, label, ariaLabel) => {
    const link = document.createElement('a');
    link.href = pageURL(page).href;
    link.textContent = label;
    link.setAttribute('aria-label', ariaLabel);
    if (page === current) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (page !== current) navigate(link.href);
    });
    pagination.append(link);
  };
  if (current > 1) add(current - 1, '上一页', '上一页');
  for (let page = 1; page <= total; page++) add(page, String(page), `第 ${page} 页`);
  if (current < total) add(current + 1, '下一页', '下一页');
}

async function render() {
  const currentRevision = ++revision;
  const url = new URL(location.href);
  const query = (url.searchParams.get('q') ?? '').trim();
  input.value = query;
  const showing = location.pathname === '/search' || query.length > 0;
  document.body.classList.toggle('results-mode', showing);
  area.hidden = !showing;
  results.replaceChildren();
  relatedImages.replaceChildren();
  relatedImages.hidden = true;
  layout.classList.remove('has-sidebar');
  pagination.replaceChildren();
  pagination.hidden = true;
  retry.hidden = true;
  status.className = '';
  area.setAttribute('aria-busy', 'false');
  document.title = showing ? `${query || '搜索'} - DeepSearch` : 'DeepSearch · 发现值得探索的答案';
  if (!showing) return;
  if (!query || [...query].length > 128) {
    status.textContent = '请输入 1–128 个字符的搜索内容。';
    status.className = 'error';
    return;
  }
  status.textContent = '正在搜索网页…';
  status.className = 'loading';
  area.setAttribute('aria-busy', 'true');
  try {
    const data = await search(query);
    if (revision !== currentRevision) return;
    const total = Math.ceil(data.results.length / PAGE_SIZE);
    const rawPage = url.searchParams.get('page') ?? '1';
    const requested = /^[1-9]\d*$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) ? Number(rawPage) : 1;
    const page = Math.min(requested, Math.max(total, 1));
    if (url.searchParams.getAll('page').length !== 1 || rawPage !== String(page)) {
      history.replaceState({}, '', pageURL(page));
    }
    const start = (page - 1) * PAGE_SIZE;
    status.className = '';
    status.textContent = data.results.length
      ? ''
      : '没有找到相关网页，试试更简短的关键词或不同的表达。';
    if (data.source === 'mock') status.textContent = ['本地 Mock 测试数据', status.textContent].filter(Boolean).join(' · ');
    for (const item of data.results.slice(start, start + PAGE_SIZE)) {
      const article = document.createElement('article');
      article.className = 'result';
      const link = document.createElement('a');
      link.href = item.url;
      link.rel = 'noreferrer';
      const address = new URL(item.url);
      const identity = document.createElement('span');
      identity.className = 'result-identity';
      const icon = document.createElement('span');
      icon.className = 'site-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = address.hostname.replace(/^www\./, '').slice(0, 1).toUpperCase();
      const siteIcon = `https://${address.host}/favicon.ico`;
      const suppliedIcon = imageURL(item.favicon);
      const loadSiteIcon = () => icon.append(image(siteIcon, 'favicon'));
      if (suppliedIcon && suppliedIcon !== siteIcon) {
        icon.append(image(suppliedIcon, 'favicon', loadSiteIcon));
      } else {
        loadSiteIcon();
      }
      const details = document.createElement('span');
      details.className = 'site-details';
      const site = document.createElement('span');
      site.className = 'result-site';
      site.textContent = item.site_name || address.hostname.replace(/^www\./, '');
      const path = document.createElement('span');
      path.className = 'result-url';
      path.textContent = breadcrumb(address);
      path.title = item.url;
      details.append(site, path);
      identity.append(icon, details);
      const title = document.createElement('h2');
      highlight(title, item.title || item.url, query);
      const snippet = document.createElement('p');
      highlight(snippet, item.snippet, query);
      link.append(identity, title);
      const text = document.createElement('div');
      text.className = 'result-text';
      text.append(link, snippet);
      article.append(text);
      const thumbnail = imageURL(item.thumbnail);
      if (thumbnail) article.append(image(thumbnail, 'result-thumbnail'));
      results.append(article);
    }
    renderImages(data.results.slice(start, start + PAGE_SIZE));
    renderPagination(page, total);
  } catch (error) {
    if (revision !== currentRevision) return;
    status.className = 'error';
    status.textContent = error.message;
    retry.hidden = false;
  } finally {
    if (revision === currentRevision) area.setAttribute('aria-busy', 'false');
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  const url = new URL(location.href);
  url.pathname = '/search';
  url.searchParams.set('q', input.value.trim());
  url.searchParams.set('page', '1');
  navigate(url);
});
retry.addEventListener('click', render);
window.addEventListener('popstate', render);
render();
