import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  outputDir: './.wrangler/browser-results',
  use: { baseURL: 'http://127.0.0.1:8788', headless: true },
  webServer: {
    command: 'npm run dev -- --port 8788 --var DEEPSEEK_API_KEY:',
    url: 'http://127.0.0.1:8788',
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
  },
});
