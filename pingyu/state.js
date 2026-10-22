// app/state.js
// 纯函数：名单解析、取名、积分备份解析、评语拼装、导出。不碰 DOM，不碰存储。
import { DIMS } from "./bank.js";

export const NAME_MAX = 20;
const EXTRA_MAX = 60;

function clip(s, n) { return Array.from(s).slice(0, n).join(""); }

export function parseNames(text) { return parseNamesInfo(text).names; }

// 同 parseNames，另报去掉了几个重名（保存名单的 toast 用）
export function parseNamesInfo(text) {
  const names = []; const seen = new Set(); let duplicates = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const n = clip(raw.trim(), NAME_MAX);
    if (!n) continue;
    if (seen.has(n)) { duplicates++; continue; }
    seen.add(n); names.push(n);
  }
  return { names, duplicates };
}

// 有标签或手改评语的标记
export function hasWritten(marks) {
  if (!marks || typeof marks !== "object") return false;
  const tags = marks.tags && typeof marks.tags === "object" ? marks.tags : {};
  return Object.values(tags).some((v) => typeof v === "string" && v) || (typeof marks.manual === "string" && marks.manual.trim() !== "");
}

// 旧名单里已写评语、但新名单里没有的名字（改名/删人前提醒用）
export function writtenMissing(oldNames, newNames, marksByName) {
  const keep = new Set(newNames || []);
  const all = marksByName && typeof marksByName === "object" ? marksByName : {};
  return (oldNames || []).filter((n) => !keep.has(n) && Object.prototype.hasOwnProperty.call(all, n) && hasWritten(all[n]));
}

// 第一次点标签时锁下的座号；没锁过（旧数据）就用当前序号
export function seatOf(marks, index) {
  const s = marks && typeof marks === "object" ? marks.seat : undefined;
  return Number.isInteger(s) && s >= 0 ? s : index;
}

// 本地日期 年-月-日（备份文件名用；不用 toISOString，免得半夜差一天）
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortName(name) {
  const full = String(name ?? "").trim();
  // 外文名、带数字/空格、少数民族名（带间隔号）截后两字会出怪名，用全名
  if (/[A-Za-z0-9\s·•・‧]/.test(full)) return full;
  const chars = Array.from(full);
  if (chars.length >= 3) return chars.slice(-2).join("");
  return chars.join("");
}

export function parsePointsBackup(text) {
  const s = String(text ?? "").replace(/^﻿/, "").trim();
  if (!s.startsWith("{")) return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== "object" || obj.app !== "班级积分" || !Array.isArray(obj.students) || !Array.isArray(obj.events)) return null;
  const idToName = new Map(); const names = []; const points = Object.create(null); let duplicates = 0;
  for (const st of obj.students) {
    if (!st || typeof st !== "object" || typeof st.name !== "string" || typeof st.id !== "string") continue;
    const name = clip(st.name.trim(), NAME_MAX);
    if (!name) continue;
    if (points[name]) { duplicates++; continue; }
    idToName.set(st.id, name); names.push(name); points[name] = Object.create(null);
  }
  for (const e of obj.events) {
    if (!e || typeof e !== "object" || !Number.isInteger(e.delta) || e.delta <= 0 || typeof e.label !== "string") continue;
    const name = idToName.get(e.studentId);
    if (!name) continue;
    const label = e.label.trim();
    if (!label || label === "其他") continue;
    points[name][label] = (points[name][label] || 0) + 1;
  }
  return { names, points, duplicates };
}

// 把积分备份合并进现有数据：名单保持原顺序、备份里的新名字追加到末尾；积分计数按名字覆盖写入，其他人的不动
export function mergePointsBackup(existingNames, existingPoints, backup) {
  const names = Array.isArray(existingNames) ? existingNames.slice() : [];
  const have = new Set(names);
  let added = 0;
  for (const n of backup.names) if (!have.has(n)) { have.add(n); names.push(n); added++; }
  const points = Object.assign(Object.create(null), existingPoints && typeof existingPoints === "object" ? existingPoints : {});
  for (const n of backup.names) points[n] = backup.points[n];
  const withPoints = backup.names.filter((n) => Object.keys(backup.points[n]).length > 0).length;
  return { names, points, added, withPoints };
}

// 同域一键带入：读同一台设备上班级积分的 jf_students / jf_events，拼成积分备份对象；读不到、为空、坏数据都返回 null
export function pointsBackupFromStorage(getItem) {
  let rawS, rawE;
  try { rawS = getItem("jf_students"); rawE = getItem("jf_events"); } catch { return null; }
  let students, events;
  try { students = JSON.parse(rawS ?? "null"); } catch { return null; }
  try { events = JSON.parse(rawE ?? "[]"); } catch { events = []; }
  if (!Array.isArray(students) || students.length === 0) return null;
  return { app: "班级积分", version: 1, students, events: Array.isArray(events) ? events : [] };
}

export function pointsLine(counts) {
  if (!counts || typeof counts !== "object") return "";
  const top = Object.entries(counts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (top.length === 0) return "";
  if (top.length === 1) return `这学期${top[0][0]}${top[0][1]}次，老师都记着呢。`;
  return `这学期${top[0][0]}${top[0][1]}次、${top[1][0]}${top[1][1]}次，老师都记着呢。`;
}

export function pickSentence(list, index, offset = 0) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const k = list.length;
  return list[(((index + offset) % k) + k) % k];
}

function mod(a, k) { return ((a % k) + k) % k; }
function slotList(bank, tags, slot) {
  if (slot === "称呼" || slot === "结尾") return Array.isArray(bank?.[slot]) ? bank[slot] : [];
  const t = tags?.[slot];
  const a = typeof t === "string" ? bank?.维度?.[slot]?.[t] : null;
  return Array.isArray(a) ? a : [];
}
function offsetOf(offsets, slot) { const v = offsets?.[slot]; return Number.isInteger(v) ? v : 0; }

// 「换一换」：称呼、已点的各维度、结尾各往后挪；挪到的句子和左右邻座同标签同一句就再挪，句子 ≥3 句时一定能避开，≤2 句只挪一格。
// neighbors：[左邻 marks 或 null, 右邻 marks 或 null]（null = 没有这个邻座）；neighborIndexes：[i-1, i+1]
export function nextOffsets({ index, marks, neighbors = [], neighborIndexes = [], bank }) {
  const m = marks && typeof marks === "object" ? marks : {};
  const tags = m.tags && typeof m.tags === "object" ? m.tags : {};
  const offsets = { ...(m.offsets && typeof m.offsets === "object" ? m.offsets : {}) };
  const seat = seatOf(m, index);
  const slots = ["称呼", ...DIMS.filter((d) => slotList(bank, tags, d).length > 0), "结尾"];
  for (const slot of slots) {
    const k = slotList(bank, tags, slot).length;
    if (k === 0) continue;
    const cur = offsetOf(offsets, slot);
    const taken = new Set();
    neighbors.forEach((nm, j) => {
      if (!nm || typeof nm !== "object") return;
      if (slot !== "称呼" && slot !== "结尾" && nm.tags?.[slot] !== tags[slot]) return;
      taken.add(mod(seatOf(nm, neighborIndexes[j]) + offsetOf(nm.offsets, slot), k));
    });
    let next = cur + 1;
    if (k >= 3) for (let step = 1; step <= k; step++) { if (!taken.has(mod(seat + cur + step, k))) { next = cur + step; break; } }
    offsets[slot] = next;
  }
  return offsets;
}

function fill(s, name) { return String(s ?? "").replaceAll("{名}", shortName(name)); }

export function compose({ name, index = 0, marks = {}, bank, points = null }) {
  if (typeof marks.manual === "string" && marks.manual.trim()) return marks.manual;
  const tags = marks.tags || {}; const offsets = marks.offsets || {};
  const seat = seatOf(marks, index);
  const sentences = (d) => { const a = typeof tags[d] === "string" ? bank.维度?.[d]?.[tags[d]] : null; return Array.isArray(a) && a.length > 0 ? a : null; };
  const chosen = DIMS.filter((d) => sentences(d));
  if (chosen.length === 0) return "";
  const parts = [];
  for (const d of DIMS) {
    if (!chosen.includes(d)) continue;
    if (d === "建议") {
      const pl = pointsLine(points);
      if (pl) parts.push(pl);
    }
    parts.push(fill(pickSentence(sentences(d), seat, offsets[d] || 0), name));
  }
  if (!chosen.includes("建议")) { const pl = pointsLine(points); if (pl) parts.push(pl); }
  let extra = typeof marks.extra === "string" ? clip(marks.extra.trim(), EXTRA_MAX) : "";
  if (extra && !/[。！？!?…]$/.test(extra)) extra += "。";
  if (extra) parts.push(extra);
  parts.push(fill(pickSentence(bank.结尾, seat, offsets.结尾 || 0), name));
  const head = fill(pickSentence(bank.称呼, seat, offsets.称呼 || 0), name);
  return head + "\n" + parts.join("");
}

export function countChars(s) { return Array.from(String(s ?? "").replace(/\s+/g, "")).length; }

// 复制/导出全班：每人一段；没点标签的跳过。座号在 compose 里按 marks.seat 取
export function exportAll(students, marksByName, bank, pointsByName) { return exportAllInfo(students, marksByName, bank, pointsByName).text; }
export function exportAllInfo(students, marksByName, bank, pointsByName) {
  const blocks = [];
  (students || []).forEach((st, i) => {
    const text = compose({ name: st.name, index: i, marks: (marksByName || {})[st.name] || {}, bank, points: (pointsByName || {})[st.name] || null });
    if (text) blocks.push(`${st.name}：\n${text}`);
  });
  return { text: blocks.join("\n\n"), count: blocks.length, skipped: (students || []).length - blocks.length };
}
