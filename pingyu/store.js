// app/store.js
// localStorage 读写：名单、每个孩子的标签、积分计数、自定义句库、备份恢复。存储被禁用时由 openStorage 退回内存存储。

import { isValidBank } from "./bank.js";

const FULL_MSG = "没存上，可能是隐私模式";


// 时间戳 36 进制 + 进程内单调计数 + 随机 4 位；计数保证同一毫秒内也不重复
let idCounter = 0;
export function newId() {
  idCounter = (idCounter + 1) % 46656; // 36^3，固定 3 位
  return Date.now().toString(36) + idCounter.toString(36).padStart(3, "0") + Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

// 读原始字符串；storage 被禁用或抛错时 console.warn 并返回 null
function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn(`[store] 读取 ${key} 失败，按空处理`, e);
    return null;
  }
}

// 写原始字符串；失败统一抛固定消息，让上层 toast 提示用户
function writeRaw(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (e) {
    console.warn(`[store] 写入 ${key} 失败`, e);
    throw new Error(FULL_MSG);
  }
}

function readJSON(storage, key, fallback) {
  const raw = readRaw(storage, key);
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) {
    console.warn(`[store] ${key} 内容损坏，按空处理`, e);
    return fallback;
  }
}

function writeJSON(storage, key, value) {
  writeRaw(storage, key, JSON.stringify(value));
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function objectList(v) {
  return (Array.isArray(v) ? v : []).filter(isPlainObject);
}

export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// 拿浏览器存储并试写一次：访问就抛、拿到 null、写入失败（隐私模式/禁用存储）都按「被禁用」处理，改用内存存储
export function openStorage(getStorage) {
  try {
    const st = getStorage();
    if (!st) throw new Error("no localStorage");
    st.setItem("__py_probe", "1");
    st.removeItem("__py_probe");
    return { storage: st, blocked: false };
  } catch {
    return { storage: memoryStorage(), blocked: true };
  }
}

export const KEYS = { students: "py_students", marks: "py_marks", points: "py_points", bank: "py_bank", version: "py_version" };
const APP_NAME = "评语助手";

function cleanStudents(list) {
  return objectList(list).filter((x) => typeof x.id === "string" && x.id && typeof x.name === "string" && x.name.trim()).map((x) => ({ id: x.id, name: x.name.trim() }));
}
// 名单上有标签或手改评语的人数（恢复后 toast 用；不在名单上的残留不算）
function countMarked(students, marks) {
  let n = 0;
  for (const st of students) {
    const m = Object.prototype.hasOwnProperty.call(marks, st.name) ? marks[st.name] : null;
    if (!isPlainObject(m)) continue;
    const hasTag = isPlainObject(m.tags) && Object.values(m.tags).some((v) => typeof v === "string" && v);
    const hasManual = typeof m.manual === "string" && m.manual.trim() !== "";
    if (hasTag || hasManual) n++;
  }
  return n;
}
function cleanObject(v) { return isPlainObject(v) ? v : {}; }

export function createStore(storage) {
  function getStudents() { return cleanStudents(readJSON(storage, KEYS.students, [])); }
  function setStudentsByNames(names) {
    const old = new Map(getStudents().map((s) => [s.name, s.id]));
    const next = (Array.isArray(names) ? names : []).map((n) => ({ id: old.get(n) || newId(), name: n }));
    writeJSON(storage, KEYS.students, next);
    return next;
  }
  function getMarks() { return cleanObject(readJSON(storage, KEYS.marks, {})); }
  function getMark(name) { return cleanObject(getMarks()[name]); }
  function setMark(name, patch) {
    const all = getMarks(); const cur = { ...cleanObject(all[name]) };
    for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete cur[k]; else cur[k] = v; }
    all[name] = cur; writeJSON(storage, KEYS.marks, all);
  }
  function getPoints() { return cleanObject(readJSON(storage, KEYS.points, {})); }
  function setPoints(obj) { writeJSON(storage, KEYS.points, cleanObject(obj)); }
  function getBank() { const v = readJSON(storage, KEYS.bank, null); return isValidBank(v) ? v : null; }
  function setBank(obj) { if (obj == null) { try { storage.removeItem(KEYS.bank); } catch (e) { console.warn("[store] 删除句库失败", e); } } else writeJSON(storage, KEYS.bank, obj); }

  function exportBackup() {
    return { app: APP_NAME, version: 1, exportedAt: new Date().toISOString(), students: getStudents(), marks: getMarks(), points: getPoints(), bank: getBank() };
  }
  function importBackup(obj) {
    const ok = isPlainObject(obj) && obj.app === APP_NAME && obj.version === 1 && Array.isArray(obj.students);
    if (!ok) return { ok: false, error: "不是评语助手的备份" };
    const students = cleanStudents(obj.students), marks = cleanObject(obj.marks), points = cleanObject(obj.points);
    const bank = isValidBank(obj.bank) ? obj.bank : null;
    const bankDropped = obj.bank != null && !bank; // 备份里带了句库但不合格，丢掉用默认
    const keys = Object.values(KEYS);
    const snapshot = keys.map((key) => { try { return { key, known: true, raw: storage.getItem(key) }; } catch { return { key, known: false, raw: null }; } });
    try {
      writeJSON(storage, KEYS.students, students); writeJSON(storage, KEYS.marks, marks); writeJSON(storage, KEYS.points, points);
      if (bank) writeJSON(storage, KEYS.bank, bank); else storage.removeItem(KEYS.bank);
      writeRaw(storage, KEYS.version, "1");
    } catch (err) {
      for (const { key, known, raw } of snapshot) { if (!known) continue; try { if (raw == null) storage.removeItem(key); else storage.setItem(key, raw); } catch (e) { console.warn(`[store] 回滚 ${key} 失败`, e); } }
      return { ok: false, error: err.message || FULL_MSG };
    }
    return { ok: true, counts: { students: students.length, marks: countMarked(students, marks) }, bankDropped };
  }
  try { storage.setItem(KEYS.version, "1"); } catch (e) { console.warn("[store] 写入版本号失败", e); }
  return { getStudents, setStudentsByNames, getMarks, getMark, setMark, getPoints, setPoints, getBank, setBank, exportBackup, importBackup };
}
