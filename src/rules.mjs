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
// Valid: starts with 131 or H00, total 15 chars, alphanumeric.
export function isValidCard(card) {
  if (!card || card.length !== 15) return false;
  if (card.startsWith('131')) return /^\d{15}$/.test(card);
  if (card.startsWith('H00')) return /^H00[A-Za-z0-9]{12}$/.test(card);
  return false;
}
