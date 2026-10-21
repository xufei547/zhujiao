// app/copy.js
export const DEFAULT_TEMPLATE = Object.freeze({
  done: "✓ 完成",
  fix: "✎ 已订正",
  undone: "✗ 未完成，请家长督促",
  allDone: "今天全部完成，表现很好👍",
  hasFix: "有订正，已在托管完成",
  hasUndone: "未完成的请今晚在家补齐",
});

export function formatDate(key) {
  const [, m, d] = key.split("-").map(Number);
  return `${m}月${d}日`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

export function composeOne({ dateKey, student, subjects, record, template }) {
  if (!record) return null;
  const lines = [];
  let hasFix = false;
  let hasUndone = false;
  for (const sub of subjects) {
    const st = record[sub.id];
    if (st !== "done" && st !== "fix" && st !== "undone") continue;
    lines.push(`${sub.name} ${template[st]}`);
    if (st === "fix") hasFix = true;
    if (st === "undone") hasUndone = true;
  }
  if (lines.length === 0) return null;
  const tail = hasUndone ? template.hasUndone : hasFix ? template.hasFix : template.allDone;
  return [`${formatDate(dateKey)} ${student.name} 今日作业`, ...lines, tail].join("\n");
}

export function composeAll({ dateKey, students, subjects, dayRecords, template }) {
  const parts = [];
  for (const s of students) {
    const t = composeOne({ dateKey, student: s, subjects, record: dayRecords[s.id], template });
    if (t) parts.push(t);
  }
  return { text: parts.join("\n\n"), count: parts.length };
}
