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
  await expect(page.locator('.result img')).toHaveCount(0);
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
  await expect(page.locator('#status')).toContainText('本次返回 23 条结果');
  await page.getByRole('link', { name: '第 2 页', exact: true }).click();
  await expect(page.locator('.result h2').first()).toHaveText('Result 11');
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('link', { name: '下一页', exact: true }).click();
  await expect(page.locator('.result')).toHaveCount(3);
  await expect(page.locator('#status')).toContainText('显示 21–23 条');
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
  for (const width of [320, 390, 700, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('link', { name: '第 3 页', exact: true }).click();
  await expect(page.locator('.result h2').first()).toHaveText('Result 21');
  expect(calls).toEqual(['full']);
  await expect(page.locator('.result-site').first()).toHaveText('example.com');
  await expect(page.locator('.result img')).toHaveCount(0);
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
