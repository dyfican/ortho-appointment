import { test, expect } from '@playwright/test';

// 本文件为段医生本机回归自验脚本。
// 运行前（仅需一次）：npm install && npx playwright install chromium
// 运行：npm run e2e
// 也可指定地址：BASE_URL=https://a2ea5fb34....app.codebuddy.work npm run e2e

test('患者填表成功路径：提交后显示「预约成功」', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('text=段医生正畸门诊预约')).toBeVisible();

  // 选第一个可约日期
  const day = page.locator('.calendar-day:not(.disabled)').first();
  await day.click();
  // 选第一个时段
  const slot = page.locator('.time-option').first();
  await slot.click();

  await page.fill('#patientName', '测试患者');
  await page.fill('#patientCard', '131123456789012');
  await page.fill('#patientAge', '20');

  await page.click('button.btn-primary:has-text("确认预约")');

  // 断言：成功弹窗出现，且含「预约成功」而非假成功
  await expect(page.locator('#successModal.active')).toBeVisible();
  await expect(page.locator('#voucherContent')).toContainText('预约成功');
});

test('失败路径：接口异常不再假成功，提示暂存本机+重试', async ({ page }) => {
  // 拦截 Supabase 写接口与 RPC，模拟断网/500
  await page.route('**/rest/v1/appointments**', (route) => route.abort());
  await page.route('**/rpc/**', (route) => route.abort());

  await page.goto('/');
  const day = page.locator('.calendar-day:not(.disabled)').first();
  await day.click();
  const slot = page.locator('.time-option').first();
  await slot.click();

  await page.fill('#patientName', '测试患者');
  await page.fill('#patientCard', '131123456789012');
  await page.fill('#patientAge', '20');

  await page.click('button.btn-primary:has-text("确认预约")');

  // 断言：出现「重试同步」按钮（离线兜底），且不应显示纯「预约成功」假成功
  await expect(page.locator('button:has-text("重试同步")')).toBeVisible({ timeout: 12000 });
  await expect(page.locator('#voucherContent')).toContainText('暂存本机');
});

test('提交按钮防连点：点击后进入「提交中…」禁用态', async ({ page }) => {
  await page.goto('/');
  const day = page.locator('.calendar-day:not(.disabled)').first();
  await day.click();
  const slot = page.locator('.time-option').first();
  await slot.click();
  await page.fill('#patientName', '测试患者');
  await page.fill('#patientCard', '131123456789012');
  await page.fill('#patientAge', '20');

  const btn = page.locator('button.btn-primary:has-text("确认预约")');
  await btn.click();
  // 提交瞬间按钮应被禁用（loading 态）
  await expect(btn).toBeDisabled();
  // 等待流程结束恢复
  await expect(btn).toBeEnabled({ timeout: 15000 });
});

test('医生端 staff 页面可加载、无脚本错误', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin.html?staff=1&k=ZhouStaff2026%23ortho');
  await expect(page.locator('body')).toBeVisible();
  expect(errors, '页面不应有 JS 运行时错误：' + errors.join('; ')).toEqual([]);
});

// 备注：医生端 staff 勾选 -> 30s 同步 的端到端验证依赖真实 Supabase 数据与两个浏览器上下文，
// 建议在真机双窗口手动验收（A 勾选 -> B 30s 内自动出现）。如要做自动化，需注入测试账号与已知 checklist id。
