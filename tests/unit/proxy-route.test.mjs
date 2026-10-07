// 代理路由级测试（v3）：验证 [[path]].js 的 advance_workflow 鉴权、workflow_stage 旁路拦截、staff 剥壳
// 运行：node --test tests/unit/proxy-route.test.mjs
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../../functions/api/sb/[[path]].js';

const ENV = { ADMIN_KEY: 'admin-1', STAFF_KEY: 'staff-1', SUPABASE_URL: 'https://db.example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon-test' };

function makeHeaders(h = {}) {
  const map = {};
  for (const [k, v] of Object.entries(h)) map[k.toLowerCase()] = v;
  return { get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) };
}

function makeReq({ method = 'GET', url = 'https://x/api/sb/appointments?select=*', headers = {}, body }) {
  const text = body ? JSON.stringify(body) : '';
  return { method, url, headers: makeHeaders(headers), body: body ? JSON.stringify(body) : null, json: async () => (body || {}), text: async () => text };
}

async function call(method, url, opts = {}) {
  const req = makeReq({ method, url, headers: opts.headers || {}, body: opts.body });
  const ctx = { request: req, env: ENV, params: { path: [opts.table || 'appointments'] } };
  return onRequest(ctx);
}

describe('advance_workflow 路由', () => {
  test('无 key → 401', async () => {
    const r = await call('POST', 'https://x/api/sb/advance_workflow', { table: 'advance_workflow' });
    assert.equal(r.status, 401);
  });
  test('admin POST → 转发 RPC 且注入 role=admin', async () => {
    let called = null;
    mock.method(globalThis, 'fetch', async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ ok: true, stage: 'check_done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await call('POST', 'https://x/api/sb/advance_workflow', { table: 'advance_workflow', headers: { 'x-admin-key': 'admin-1' }, body: { patient_card: 'C1', target_stage: 'check_done' } });
    assert.equal(r.status, 200);
    assert.ok(called.url.includes('/rest/v1/rpc/advance_workflow'), called.url);
    assert.deepEqual(JSON.parse(called.init.body), { patient_card: 'C1', target_stage: 'check_done', p_role: 'admin' });
    mock.restoreAll();
  });
  test('staff POST → 转发 RPC 且注入 role=staff（保留部分推进权）', async () => {
    let called = null;
    mock.method(globalThis, 'fetch', async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ ok: true, stage: 'plan_done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await call('POST', 'https://x/api/sb/advance_workflow', { table: 'advance_workflow', headers: { 'x-staff-key': 'staff-1' }, body: { patient_card: 'C1', target_stage: 'plan_done' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(called.init.body), { patient_card: 'C1', target_stage: 'plan_done', p_role: 'staff' });
    mock.restoreAll();
  });
  test('GET → 405（仅 POST）', async () => {
    const r = await call('GET', 'https://x/api/sb/advance_workflow', { table: 'advance_workflow', headers: { 'x-admin-key': 'admin-1' } });
    assert.equal(r.status, 405);
  });
});

describe('workflow_stage 旁路拦截（v3）', () => {
  test('admin PATCH checklists 带 workflow_stage → 400', async () => {
    const r = await call('PATCH', 'https://x/api/sb/checklists?patient_card=eq.C1', { table: 'checklists', headers: { 'x-admin-key': 'admin-1' }, body: { workflow_stage: 'check_done' } });
    assert.equal(r.status, 400);
  });
  test('staff PATCH checklists 只带 workflow_stage → 400（剥壳为空）', async () => {
    const r = await call('PATCH', 'https://x/api/sb/checklists?patient_card=eq.C1', { table: 'checklists', headers: { 'x-staff-key': 'staff-1' }, body: { workflow_stage: 'check_done' } });
    assert.equal(r.status, 400);
  });
  test('staff PATCH checklists 带合法字段 → 放行（转发剥壳后 body）', async () => {
    let sentBody = null;
    mock.method(globalThis, 'fetch', async (url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await call('PATCH', 'https://x/api/sb/checklists?patient_card=eq.C1', { table: 'checklists', headers: { 'x-staff-key': 'staff-1' }, body: { sent: true, patient_card: 'EVIL' } });
    assert.equal(r.status, 200);
    assert.deepEqual(sentBody, { sent: true });
    mock.restoreAll();
  });
  test('admin PATCH checklists 无 workflow_stage → 正常转发', async () => {
    let sentBody = null;
    mock.method(globalThis, 'fetch', async (url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await call('PATCH', 'https://x/api/sb/checklists?patient_card=eq.C1', { table: 'checklists', headers: { 'x-admin-key': 'admin-1' }, body: { sent: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(sentBody, { sent: true });
    mock.restoreAll();
  });
});

describe('患者匿名通道（中转代理）', () => {
  function captureFetch() {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, init });
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  }
  async function callP(method, path, opts = {}) {
    const req = makeReq({ method, url: 'https://x/api/sb/' + path, headers: opts.headers || {}, body: opts.body });
    const segs = path.split('?')[0].split('/');
    return onRequest({ request: req, env: ENV, params: { path: segs } });
  }
  test('白名单表 GET → 用 anon key 转发（绝不带 service_role）', async () => {
    const calls = captureFetch();
    const r = await callP('GET', 'holidays?select=date');
    assert.equal(r.status, 200);
    assert.ok(calls[0].url.startsWith('https://db.example.supabase.co/rest/v1/holidays'));
    assert.equal(calls[0].init.headers.get('apikey'), 'anon-test');
    mock.restoreAll();
  });
  test('appointments POST → 放行且 anon key 转发（RLS 兜底）', async () => {
    const calls = captureFetch();
    const r = await callP('POST', 'appointments', { body: { patient_name: 'x' } });
    assert.equal(r.status, 200);
    assert.equal(calls[0].init.headers.get('apikey'), 'anon-test');
    mock.restoreAll();
  });
  test('白名单 RPC POST → 放行', async () => {
    const calls = captureFetch();
    const r = await callP('POST', 'rpc/get_all_slot_counts', { body: {} });
    assert.equal(r.status, 200);
    assert.ok(calls[0].url.includes('/rest/v1/rpc/get_all_slot_counts'));
    mock.restoreAll();
  });
  test('非白名单表 GET（patient_master）→ 403', async () => {
    const r = await callP('GET', 'patient_master?select=*');
    assert.equal(r.status, 403);
  });
  test('非白名单表写（schedule_overrides PATCH）→ 403', async () => {
    const r = await callP('PATCH', 'schedule_overrides?date=eq.2026-10-08', { body: { am_enabled: true } });
    assert.equal(r.status, 403);
  });
  test('非白名单 RPC（advance_workflow）→ 403', async () => {
    const r = await callP('POST', 'rpc/advance_workflow', { body: { target_stage: 'x' } });
    assert.equal(r.status, 403);
  });
  test('advance_workflow 裸路径（医生端点）→ 401 保持鉴权语义', async () => {
    const r = await callP('POST', 'advance_workflow', { body: { target_stage: 'x' } });
    assert.equal(r.status, 401);
  });
  test('患者 DELETE → 405（取消只走 RPC）', async () => {
    const r = await callP('DELETE', 'appointments?id=eq.1');
    assert.equal(r.status, 405);
  });
  test('医生/admin key 请求不走患者通道（无key读全表被拦在白名单）', async () => {
    const r = await callP('GET', 'patient_photos?select=*');
    assert.equal(r.status, 403);
  });
  test('带错 admin key → 401（绝不静默降级成患者匿名通道）', async () => {
    const r = await callP('PATCH', 'checklists?id=eq.1', { headers: { 'x-admin-key': 'WRONG' }, body: { status: 'done' } });
    assert.equal(r.status, 401);
  });
  test('患者 PATCH appointments → 403（取消/改约只许走带归属校验的 RPC）', async () => {
    const r = await callP('PATCH', 'appointments?id=eq.1', { body: { status: 'cancel' } });
    assert.equal(r.status, 403);
  });
  test('患者 POST 越权列 → 剥掉（转发 body 只含白名单列）', async () => {
    let sent = null;
    mock.method(globalThis, 'fetch', async (url, init) => { sent = JSON.parse(init.body); return new Response('[]', { status: 201 }); });
    const r = await callP('POST', 'appointments', { body: { patient_name: 'x', date: '2026-10-08', slot: 'am', bonded: true, workflow_stage: 'evil', appointment_id: 99 } });
    assert.equal(r.status, 201);
    assert.deepEqual(sent, { patient_name: 'x', date: '2026-10-08', slot: 'am' });
    mock.restoreAll();
  });
  test('患者 PATCH checklists 只允许 status，越权列剥离', async () => {
    let sent = null;
    mock.method(globalThis, 'fetch', async (url, init) => { sent = JSON.parse(init.body); return new Response('[]', { status: 200 }); });
    const r = await callP('PATCH', 'checklists?id=eq.1', { body: { status: 'cancel', bonded: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(sent, { status: 'cancel' });
    mock.restoreAll();
  });
  test('患者 PATCH checklists 全为越权字段 → 400（拒空更新换200）', async () => {
    const r = await callP('PATCH', 'checklists?id=eq.1', { body: { bonded: true } });
    assert.equal(r.status, 400);
  });

});

describe('admin PATCH checklists 防静默假成功', () => {
  test('空对象 body → 400', async () => {
    const r = await call('PATCH', 'https://x/api/sb/checklists?id=eq.1', { table: 'checklists', headers: { 'x-admin-key': 'admin-1' }, body: {} });
    assert.equal(r.status, 400);
  });
});
