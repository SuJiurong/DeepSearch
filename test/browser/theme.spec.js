import { test, expect } from '@playwright/test';

async function expectTheme(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
  await expect(page.locator('html')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(32, 33, 36)' : 'rgb(255, 255, 255)');
}

for (const initial of ['light', 'dark']) {
  test(`first visit follows ${initial} system and responds live`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: initial });
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: '主题' })).toHaveValue('system');
    await expectTheme(page, initial);
    await page.emulateMedia({ colorScheme: initial === 'dark' ? 'light' : 'dark' });
    await expectTheme(page, initial === 'dark' ? 'light' : 'dark');
  });
}

test('manual choices persist across reloads and ignore system changes', async ({ page }) => {
  await page.goto('/');
  const select = page.getByRole('combobox', { name: '主题' });
  await expect(select.locator('option')).toHaveText(['浅色', '深色', '跟随系统']);
  for (const theme of ['dark', 'light']) {
    await select.selectOption(theme);
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await expectTheme(page, theme);
    await page.reload();
    await expect(select).toHaveValue(theme);
    await expectTheme(page, theme);
  }
  await select.selectOption('system');
  await page.reload();
  await expect(select).toHaveValue('system');
  await expectTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await select.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue('dark');
  await expectTheme(page, 'dark');
});

for (const storage of ['blocked', 'invalid']) {
  test(`${storage} storage falls back to system without breaking switching`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(mode => {
      if (mode === 'blocked') {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
      } else {
        localStorage.setItem('deepsearch-theme', 'invalid');
      }
    }, storage);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expectTheme(page, 'dark');
    await expect(page.getByRole('combobox', { name: '主题' })).toHaveValue('system');
    await page.getByRole('combobox', { name: '主题' }).selectOption('light');
    await expectTheme(page, 'light');
    expect(errors).toEqual([]);
  });
}

test('stored theme applies before first paint under the real CSP', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('deepsearch-theme', 'light');
    window.themeViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.themeViolations.push(event.blockedURI));
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/style.css', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await page.evaluate(() => performance.getEntriesByType('paint').length)).toBe(0);
  } finally { release(); }
  await page.waitForLoadState('load');
  await expectTheme(page, 'light');
  expect(await page.evaluate(() => window.themeViolations)).toEqual([]);
});

test('mobile home and results keep search width and theme-aware components', async ({ page }) => {
  await page.route('https://example.com/**', route => route.abort());
  await page.route('**/api/search?*', route => route.fulfill({ json: { results: [
    { title: 'Theme result', snippet: 'Theme example', url: 'https://example.com/' },
  ] } }));
  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/search?q=Theme']) {
      await page.goto(path);
      const before = await page.locator('#query').boundingBox();
      for (const theme of ['light', 'dark']) {
        const select = page.getByRole('combobox', { name: '主题' });
        await select.selectOption(theme);
        await expectTheme(page, theme);
        await expect(select).toBeVisible();
        const after = await page.locator('#query').boundingBox();
        expect(after.width).toBe(before.width);
        expect(after.width).toBeGreaterThan(100);
        expect((await select.boundingBox()).y + (await select.boundingBox()).height).toBeLessThanOrEqual(after.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(select).toHaveCSS('color', theme === 'dark' ? 'rgb(232, 234, 237)' : 'rgb(32, 33, 36)');
        if (path !== '/') {
          await expect(page.locator('.favicon')).toHaveCount(0);
          await expect(page.locator('.site-icon')).toHaveText('E');
          await expect(page.locator('.site-icon')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(48, 49, 52)' : 'rgb(241, 243, 244)');
          await expect(page.locator('.result p mark')).toHaveCSS('color', theme === 'dark' ? 'rgb(253, 214, 99)' : 'rgb(138, 73, 0)');
        }
      }
    }
  }
});
