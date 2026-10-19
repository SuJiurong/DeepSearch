import { test, expect } from '@playwright/test';

// Browser-only mock responses test rendering. The HTTP adapter is tested separately.
async function mockSearch(page) {
  await page.route('**/api/search?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
    if (query === 'error') {
      await route.fulfill({ status: 502, json: { error: { message: 'Mock 上游暂时不可用' } } });
      return;
    }
    await route.fulfill({ json: { query, source: 'mock', results: query === 'empty' ? [] : [
      { title: `<img src=x onerror=alert(1)> ${query}`, url: 'https://example.com/', snippet: '明确标注的浏览器 mock 摘要' },
    ] } });
  });
}

test('home, Enter submission, URL, safe titles, refresh and browser history', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/');
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.locator('#results-area')).toBeHidden();
  await page.locator('#query').fill('Cloudflare site:example.com');
  await page.locator('#query').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=Cloudflare/);
  await expect(page.locator('#status')).toContainText('本地 Mock 测试数据');
  await expect(page.locator('.result h2')).toHaveText('<img src=x onerror=alert(1)> Cloudflare site:example.com');
  await expect(page.locator('.result h2 img')).toHaveCount(0);
  await expect(page.locator('.result a')).toHaveAttribute('href', 'https://example.com/');
  await page.reload();
  await expect(page.locator('#query')).toHaveValue('Cloudflare site:example.com');
  await page.goBack();
  await expect(page.locator('#results-area')).toBeHidden();
  await page.goForward();
  await expect(page.locator('.result')).toHaveCount(1);
});

test('loading, empty, error and retry states', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search?q=slow');
  await expect(page.locator('#status')).toHaveText('正在搜索网页…');
  await expect(page.locator('.result')).toHaveCount(1);
  await page.goto('/search?q=empty');
  await expect(page.locator('#status')).toContainText('没有找到相关网页');
  await expect(page.locator('.result')).toHaveCount(0);
  await page.goto('/search?q=error');
  await expect(page.locator('#status')).toHaveText('Mock 上游暂时不可用');
  await expect(page.locator('#retry')).toBeVisible();
  await page.locator('#retry').click();
  await expect(page.locator('#status')).toHaveText('Mock 上游暂时不可用');
});

test('new query cancels old query and preserves other URL parameters', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search?q=slow&theme=test');
  await expect(page.locator('#status')).toHaveText('正在搜索网页…');
  await page.locator('#query').fill('new');
  await page.locator('#query').press('Enter');
  await expect(page.locator('.result h2')).toContainText('new');
  await expect(page).toHaveURL(/theme=test/);
  await page.waitForTimeout(800);
  await expect(page.locator('.result h2')).toContainText('new');
});

test('mobile home and results have no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSearch(page);
  for (const path of ['/', '/search?q=mobile']) {
    await page.goto(path);
    await expect(page.locator('#query')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('real Worker missing configuration is visible as an actionable error', async ({ page }) => {
  await page.goto('/search?q=test');
  await expect(page.locator('#status')).toContainText('搜索服务尚未配置');
  await expect(page.locator('#retry')).toBeVisible();
});

async function pagedMock(page, count = 23) {
  const calls = [];
  await page.route('**/api/search?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    calls.push(params.get('q'));
    expect(params.get('count')).toBe('50');
    expect([...params.keys()].sort()).toEqual(['count', 'q']);
    await route.fulfill({ json: { source: 'mock', results: Array.from({ length: count }, (_, i) => ({
      title: `Result ${i + 1}`, url: `https://example.com/docs/${i + 1}?long=${'a'.repeat(150)}`,
      snippet: `Mock result ${i + 1} — 这是用于验证分页与窄屏布局的测试摘要。`.repeat(3),
    })) } });
  });
  return calls;
}

test('23 results: pages, final page, history, query reset, cache and refresh', async ({ page }) => {
  const calls = await pagedMock(page);
  await page.goto('/search?q=alpha');
  await expect(page.locator('.result')).toHaveCount(10);
  await expect(page.locator('#status')).toHaveText('本地 Mock 测试数据');
  await expect(page.getByRole('navigation', { name: '搜索结果分页' })).toBeVisible();
  await expect(page.locator('#pagination [aria-current=page]')).toHaveAttribute('aria-label', '第 1 页');
  await page.getByRole('link', { name: '第 2 页', exact: true }).click();
  await expect(page.locator('.result h2').first()).toHaveText('Result 11');
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('link', { name: '下一页', exact: true }).click();
  await expect(page.locator('.result')).toHaveCount(3);
  await expect(page.locator('#pagination [aria-current=page]')).toHaveAttribute('aria-label', '第 3 页');
  await expect(page.getByRole('link', { name: '下一页', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.result h2').first()).toHaveText('Result 11');
  await page.goForward();
  await expect(page.locator('.result')).toHaveCount(3);
  expect(calls).toEqual(['alpha']);
  await page.locator('#query').fill('beta');
  await page.locator('#query').press('Enter');
  await expect(page).toHaveURL(/q=beta&page=1/);
  await expect(page.locator('.result h2').first()).toHaveText('Result 1');
  await page.goBack();
  await expect(page.locator('.result')).toHaveCount(3);
  expect(calls).toEqual(['alpha', 'beta']);
  await page.reload();
  await expect(page.locator('.result')).toHaveCount(3);
  expect(calls).toEqual(['alpha', 'beta', 'alpha']);
});

test('invalid page values, short and empty results do not invent pages', async ({ page }) => {
  await pagedMock(page, 7);
  for (const value of ['0', '-1', '1.5', 'oops', '999', '9007199254740992', '2&page=3']) {
    await page.goto(`/search?q=short&page=${value}`);
    await expect(page.locator('.result')).toHaveCount(7);
    await expect(page).toHaveURL(/page=1$/);
    await expect(page.locator('#pagination')).toBeHidden();
  }
  await page.unroute('**/api/search?*');
  await pagedMock(page, 0);
  await page.goto('/search?q=empty&page=9');
  await expect(page.locator('#status')).toContainText('没有找到相关网页');
  await expect(page).toHaveURL(/page=1$/);
  await expect(page.locator('#pagination')).toBeHidden();
});

test('50 results have exactly five pages and narrow screens do not overflow', async ({ page }) => {
  const calls = await pagedMock(page, 50);
  await page.goto('/search?q=full&page=99');
  await expect(page).toHaveURL(/page=5$/);
  await expect(page.locator('.result')).toHaveCount(10);
  await expect(page.locator('.result h2').first()).toHaveText('Result 41');
  await expect(page.locator('#pagination [aria-current=page]')).toHaveText('5');
  await expect(page.locator('body')).not.toContainText('本次返回');
  await expect(page.locator('body')).not.toContainText('显示 41–50 条');
  await expect(page.locator('body')).not.toContainText('每次搜索最多获取');
  await expect(page.locator('body')).not.toContainText('当前接口不支持继续获取后续结果');
  await expect(page.locator('.results-limit')).toHaveCount(0);
  for (const width of [320, 390, 700, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('link', { name: '第 3 页', exact: true }).click();
  await expect(page.locator('.result h2').first()).toHaveText('Result 21');
  expect(calls).toEqual(['full']);
  await expect(page.locator('.result-site').first()).toHaveText('example.com');
  await expect(page.locator('.result h2 img')).toHaveCount(0);
});

test('returning to an in-flight query reuses its request', async ({ page }) => {
  const calls = [];
  await page.route('**/api/search?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    calls.push(query);
    if (query === 'alpha') await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ json: { source: 'mock', results: [{ title: query, url: 'https://example.com/', snippet: 'mock' }] } });
  });
  await page.goto('/search?q=alpha');
  await expect(page.locator('#status')).toHaveText('正在搜索网页…');
  await page.locator('#query').fill('beta');
  await page.locator('#query').press('Enter');
  await expect(page.locator('.result h2')).toHaveText('beta');
  await page.goBack();
  await expect(page.locator('.result h2')).toHaveText('alpha');
  expect(calls).toEqual(['alpha', 'beta']);
});

test('centered results, safe bilingual highlighting and favicon failure fallback', async ({ page }) => {
  await page.route('https://example.com/**', route => route.abort());
  await page.route('**/api/search?*', route => route.fulfill({ json: { results: [
    { title: '中文 Search <script>alert(1)</script>', url: 'https://example.com/docs/%E4%B8%AD%E6%96%87?secret=hidden', snippet: '中文 search SEARCH and C++' },
  ] } }));
  await page.goto('/search?q=中文+search');
  await expect(page.locator('.result p mark')).toHaveText(['中文', 'search', 'SEARCH']);
  await expect(page.locator('.result h2 script')).toHaveCount(0);
  await expect(page.locator('.favicon')).toHaveCount(0);
  await expect(page.locator('.site-icon')).toHaveText('E');
  await expect(page.locator('.result-url')).toHaveText('example.com › docs › 中文');
  for (const width of [320, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator('#results-area').boundingBox();
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(1);
    expect(box.width).toBeLessThanOrEqual(720);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('.result p mark').first()).toBeVisible();
    const colors = await page.locator('.result p mark').first().evaluate(el => ({ text: getComputedStyle(el).color, bg: getComputedStyle(document.documentElement).backgroundColor }));
    expect(colors.text).not.toBe(colors.bg);
  }
});

const siteIcon = 'https://example.com/favicon.ico';
const apiIcon = 'https://example.com/api-icon.svg';
for (const [index, scenario] of [
    { favicon: apiIcon, failed: [], requests: [apiIcon], shown: apiIcon },
    { favicon: undefined, failed: [], requests: [siteIcon], shown: siteIcon },
    { favicon: apiIcon, failed: [apiIcon], requests: [apiIcon, siteIcon], shown: siteIcon },
    { favicon: apiIcon, failed: [apiIcon, siteIcon], requests: [apiIcon, siteIcon] },
    { favicon: siteIcon, failed: [siteIcon], requests: [siteIcon] },
    { favicon: 'javascript:alert(1)', failed: [], requests: [siteIcon], shown: siteIcon },
  ].entries()) {
  test(`favicon fallback scenario ${index + 1}`, async ({ page }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>';
    const requests = [];
    // Playwright's route API bypasses /favicon.ico; CDP intercepts the real URL.
    const session = await page.context().newCDPSession(page);
    await session.send('Fetch.enable', { patterns: [
      { urlPattern: 'https://example.com/*' },
      { urlPattern: '*/api/search?*' },
    ] });
    session.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const isIcon = request.url.startsWith('https://example.com/');
      if (isIcon) requests.push(request.url);
      if (isIcon && scenario.failed.includes(request.url)) {
        await session.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        return;
      }
      const body = isIcon ? svg : JSON.stringify({ results: [
        { title: 'Example', url: 'https://example.com/nested/page', snippet: '', favicon: scenario.favicon },
      ] });
      await session.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: isIcon ? 'image/svg+xml' : 'application/json' }],
        body: Buffer.from(body).toString('base64'),
      });
    });
    await page.goto('/search?q=icons');
    await expect(page.locator('.result')).toHaveCount(1);
    if (scenario.shown) {
      await expect(page.locator('.favicon')).toHaveAttribute('src', scenario.shown);
      await expect.poll(() => page.locator('.favicon').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    } else {
      await expect(page.locator('.favicon')).toHaveCount(0);
      await expect(page.locator('.site-icon')).toHaveText('E');
    }
    expect(requests).toEqual(scenario.requests);
    await expect(page.locator('#status')).toBeEmpty();
  });
}

test('actual thumbnail fields create responsive image sidebar and failures collapse it', async ({ page }) => {
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>' }));
  await page.route('**/api/search?*', route => route.fulfill({ json: { results: [1, 2].map(i => ({ title: `Image ${i}`, url: `https://example.com/${i}`, snippet: 'Image result', thumbnail: `https://example.com/${i}.svg` })) } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/search?q=image');
  await expect(page.locator('#related-images')).toBeVisible();
  await expect(page.locator('.result-thumbnail')).toHaveCount(2);
  expect(await page.locator('.result-thumbnail').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const main = await page.locator('#results-area').boundingBox();
  const side = await page.locator('#related-images').boundingBox();
  expect(side.x).toBeGreaterThan(main.x + main.width);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowMain = await page.locator('#results-area').boundingBox();
  const narrowSide = await page.locator('#related-images').boundingBox();
  expect(narrowSide.y).toBeGreaterThanOrEqual(narrowMain.y + narrowMain.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.related-thumbnail').first().dispatchEvent('error');
  await expect(page.locator('#related-images')).toBeHidden();
  await page.locator('.result-thumbnail').first().dispatchEvent('error');
  await expect(page.locator('.result-thumbnail')).toHaveCount(1);
  await expect(page.locator('.results-layout')).not.toHaveClass(/has-sidebar/);
});
