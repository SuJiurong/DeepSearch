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
