// Cloudflare Pages Function — 后台管理专用代理（动态路由捕获 /api/sb/<table>）
// 路由：functions/api/sb/[[path]].js  →  访问 /api/sb/appointments?select=*
// 作用：校验管理口令后，用 service_role 密钥转发到 Supabase。
// 两种鉴权：
//   x-admin-key → 完全权限（service_role，所有方法）—— 段医生后台 admin.html
//   x-staff-key → 受限权限 —— 周医生视图 admin.html?staff=1
//      仅允许 GET（只读白名单表）+ 对 checklists 的受限 PATCH（字段白名单，不含 workflow_stage）
//      DELETE / POST / PUT 一律 405；非白名单字段在 PATCH 时被丢弃
// v2（九正 M2-1）：
//   - 新增 POST /api/sb/advance_workflow（仅 admin）：状态推进唯一入口 → RPC advance_workflow
//   - staff 字段白名单移除 workflow_stage（阶段推进归医生，服务端硬隔离）
// v3（审核修正）：
//   - admin/staff PATCH checklists 若含 workflow_stage → 400（统一走 advance_workflow，防旁路）
//   - staff PATCH 剥壳后为空 → 400（防静默假成功）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'x-admin-key, x-staff-key, content-type, prefer, authorization',
};

// 患者端（匿名）允许的表与 RPC —— 仅这些可通过，且一律用 anon key 转发，RLS 兜底隐私
const PATIENT_GET_TABLES = [
  'schedule_rules', 'holidays', 'schedule_overrides',
  'checklist_templates', 'patient_notices', 'checklists', 'checklist_items', 'appointments'
];
// 患者可写的表与方法，且逐表列白名单——代理剥掉一切患者不需要的字段，防越权写：
//   appointments 只许提单（POST）；改约/取消必须走带归属校验的 RPC，裸 PATCH 一律 403
//   checklists 的 PATCH 只允许改 status
const PATIENT_WRITE_COLUMNS = {
  appointments: {
    POST: ['date', 'slot', 'patient_name', 'patient_card', 'is_return', 'location', 'status', 'note', 'age', 'issue_tags']
  },
  checklists: {
    POST: ['patient_name', 'checklist_type', 'status', 'patient_card', 'patient_age', 'campus'],
    PATCH: ['status']
  },
  checklist_items: {
    POST: ['checklist_id', 'item_name', 'sort_order', 'description']
  }
};
// 患者可调用的 RPC（均为 SECURITY DEFINER 设计给匿名使用）
const PATIENT_RPCS = [
  'get_all_slot_counts', 'get_my_appointments', 'cancel_appointment_by_id',
  'get_card_booking_stats', 'get_latest_photo_date', 'check_duplicate_booking',
  'attach_appointment_to_checklist', 'toggle_checklist_item'
];

// 周医生可读的表（均为只读，不含任何写操作）
const STAFF_READ_TABLES = [
  'appointments', 'checklists', 'checklist_items',
  'schedule_rules', 'holidays', 'schedule_overrides'
];
// 周医生可改的 checklists 字段白名单（v2：移除 workflow_stage，阶段推进归医生）
const STAFF_ALLOWED_COLUMNS = ['sent', 'received', 'bonded', 'status'];

function json(resp, status) {
  return new Response(JSON.stringify(resp), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function forwardToSupabase(target, method, headers, body, signal) {
  const resp = await fetch(target, { method, headers, body, signal });
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

async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

// 患者/匿名请求处理：只读白名单表用 GET、预约/清单用 POST|PATCH，均用 anon key 转发（RLS 保证不泄露他人数据）
async function handlePatientRequest(request, env, params) {
  const ANON = env.SUPABASE_ANON_KEY || 'sb_publishable_sCup7QMIEVdad6Lo22hP7g_lTqs-viR';
  const method = request.method;
  const segs = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  let target;
  let writeBody = null; // 患者写请求经列白名单清洗后的转发体

  // advance_workflow 是医生/前台端点，不属于患者通道（保持 401 鉴权语义）
  if (segs[0] === 'advance_workflow') return json({ error: 'Unauthorized' }, 401);

  // RPC 形式：/api/sb/rpc/<func>
  if (segs[0] === 'rpc' && segs[1]) {
    if (method !== 'POST') return json({ error: 'RPC requires POST' }, 405);
    if (!PATIENT_RPCS.includes(segs[1])) return json({ error: 'Forbidden RPC' }, 403);
    target = `${env.SUPABASE_URL}/rest/v1/rpc/${segs[1]}`;
  } else {
    const table = segs[0];
    if (!table) return json({ error: 'Missing table name' }, 400);
    if (method === 'GET' || method === 'HEAD') {
      if (!PATIENT_GET_TABLES.includes(table)) return json({ error: 'Forbidden table for patient' }, 403);
    } else if (method === 'POST' || method === 'PATCH') {
      const cols = (PATIENT_WRITE_COLUMNS[table] || {})[method];
      if (!cols) return json({ error: 'Forbidden write for patient' }, 403);
      // 列白名单：非 JSON、空对象、剥壳后为空都直接 400，绝不带着空更新去换 200
      const rawText = await request.text();
      let parsed = null;
      try { parsed = JSON.parse(rawText); } catch (e) { return json({ error: 'Patient write requires JSON body' }, 400); }
      const pick = (o) => { const c = {}; for (const k of cols) if (o && k in o) c[k] = o[k]; return c; };
      const cleaned = Array.isArray(parsed) ? parsed.map(pick) : [pick(parsed)];
      if (!cleaned.length || Object.keys(cleaned[0]).length === 0) {
        return json({ error: 'No allowed fields for patient write' }, 400);
      }
      writeBody = JSON.stringify(Array.isArray(parsed) ? cleaned : cleaned[0]);
    } else {
      return json({ error: 'Method not allowed' }, 405);
    }
    const u = new URL(request.url);
    target = `${env.SUPABASE_URL}/rest/v1/${table}${u.search}`;
  }

  const headers = new Headers();
  headers.set('apikey', ANON);
  headers.set('Authorization', `Bearer ${ANON}`);
  const ct = request.headers.get('content-type'); if (ct) headers.set('Content-Type', ct);
  const prefer = request.headers.get('prefer'); if (prefer) headers.set('Prefer', prefer);
  const body = writeBody !== null ? writeBody : ((method === 'GET' || method === 'HEAD') ? null : await request.text());

  // 超时保护：上游 10s 不响应即中断，返回 504（患者端 fetch 超时会更早兜底）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    return await forwardToSupabase(target, method, headers, body, ctrl.signal);
  } catch (e) {
    return json({ error: 'Upstream error: ' + e.message }, 504);
  } finally {
    clearTimeout(timer);
  }
}

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
    // 带了 admin/staff key 但不匹配：必须 401 快速失败。
    // 若放其落入匿名通道，医生端写操作会被 anon+RLS 拦成"200 但库没变"的静默假成功。
    if (adminKey || staffKey) return json({ error: 'Unauthorized' }, 401);
    // 完全无凭证：患者/匿名通道，用 anon key 转发，仅放行白名单表与 RPC，带超时保护
    return await handlePatientRequest(request, env, params);
  }

  // 2) 解析表名：/api/sb/appointments -> params.path = ['appointments']
  const pathSegments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const table = pathSegments[0];
  if (!table) {
    return json({ error: 'Missing table name' }, 400);
  }

  // 2.5) 状态推进专用端点（九正 M2-1，v2：admin+staff 均可，角色注入）：
  //      POST /api/sb/advance_workflow，body: { patient_card, target_stage }
  //      admin → role=admin（全量 15 态）；staff → role=staff（受限子集：方案完成/沟通/矫治器送收到粘）
  //      转发到 RPC advance_workflow（白名单校验/幂等/原子双写）
  if (table === 'advance_workflow') {
    if (request.method !== 'POST') {
      return json({ error: 'advance_workflow requires POST' }, 405);
    }
    if (!isAdmin && !isStaff) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const payload = await readJson(request);
    const role = isAdmin ? 'admin' : 'staff';
    const body = { ...payload, p_role: role };
    const target = `${env.SUPABASE_URL}/rest/v1/rpc/advance_workflow`;
    const headers = new Headers();
    headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
    headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    headers.set('Content-Type', 'application/json');
    try {
      return await forwardToSupabase(target, 'POST', headers, JSON.stringify(body));
    } catch (e) {
      return json({ error: 'Upstream error: ' + e.message }, 502);
    }
  }

  // 2.6) 状态字段旁路拦截（v3）：admin 对 checklists 的 PATCH 若带 workflow_stage → 400
  //      状态推进唯一入口是 advance_workflow（含白名单校验/双写），直 PATCH 会绕过状态机
  //      注意：staff 的 checklists PATCH 走下方 staff 分支（字段白名单剥壳），不在此拦截
  if (table === 'checklists' && request.method === 'PATCH' && isAdmin) {
    // 读原文再判定：非 JSON / 空对象直接 400。
    // 旧实现 readJson 把坏 body 吞成 {}，于是带着空更新转发拿到 200——典型的"改了但库没变"静默假成功
    const rawText = await request.text();
    let raw = null;
    try { raw = JSON.parse(rawText); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
      return json({ error: 'PATCH checklists requires a non-empty JSON object' }, 400);
    }
    if ('workflow_stage' in raw) {
      return json({ error: 'workflow_stage must go through POST /advance_workflow' }, 400);
    }
    // 原文转发（不重建 body，不丢负载）
    const url = new URL(request.url);
    const target = `${env.SUPABASE_URL}/rest/v1/${table}${url.search}`;
    const headers = new Headers();
    headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
    headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    const prefer = request.headers.get('prefer');
    if (prefer) headers.set('Prefer', prefer);
    try {
      return await forwardToSupabase(target, 'PATCH', headers, rawText);
    } catch (e) {
      return json({ error: 'Upstream error: ' + e.message }, 502);
    }
  }

  // 3) staff 受限分支（仅当 admin key 不在场时生效；admin 优先走原逻辑）
  if (isStaff && !isAdmin) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!STAFF_READ_TABLES.includes(table)) {
        return json({ error: 'Forbidden table for staff' }, 403);
      }
    } else if (request.method === 'PATCH' && table === 'checklists') {
      // v2：字段白名单（不含 workflow_stage）；v3：剥壳后为空 → 400（防静默假成功）
      const raw = await readJson(request);
      const cleaned = {};
      for (const col of STAFF_ALLOWED_COLUMNS) {
        if (col in raw) cleaned[col] = raw[col];
      }
      if (Object.keys(cleaned).length === 0) {
        return json({ error: 'No allowed fields for staff PATCH' }, 400);
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
      try {
        return await forwardToSupabase(target, 'PATCH', headers, JSON.stringify(cleaned));
      } catch (e) {
        return json({ error: 'Upstream error: ' + e.message }, 502);
      }
    } else {
      // POST / PUT / DELETE 或非 checklists 的 PATCH 一律拒绝
      return json({ error: 'Staff key only allows GET and PATCH checklists' }, 405);
    }
    // 白名单表的 GET 不在此处 return，落到下方 admin 转发逻辑（service_role 只读转发）。
  }

  // 4) admin 分支：全方法、service_role 转发（checklists PATCH 已在 2.6 处理）
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

  try {
    return await forwardToSupabase(target, request.method, headers, body);
  } catch (e) {
    return json({ error: 'Upstream error: ' + e.message }, 502);
  }
}
