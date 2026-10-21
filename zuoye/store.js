// app/store.js
import { DEFAULT_TEMPLATE } from "./copy.js";

const K = {
  students: "tg_students",
  subjects: "tg_subjects",
  records: "tg_records",
  template: "tg_template",
  version: "tg_version",
};

const DEFAULT_SUBJECT_NAMES = ["语文", "数学", "英语"];

const FULL_MSG = "存不下了，请先在名单页备份";

// 读原始字符串；storage 被禁用或抛错时 console.warn 并返回 null
function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn(`[store] 读取 ${key} 失败，按空处理`, e);
    return null;
  }
}

// 写原始字符串；失败统一抛固定消息，让上层提示用户
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

const VALID_STATUS = new Set(["done", "fix", "undone"]);

// 备份里的名单/科目：只留 {id: string, name: 非空 string}
function cleanNamed(list) {
  return list
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && typeof x.name === "string" && x.name.trim())
    .map((x) => ({ id: x.id, name: x.name.trim() }));
}

// 备份里的记录：{日期: {孩子id: {科目id: done|fix|undone}}}，其他值丢掉，空的层级也丢掉
function cleanRecords(records) {
  const out = {};
  for (const [dateKey, day] of Object.entries(records)) {
    if (!isPlainObject(day)) continue;
    const d = {};
    for (const [sid, rec] of Object.entries(day)) {
      if (!isPlainObject(rec)) continue;
      const r = {};
      for (const [subId, st] of Object.entries(rec)) if (VALID_STATUS.has(st)) r[subId] = st;
      if (Object.keys(r).length > 0) d[sid] = r;
    }
    if (Object.keys(d).length > 0) out[dateKey] = d;
  }
  return out;
}

function cleanTemplate(t) {
  const out = {};
  for (const k of Object.keys(DEFAULT_TEMPLATE)) if (typeof t[k] === "string" && t[k].length > 0) out[k] = t[k];
  return out;
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
    st.setItem("tg_probe", "1");
    st.removeItem("tg_probe");
    return { storage: st, blocked: false };
  } catch {
    return { storage: memoryStorage(), blocked: true };
  }
}

export function createStore(storage) {
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function getStudents() {
    const v = readJSON(storage, K.students, []);
    return Array.isArray(v) ? v : [];
  }
  function setStudents(list) {
    writeJSON(storage, K.students, list);
  }

  // 写不回存储时缓存默认科目，保证同一会话内 id 稳定
  let fallbackSubjects = null;
  function getSubjects() {
    const v = readJSON(storage, K.subjects, null);
    // 只有键缺失或损坏才回退默认；空数组原样返回
    if (Array.isArray(v)) return v;
    const def = fallbackSubjects || DEFAULT_SUBJECT_NAMES.map((name) => ({ id: newId(), name }));
    try {
      writeJSON(storage, K.subjects, def);
      fallbackSubjects = null;
    } catch {
      fallbackSubjects = def;
    }
    return def;
  }
  function setSubjects(list) {
    writeJSON(storage, K.subjects, list);
  }

  function getAllRecords() {
    const v = readJSON(storage, K.records, {});
    return isPlainObject(v) ? v : {};
  }
  function getDayRecords(dateKey) {
    const day = getAllRecords()[dateKey];
    return isPlainObject(day) ? day : {};
  }
  function setDayRecords(dateKey, obj) {
    const all = getAllRecords();
    const day = {};
    if (isPlainObject(obj)) {
      for (const [sid, rec] of Object.entries(obj)) {
        if (rec == null || (isPlainObject(rec) && Object.keys(rec).length === 0)) continue;
        day[sid] = rec;
      }
    }
    if (Object.keys(day).length > 0) all[dateKey] = day;
    else delete all[dateKey];
    writeJSON(storage, K.records, all);
  }
  function setStatus(dateKey, sid, subId, status) {
    const day = getDayRecords(dateKey);
    const rec = isPlainObject(day[sid]) ? { ...day[sid] } : {};
    if (status == null) delete rec[subId];
    else rec[subId] = status;
    const next = { ...day };
    if (Object.keys(rec).length === 0) delete next[sid];
    else next[sid] = rec;
    setDayRecords(dateKey, next);
  }

  function getTemplate() {
    const v = readJSON(storage, K.template, {});
    const t = isPlainObject(v) ? v : {};
    const out = { ...DEFAULT_TEMPLATE };
    for (const k of Object.keys(DEFAULT_TEMPLATE)) {
      if (typeof t[k] === "string" && t[k].length > 0) out[k] = t[k];
    }
    return out;
  }
  function setTemplate(t) {
    writeJSON(storage, K.template, t);
  }

  function exportBackup() {
    return JSON.stringify(
      {
        version: 1,
        students: getStudents(),
        subjects: getSubjects(),
        records: getAllRecords(),
        template: getTemplate(),
      },
      null,
      2
    );
  }

  function importBackup(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("备份文件格式不对");
    }
    const ok =
      isPlainObject(data) &&
      data.version === 1 &&
      Array.isArray(data.students) &&
      Array.isArray(data.subjects) &&
      isPlainObject(data.records) &&
      isPlainObject(data.template);
    if (!ok) throw new Error("备份文件格式不对");

    // 原子化：先快照五个键的原始字符串，任何一步写失败就全部写回
    const keys = [K.students, K.subjects, K.records, K.template, K.version];
    const snapshot = keys.map((key) => {
      try {
        return { key, known: true, raw: storage.getItem(key) };
      } catch {
        return { key, known: false, raw: null };
      }
    });
    const students = cleanNamed(data.students);
    const subjects = cleanNamed(data.subjects);
    const records = cleanRecords(data.records);
    const template = cleanTemplate(data.template);
    try {
      writeJSON(storage, K.students, students);
      writeJSON(storage, K.subjects, subjects);
      writeJSON(storage, K.records, records);
      writeJSON(storage, K.template, template);
      writeRaw(storage, K.version, "1");
    } catch (err) {
      for (const { key, known, raw } of snapshot) {
        if (!known) continue;
        try {
          if (raw == null) {
            if (typeof storage.removeItem === "function") storage.removeItem(key);
          } else {
            storage.setItem(key, raw);
          }
        } catch (e) {
          console.warn(`[store] 恢复失败后写回 ${key} 也失败`, e);
        }
      }
      throw err;
    }
  }

  // 版本戳尽力写，存储不可用时吞掉，不能让构造失败
  try {
    storage.setItem(K.version, "1");
  } catch (e) {
    console.warn("[store] 写入版本号失败", e);
  }

  return {
    newId,
    getStudents,
    setStudents,
    getSubjects,
    setSubjects,
    getDayRecords,
    setDayRecords,
    setStatus,
    getTemplate,
    setTemplate,
    exportBackup,
    importBackup,
  };
}
