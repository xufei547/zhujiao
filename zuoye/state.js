// app/state.js
export const STATUSES = ["done", "fix", "undone"];

export function nextStatus(current) {
  if (current == null) return "done";
  const i = STATUSES.indexOf(current);
  if (i < 0) return "done";
  return i === STATUSES.length - 1 ? null : STATUSES[i + 1];
}

export function fillAllDone(students, subjects) {
  const out = {};
  for (const s of students) {
    out[s.id] = {};
    for (const sub of subjects) out[s.id][sub.id] = "done";
  }
  return out;
}

// 「全部完成」：只给当前可见的孩子 × 科目填 done，逐个孩子合并；
// 已删除的孩子、已删除科目的历史记录原样保留
export function mergeAllDone(dayRecords, students, subjects) {
  const day = dayRecords && typeof dayRecords === "object" ? dayRecords : {};
  const filled = fillAllDone(students, subjects);
  const out = { ...day };
  for (const sid of Object.keys(filled)) out[sid] = { ...(day[sid] || {}), ...filled[sid] };
  return out;
}

const pad = (n) => String(n).padStart(2, "0");

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return todayKey(dt);
}
