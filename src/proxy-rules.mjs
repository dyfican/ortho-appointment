/**
 * src/proxy-rules.mjs - Single source of truth for Cloudflare proxy auth rules.
 * Used by: unit tests, functions/api/sb/[[path]].js (reference)
 */

// Staff can only READ these tables
export const STAFF_READ_TABLES = [
  'appointments', 'checklists', 'checklist_items',
  'schedule_rules', 'holidays', 'schedule_overrides'
];

// Staff PATCH can only touch these columns
export const STAFF_ALLOWED_COLUMNS = [
  'workflow_stage', 'sent', 'received', 'bonded', 'status'
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
