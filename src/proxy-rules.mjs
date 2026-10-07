/**
 * src/proxy-rules.mjs - Single source of truth for Cloudflare proxy auth rules.
 * Used by: unit tests, functions/api/sb/[[path]].js (reference)
 * v2（九正 M2-1）：STAFF_ALLOWED_COLUMNS 移除 workflow_stage（阶段推进归医生）
 */

// Staff can only READ these tables
export const STAFF_READ_TABLES = [
  'appointments', 'checklists', 'checklist_items',
  'schedule_rules', 'holidays', 'schedule_overrides'
];

// Staff PATCH can only touch these columns（不含 workflow_stage，阶段推进走 advance_workflow RPC）
export const STAFF_ALLOWED_COLUMNS = [
  'sent', 'received', 'bonded', 'status'
];

export function checkAuth(headers, env) {
  const adminKey = headers['x-admin-key'];
  const staffKey = headers['x-staff-key'];
  const isAdmin = !!(adminKey && adminKey === env.ADMIN_KEY);
  const isStaff = !!(staffKey && staffKey === env.STAFF_KEY);
  return { isAdmin, isStaff };
}

export function staffCanAccess(method, table) {
  if (method === 'GET' || method === 'HEAD') return STAFF_READ_TABLES.includes(table);
  if (method === 'PATCH') return table === 'checklists';
  return false;
}

export function filterStaffFields(body) {
  const cleaned = {};
  for (const col of STAFF_ALLOWED_COLUMNS) {
    if (col in body) cleaned[col] = body[col];
  }
  return cleaned;
}
