// Cloudflare Pages Function — 后台管理专用代理（动态路由捕获 /api/sb/<table>）
// 路由：functions/api/sb/[[path]].js  →  访问 /api/sb/appointments?select=*
// 作用：校验管理口令后，用 service_role 密钥转发到 Supabase。
// 两种鉴权：
//   x-admin-key → 完全权限（service_role，所有方法）—— 段医生后台 admin.html
//   x-staff-key → 受限权限 —— 周医生视图 admin.html?staff=1
//      仅允许 GET（只读白名单表）+ 对 checklists 的受限 PATCH（字段白名单）
//      DELETE / POST / PUT 一律 405；非白名单字段在 PATCH 时被丢弃
//     即使 staff key 泄露，也清不了表、改不了关键信息（卡号 / appointment_id 等）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'x-admin-key, x-staff-key, content-type, prefer, authorization',
};

// 周医生可读的表（均为只读，不含任何写操作）
const STAFF_READ_TABLES = [
  'appointments', 'checklists', 'checklist_items',
  'schedule_rules', 'holidays', 'schedule_overrides'
];
// 周医生可改的 checklists 字段白名单
const STAFF_ALLOWED_COLUMNS = ['workflow_stage', 'sent', 'received', 'bonded', 'status'];

export async function onRequest(context) {
  const { request, env, params } = context;

  // 预检请求（跨域调用时浏览器先发 OPTIONS）
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 1) 鉴权：admin 优先，其次 staff
  const adminKey = request.headers.get('x-admin-key');
  const staffKey = request.headers.get('x-staff-key');
  const isAdmin = !!(adminKey && adminKey === env.ADMIN_KEY);
  const isStaff = !!(staffKey && staffKey === env.STAFF_KEY);
  if (!isAdmin && !isStaff) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  // 2) 解析表名：/api/sb/appointments -> params.path = ['appointments']
  const pathSegments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const table = pathSegments[0];
  if (!table) {
    return new Response(
      JSON.stringify({ error: 'Missing table name' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  // 3) staff 受限分支（仅当 admin key 不在场时生效；admin 优先走原逻辑）
  if (isStaff && !isAdmin) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!STAFF_READ_TABLES.includes(table)) {
        return new Response(
          JSON.stringify({ error: 'Forbidden table for staff' }),
          { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
    } else if (request.method === 'PATCH') {
      if (table !== 'checklists') {
        return new Response(
          JSON.stringify({ error: 'Staff can only PATCH checklists' }),
          { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
      // 字段白名单：只保留允许的列，丢弃其余（防越权改卡号 / appointment_id 等）
      let raw = {};
      try { raw = await request.json(); } catch (e) { raw = {}; }
      const cleaned = {};
      for (const col of STAFF_ALLOWED_COLUMNS) {
        if (col in raw) cleaned[col] = raw[col];
      }
      const url = new URL(request.url);
      const target = `${env.SUPABASE_URL}/rest/v1/${table}${url.search}`;
      const headers = new Headers();
      headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
      headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      const contentType = request.headers.get('content-type');
      if (contentType) headers.set('Content-Type', contentType);
      const prefer = request.headers.get('prefer');
      if (prefer) headers.set('Prefer', prefer);
      let resp;
      try {
        resp = await fetch(target, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(cleaned),
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Upstream error: ' + e.message }),
          { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
      const respHeaders = new Headers();
      const ct = resp.headers.get('Content-Type');
      if (ct) respHeaders.set('Content-Type', ct);
      const range = resp.headers.get('Content-Range');
      if (range) respHeaders.set('Content-Range', range);
      for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } else {
      // POST / PUT / DELETE 一律拒绝
      return new Response(
          JSON.stringify({ error: 'Staff key only allows GET and PATCH' }),
          { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
      // 白名单表的 GET 不在此处 return，落到下方 admin 转发逻辑（service_role 只读转发）。
      // staff 写能力仍由上面 PATCH 字段白名单 + POST/PUT/DELETE 一律 405 兜底。
    }

  // 4) admin 分支：原逻辑不变（全方法、service_role 转发）
  const url = new URL(request.url);
  const target = `${env.SUPABASE_URL}/rest/v1/${table}${url.search}`;
  const headers = new Headers();
  headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);

  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  const prefer = request.headers.get('prefer');
  if (prefer) headers.set('Prefer', prefer);

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? null
      : request.body;

  let resp;
  try {
    resp = await fetch(target, {
      method: request.method,
      headers,
      body,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Upstream error: ' + e.message }),
      { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  const respHeaders = new Headers();
  const ct = resp.headers.get('Content-Type');
  if (ct) respHeaders.set('Content-Type', ct);
  const range = resp.headers.get('Content-Range');
  if (range) respHeaders.set('Content-Range', range);
  for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}
