// 纯函数：日期、聚合、排序、理由汇总。不碰 DOM，不碰存储。
// 日期一律用本地时间的 "YYYY-MM-DD" 字符串（下称 key），可直接按字符串比较大小。

export function pad2(n) {
  return String(n).padStart(2, "0");
}

// 本地日期 → "YYYY-MM-DD"
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// key → 本地 Date（当天 0 点）
function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 本地日期加减天数（用 setDate，跨月、跨夏令时都不出错）
export function shiftDay(key, delta) {
  const d = parseKey(key);
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}

// 该日所在周的周一；周日记为 7，属于前面的周一
export function weekStartKey(key) {
  const day = parseKey(key).getDay() || 7;
  return shiftDay(key, 1 - day);
}

// "2026-10-05" → "10月5日"（不写年份）
export function formatDate(key) {
  const [, m, d] = key.split("-").map(Number);
  return `${m}月${d}日`;
}

// "10月19日–10月21日"；同一天只返回一个日期
export function formatRange(fromKey, toKey) {
  if (fromKey === toKey) return formatDate(fromKey);
  return `${formatDate(fromKey)}–${formatDate(toKey)}`;
}

// 按名单顺序建 Map，没记录为 0；名单外（已删除）学生的记录不计
function sumBy(events, students, keep) {
  const map = new Map(students.map((s) => [s.id, 0]));
  for (const e of events) {
    if (map.has(e.studentId) && keep(e)) map.set(e.studentId, map.get(e.studentId) + e.delta);
  }
  return map;
}

// 总分
export function totals(events, students) {
  return sumBy(events, students, () => true);
}

// date 在 [fromKey, toKey] 闭区间内的分数合计
export function sumInRange(events, students, fromKey, toKey) {
  return sumBy(events, students, (e) => e.date >= fromKey && e.date <= toKey);
}

// 区间内的记录，按 ts 降序（新的在前）；不过滤学生
export function eventsInRange(events, fromKey, toKey) {
  return events
    .filter((e) => e.date >= fromKey && e.date <= toKey)
    .sort((a, b) => b.ts - a.ts);
}

// "list"：名单原顺序；"score"：按分数降序，同分保持名单顺序（sort 是稳定的）
export function sortStudents(students, scoreMap, mode) {
  const list = students.slice();
  if (mode !== "score") return list;
  const score = (s) => scoreMap.get(s.id) ?? 0;
  return list.sort((a, b) => score(b) - score(a));
}

// 某学生在区间内按理由聚合：
// sum>0 在前按 sum 降序；sum<0 在后按 sum 升序；sum===0 放最后按 label；同 sum 保持首次出现顺序
export function reasonBreakdown(events, studentId, fromKey, toKey) {
  const byLabel = new Map();
  for (const e of events) {
    if (e.studentId !== studentId || e.date < fromKey || e.date > toKey) continue;
    const row = byLabel.get(e.label) ?? { label: e.label, count: 0, sum: 0 };
    row.count += 1;
    row.sum += e.delta;
    byLabel.set(e.label, row);
  }
  const rank = (r) => (r.sum > 0 ? 0 : r.sum < 0 ? 1 : 2);
  return [...byLabel.values()].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return b.sum - a.sum;
    if (ra === 1) return a.sum - b.sum;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}
