// Cloudflare Pages Function — 后台管理专用代理
// 作用：校验管理口令后，用 service_role 密钥代替前端直连 Supabase，
// 从而让公开 anon 密钥无法直接读写患者数据（配合 Supabase RLS 生效）。
// 路由：/api/sb/<table>?<query>  例如 /api/sb/appointments?select=*

export async function onRequest(context) {
  const { request, env } = context;

  // 1) 校验管理口令（Cloudflare 环境变量 ADMIN_KEY，绝不进前端）
  const adminKey = request.headers.get('x-admin-key');
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2) 解析路径中的表名：/api/sb/appointments -> ['api','sb','appointments']
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const table = segments[2];
  if (!table) {
    return new Response(
      JSON.stringify({ error: 'Missing table name' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3) 用 service_role 转发到 Supabase（绕过 RLS，拥有完整权限）
  const target = `${env.SUPABASE_URL}/rest/v1/${table}${url.search}`;
  const headers = new Headers();
  headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);

  // 透传必要请求头
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
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4) 透传上游响应（含 Content-Type / Content-Range）
  const respHeaders = new Headers();
  const ct = resp.headers.get('Content-Type');
  if (ct) respHeaders.set('Content-Type', ct);
  const range = resp.headers.get('Content-Range');
  if (range) respHeaders.set('Content-Range', range);

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}
