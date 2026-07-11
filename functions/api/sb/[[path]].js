// Cloudflare Pages Function — 后台管理专用代理（动态路由捕获 /api/sb/<table>）
// 路由：functions/api/sb/[[path]].js  →  访问 /api/sb/appointments?select=*
// 作用：校验管理口令后，用 service_role 密钥转发到 Supabase。

export async function onRequest(context) {
  const { request, env, params } = context;

  // 1) 校验管理口令（Cloudflare 环境变量 ADMIN_KEY，绝不进前端）
  const adminKey = request.headers.get('x-admin-key');
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2) 解析表名：/api/sb/appointments -> params.path = ['appointments']
  const pathSegments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const table = pathSegments[0];
  if (!table) {
    return new Response(
      JSON.stringify({ error: 'Missing table name' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3) 用 service_role 转发到 Supabase（绕过 RLS，拥有完整权限）
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
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4) 透传上游响应
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
