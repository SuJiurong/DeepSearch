import { test, expect } from '@playwright/test';

const names = { light: '浅色', dark: '深色', system: '跟随系统' };
const choice = (page, theme) => page.getByRole('button', { name: names[theme], exact: true });

async function expectSelected(page, theme) {
  for (const value of Object.keys(names)) {
    await expect(choice(page, value)).toHaveAttribute('aria-pressed', String(value === theme));
    await expect(choice(page, value)).toBeVisible();
    await expect(choice(page, value)).toHaveAttribute('title', names[value]);
  }
}

async function expectTheme(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
  await expect(page.locator('html')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(32, 33, 36)' : 'rgb(255, 255, 255)');
}

for (const initial of ['light', 'dark']) {
  test(`first visit follows ${initial} system and responds live`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: initial });
    await page.goto('/');
    await expectSelected(page, 'system');
    await expectTheme(page, initial);
    await page.emulateMedia({ colorScheme: initial === 'dark' ? 'light' : 'dark' });
    await expectTheme(page, initial === 'dark' ? 'light' : 'dark');
  });
}

test('manual choices persist across reloads and ignore system changes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('group', { name: '主题' }).getByRole('button')).toHaveCount(3);
  for (const theme of ['dark', 'light']) {
    await choice(page, theme).click();
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await expectTheme(page, theme);
    await page.reload();
    await expectSelected(page, theme);
    await expectTheme(page, theme);
  }
  await choice(page, 'system').click();
  await page.reload();
  await expectSelected(page, 'system');
  await expectTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');

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
    await expectSelected(page, 'system');
    await choice(page, 'light').click();
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
        const picker = page.getByRole('group', { name: '主题' });
        await choice(page, theme).click();
        await expectTheme(page, theme);
        await expectSelected(page, theme);
        const after = await page.locator('#query').boundingBox();
        expect(after.width).toBe(before.width);
        expect(after.width).toBeGreaterThan(100);
        expect((await picker.boundingBox()).y + (await picker.boundingBox()).height).toBeLessThanOrEqual(after.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(picker).toHaveCSS('color', theme === 'dark' ? 'rgb(232, 234, 237)' : 'rgb(32, 33, 36)');
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


test('native keyboard activation, focus and selection stay in sync', async ({ page }) => {
  await page.goto('/');
  await choice(page, 'light').focus();
  for (const [theme, key] of [['light', 'Space'], ['dark', 'Enter'], ['system', 'Space']]) {
    const button = choice(page, theme);
    await expect(button).toBeFocused();
    expect(await button.evaluate(el => el.matches(':focus-visible'))).toBe(true);
    await expect(button).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press(key);
    await expectSelected(page, theme);
    expect(await page.evaluate(() => localStorage.getItem('deepsearch-theme'))).toBe(theme);
    if (theme !== 'system') await page.keyboard.press('Tab');
  }
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`selection surface moves and respects ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/');
    const picker = page.getByRole('group', { name: '主题' });
    const surface = () => picker.evaluate(el => {
      const style = getComputedStyle(el, '::before');
      return { transform: style.transform, duration: style.transitionDuration };
    });
    expect((await surface()).duration).toBe('0s');
    for (const [theme, offset] of [['light', 0], ['dark', 40], ['system', 80]]) {
      await choice(page, theme).click();
      await expectSelected(page, theme);
      await expect.poll(async () => (await surface()).transform).toBe(`matrix(1, 0, 0, 1, ${offset}, 0)`);
      const duration = (await surface()).duration;
      if (reducedMotion === 'reduce') {
        expect(duration).toBe('0s');
        await expect(choice(page, theme).locator('svg')).toHaveCSS('transition-duration', '0s');
      } else {
        expect(duration).toContain('0.28s');
      }
    }
  });
}
