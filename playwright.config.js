import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 15000 },
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || 'https://duan-ortho.top',
    headless: true,
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
