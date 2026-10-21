// 三种复制文案（纯函数，不碰 DOM 和存储）。文案逐字以规格 §5 为准。
import { formatDate, formatRange, weekStartKey, totals, sumInRange, sortStudents, reasonBreakdown } from "./state.js";

// 全角减号 U+2212
export const MINUS = "−";

// 分数（总分等）：负数用全角减号，正数不带加号
export function fmtScore(n) {
  return n < 0 ? `${MINUS}${-n}` : String(n);
}

// 变动值：正数带「+」，负数用全角减号，0 原样
export function fmtDelta(n) {
  return n > 0 ? `+${n}` : fmtScore(n);
}

// 某组学生里分数最高且 > 0 的所有人（名单顺序）；没有则空数组
function topPositive(students, scoreMap) {
  let max = 0;
  for (const s of students) max = Math.max(max, scoreMap.get(s.id));
  if (max <= 0) return [];
  return students.filter((s) => scoreMap.get(s.id) === max);
}

// 今日播报；当天名单内没有任何记录、或净变动全为 0 时返回 null
export function composeToday({ dateKey, className, students, events }) {
  const ids = new Set(students.map((s) => s.id));
  const dayEvents = events
    .filter((e) => e.date === dateKey && ids.has(e.studentId))
    .sort((a, b) => a.ts - b.ts);
  if (dayEvents.length === 0) return null;

  const net = sumInRange(events, students, dateKey, dateKey);
  // 有记录但没有任何孩子净变动 ≠ 0（比如 +1 又 −1），按没有记录处理
  if (![...net.values()].some((v) => v !== 0)) return null;
  // 每个孩子当天的理由：按 ts 升序去重（首次出现顺序）
  const reasons = new Map();
  for (const e of dayEvents) {
    const list = reasons.get(e.studentId) ?? [];
    if (!list.includes(e.label)) list.push(e.label);
    reasons.set(e.studentId, list);
  }
  const item = (s) => `${s.name} ${fmtDelta(net.get(s.id))}（${reasons.get(s.id).join("、")}）`;

  const plus = students.filter((s) => net.get(s.id) > 0).sort((a, b) => net.get(b.id) - net.get(a.id));
  const minus = students.filter((s) => net.get(s.id) < 0).sort((a, b) => net.get(a.id) - net.get(b.id));
  const stars = topPositive(students, net);

  const lines = [`${formatDate(dateKey)} ${className} 积分播报`];
  if (plus.length) lines.push(`加分：${plus.map(item).join("、")}`);
  if (minus.length) lines.push(`扣分：${minus.map(item).join("、")}`);
  if (stars.length) lines.push(`今日之星：${stars.map((s) => s.name).join("、")}`);
  return lines.join("\n");
}

// 本周播报（本周一到今天）；本周名单内没有任何记录时返回 null
export function composeWeek({ todayKey, className, students, events }) {
  const from = weekStartKey(todayKey);
  const ids = new Set(students.map((s) => s.id));
  const hasWeek = events.some((e) => ids.has(e.studentId) && e.date >= from && e.date <= todayKey);
  if (!hasWeek) return null;

  const total = totals(events, students);
  const week = sumInRange(events, students, from, todayKey);
  const ranked = sortStudents(students, total, "score");
  const item = (s) => `${s.name} ${fmtScore(total.get(s.id))}`;

  const lines = [`${formatRange(from, todayKey)} ${className} 本周积分`];
  lines.push(`前三：${ranked.slice(0, 3).map(item).join("、")}`);
  const best = topPositive(students, week);
  if (best.length) lines.push(`本周加分最多：${best.map((s) => s.name).join("、")}（${fmtDelta(week.get(best[0].id))}）`);
  lines.push(`本周总榜：${ranked.map(item).join("、")}`);
  return lines.join("\n");
}

// 单个孩子明细（复制给家长）；总是返回，本周没记录时只有第一行
export function composeStudent({ todayKey, student, events }) {
  const from = weekStartKey(todayKey);
  const one = [student];
  const weekSum = sumInRange(events, one, from, todayKey).get(student.id);
  const total = totals(events, one).get(student.id);
  const lines = [`${formatRange(from, todayKey)} ${student.name} 本周积分 ${fmtDelta(weekSum)}，累计 ${fmtScore(total)}`];
  for (const r of reasonBreakdown(events, student.id, from, todayKey)) {
    lines.push(`${r.label} ×${r.count}（${fmtDelta(r.sum)}）`);
  }
  return lines.join("\n");
}
