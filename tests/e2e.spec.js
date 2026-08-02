import { test, expect } from '@playwright/test';

// E2E regression tests for duan-ortho.top
// Run: npm run e2e
// Uses random card numbers to avoid polluting production data.
// NOTE: check_duplicate_booking RPC may fail under headless/rate-limit,
//       so booking tests assert "no fake success" rather than "must succeed".

function randomCard() {
  let s = '131';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 10);
  return s;
}

test('patient page loads, calendar renders, no JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('h1')).toContainText('段医生正畸门诊');
  await expect(page.locator('.day-cell').first()).toBeVisible({ timeout: 20000 });
  expect(errors, 'JS errors: ' + errors.join('; ')).toEqual([]);
});

test('booking flow: either success modal or honest error, never fake success', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.day-cell').first()).toBeVisible({ timeout: 20000 });

  const day = page.locator('.day-cell:not(.no-schedule):not(.other-month)').first();
  await day.click();
  const slot = page.locator('.time-option').first();
  await slot.click();

  await page.fill('#patientName', 'E2E测试');
  await page.fill('#patientCard', randomCard());
  await page.fill('#patientAge', '25');

  await page.click('#submitBtn');

  // Wait for either outcome: success modal OR error toast
  const modal = page.locator('#successModal.active');
  const toast = page.locator('.toast');
  await Promise.race([
    modal.waitFor({ state: 'visible', timeout: 25000 }),
    toast.filter({ hasText: /校验失败|重试|出错/ }).waitFor({ state: 'visible', timeout: 25000 }),
  ]);

  const modalVisible = await modal.isVisible();
  if (modalVisible) {
    // Success path: must show voucher
    await expect(page.locator('#voucherContent')).toContainText('凭证号');
  } else {
    // Error path: toast must be honest (not fake success)
    await expect(toast).not.toContainText('预约成功');
  }
});

test('offline: shows validation failure toast, not fake success', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.day-cell').first()).toBeVisible({ timeout: 20000 });

  const day = page.locator('.day-cell:not(.no-schedule):not(.other-month)').first();
  await day.click();
  const slot = page.locator('.time-option').first();
  await slot.click();

  await page.fill('#patientName', 'E2E断网');
  await page.fill('#patientCard', randomCard());
  await page.fill('#patientAge', '30');

  await page.route('**/api/sb/**', (route) => route.abort());
  await page.click('#submitBtn');

  await expect(page.locator('.toast')).toContainText('校验失败', { timeout: 15000 });
  await expect(page.locator('#successModal.active')).not.toBeVisible();
});

test('submit button recovers after flow completes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.day-cell').first()).toBeVisible({ timeout: 20000 });

  const day = page.locator('.day-cell:not(.no-schedule):not(.other-month)').first();
  await day.click();
  const slot = page.locator('.time-option').first();
  await slot.click();

  await page.fill('#patientName', 'E2E恢复');
  await page.fill('#patientCard', randomCard());
  await page.fill('#patientAge', '28');

  const btn = page.locator('#submitBtn');
  await btn.click();

  // Wait for flow to finish: either modal or toast appears
  const modal = page.locator('#successModal.active');
  const toast = page.locator('.toast');
  await Promise.race([
    modal.waitFor({ state: 'visible', timeout: 25000 }),
    toast.filter({ hasText: /校验失败|重试|出错|成功/ }).waitFor({ state: 'visible', timeout: 25000 }),
  ]);

  // Button must be re-enabled after flow (finally block)
  await expect(btn).toBeEnabled({ timeout: 5000 });
  await expect(btn).toHaveText('确认预约');
});

test('admin staff page loads without JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin.html?staff=1&k=ZhouStaff2026%23ortho');
  await expect(page.locator('body')).toBeVisible();
  expect(errors, 'JS errors: ' + errors.join('; ')).toEqual([]);
});
