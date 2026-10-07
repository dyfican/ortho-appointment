/**
 * src/rules.mjs - Single source of truth for business rules.
 * Used by: unit tests, index.html (via <script type="module">), admin.html
 * Iron rules are marked with [IRON] and must NEVER be changed without doctor approval.
 */

// ===== Rule 1: Done/Todo classification [IRON] =====
// A record is "done" when bonded OR status=completed (but never if cancelled).
// A record is "todo" when NOT bonded AND NOT completed AND NOT cancelled.
export function isDone(r) {
  return (!!r.bonded || r.status === 'completed') && r.status !== 'cancel';
}

export function isTodo(r) {
  return !r.bonded && r.status !== 'completed' && r.status !== 'cancel';
}

export function isInTransit(r) {
  return !!r.sent && !r.received && r.status !== 'cancel';
}

// ===== Rule 2: Duplicate booking prevention [IRON] =====
// Block if patient has any FUTURE appointment that is not cancel/done/noshow.
export function shouldBlockDuplicate(existingAppointments, todayStr) {
  return existingAppointments.some(
    a => a.date > todayStr && !['cancel', 'done', 'noshow'].includes(a.status)
  );
}

// ===== Rule 3: Issue tag mutual exclusion =====
// If any specific issue is selected, remove "正常复诊". If none selected, default to "正常复诊".
export function computeIssueTags(selected) {
  const specific = selected.filter(i => i !== '正常复诊');
  return specific.length === 0 ? '正常复诊' : specific.join(',');
}

// ===== Rule 4: Photo reminder (>90 days) =====
export function needsPhotoReminder(lastPhotoDate, now) {
  if (!lastPhotoDate) return false;
  const elapsed = now.getTime() - new Date(lastPhotoDate).getTime();
  return elapsed > 90 * 24 * 3600 * 1000;
}

// ===== Rule 5: Card validation =====
// 2026-08 放宽：131/H00 开头 -> 13 开头(15位数字) 或 H 开头(15位字母数字)。
// Keep in sync with index.html / admin.html.
export function isValidCard(card) {
  if (!card) return false;
  if (/^13\d{13}$/.test(card)) return true;
  return /^H[A-Za-z0-9]{14}$/i.test(card);
}

// ===== Rule 6: Personal booking link encode/decode =====
// URL-safe base64 of {n:name, c:card, a:age}. Keep in sync with index.html.
export function encodePatientLink(n, c, a) {
  const j = JSON.stringify({ n, c, a: String(a || '') });
  return btoa(unescape(encodeURIComponent(j)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePatientLink(s) {
  try {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const d = JSON.parse(decodeURIComponent(escape(atob(s))));
    if (!d || typeof d.c !== 'string' || !d.c) return null;
  return { n: (typeof d.n === 'string' ? d.n : ''), c: d.c, a: String(d.a == null ? '' : d.a) };
  } catch(e) { return null; }
}

// ===== Rule 7: 挂号截止时间 =====
// 医院挂号截止：当日上午号 11:00 截止、当日下午号 16:00 截止；今日 17:00 后不可约明日上午。
// Keep in sync with index.html.
export const AM_CUTOFF_HOUR = 11;
export const PM_CUTOFF_HOUR = 16;
export const TOMORROW_AM_CUTOFF_HOUR = 17;

// 返回 null 表示该时段可约；否则返回可直接展示给患者的中文原因
export function slotCutoffReason(date, slot, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((target - today) / (24 * 60 * 60 * 1000));
  if (dayDiff === 0) {
    if (slot === 'am' && now.getHours() >= AM_CUTOFF_HOUR) return '当日上午号 ' + AM_CUTOFF_HOUR + ':00 截止，请选择之后的日期';
    if (slot === 'pm' && now.getHours() >= PM_CUTOFF_HOUR) return '当日下午号 ' + PM_CUTOFF_HOUR + ':00 截止，请选择之后的日期';
  }
  if (dayDiff === 1 && slot === 'am' && now.getHours() >= TOMORROW_AM_CUTOFF_HOUR) return '今日' + TOMORROW_AM_CUTOFF_HOUR + ':00后，不可预约明天上午';
  return null;
}

// ===== Rule 8: 这次要做 -> 就诊建议槽 =====
// 长操作需要更宽松的时间；初诊按段医生口径不算长操作。
// Keep in sync with index.html.
export const LONG_OP_LABELS = ['拆托槽', '粘接托槽', '隐形首次佩戴'];
export const LONG_OP_MINUTES = 40;
export const CROWD_PEAK_KEYS = ['6am', '4am', '5pm'];
export const CROWD_QUIET_KEYS = ['2am', '2pm', '5am', '4pm'];

export function isLongOp(purpose) {
  return LONG_OP_LABELS.indexOf(purpose) >= 0;
}

// 单一建议槽：一次只亮一条，优先级固定，避免多条提示叠在一起吵人。
// block=真阻断(红) / warm=为你好(琥珀) / good=选对了(绿) / none=不出声
export function advisoryLevel(state) {
  if (state.cutoff) return 'block';
  if (state.longOp && state.peak) return 'warm';
  if (state.longOp) return 'good';
  if (state.peak) return 'warm';
  return 'none';
}

