// app/store.js
// localStorage 读写：班级名、名单、理由、记录、备份恢复。存储被禁用时由 openStorage 退回内存存储。

export const KEYS = { klass: "jf_class", students: "jf_students", reasons: "jf_reasons", events: "jf_events", version: "jf_version" };

export const DEFAULT_REASONS = Object.freeze([
  { label: "举手发言", delta: 1 }, { label: "课堂安静", delta: 1 }, { label: "作业优秀", delta: 2 },
  { label: "帮助同学", delta: 2 }, { label: "迟到", delta: -1 }, { label: "作业没交", delta: -2 }, { label: "兑换奖励", delta: -5 },
]);

export const DEFAULT_CLASS_NAME = "我的班";

const CLASS_NAME_MAX = 20;
const FULL_MSG = "没存上，可能是隐私模式";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// 读数组：不是数组按空处理；元素不是对象（null/原始值）的脏数据统一在这里滤掉
function objectList(v) {
  return Array.isArray(v) ? v.filter(isPlainObject) : [];
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 本地日期 YYYY-MM-DD
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validDelta(delta) {
  return Number.isInteger(delta) && delta !== 0;
}

// 数组里把 id 对应的元素与相邻元素交换；越界或找不到时原样返回 null
function moved(list, id, delta) {
  const i = list.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const next = list.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// 备份里的名单：只留 {id: 非空 string, name: 非空 string}
function cleanStudents(list) {
  return list
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && typeof x.name === "string" && x.name.trim())
    .map((x) => ({ id: x.id, name: x.name.trim() }));
}

// 备份里的理由：{id, label: 非空 string, delta: 非零整数}
function cleanReasons(list) {
  return list
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && typeof x.label === "string" && x.label.trim() && validDelta(x.delta))
    .map((x) => ({ id: x.id, label: x.label.trim(), delta: x.delta }));
}

// 备份里的记录：id/studentId/label 字符串、delta 整数、ts 有限数、date 形如 YYYY-MM-DD；batchId 只在是字符串时保留
function cleanEvents(list) {
  return list
    .filter(
      (x) =>
        isPlainObject(x) &&
        typeof x.id === "string" &&
        typeof x.studentId === "string" &&
        typeof x.label === "string" &&
        Number.isInteger(x.delta) &&
        Number.isFinite(x.ts) &&
        typeof x.date === "string" &&
        DATE_RE.test(x.date)
    )
    .map((x) => {
      const e = { id: x.id, ts: x.ts, date: x.date, studentId: x.studentId, label: x.label, delta: x.delta };
      if (typeof x.batchId === "string") e.batchId = x.batchId;
      return e;
    });
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
    st.setItem("__jf_probe", "1");
    st.removeItem("__jf_probe");
    return { storage: st, blocked: false };
  } catch {
    return { storage: memoryStorage(), blocked: true };
  }
}

export function createStore(storage) {
  // ---- 班级名 ----
  function getClassName() {
    const v = readJSON(storage, KEYS.klass, null);
    if (isPlainObject(v) && typeof v.name === "string" && v.name.trim()) return v.name;
    return DEFAULT_CLASS_NAME;
  }
  function setClassName(name) {
    const t = typeof name === "string" ? name.trim() : "";
    const n = t ? Array.from(t).slice(0, CLASS_NAME_MAX).join("") : DEFAULT_CLASS_NAME;
    writeJSON(storage, KEYS.klass, { name: n });
  }

  // ---- 名单 ----
  function getStudents() {
    return objectList(readJSON(storage, KEYS.students, []));
  }
  function setStudents(list) {
    writeJSON(storage, KEYS.students, list);
  }
  // 单个添加：同名允许
  function addStudent(name) {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) return null;
    const s = { id: newId(), name: n };
    setStudents([...getStudents(), s]);
    return s;
  }
  // 批量添加：与现有名单及本批去重，同名跳过；一次写入
  function addStudents(names) {
    const list = getStudents();
    const seen = new Set(list.map((s) => s.name));
    const added = [];
    for (const raw of Array.isArray(names) ? names : []) {
      const n = typeof raw === "string" ? raw.trim() : "";
      if (!n || seen.has(n)) continue;
      seen.add(n);
      added.push({ id: newId(), name: n });
    }
    if (added.length > 0) setStudents([...list, ...added]);
    return added;
  }
  function renameStudent(id, name) {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) return;
    setStudents(getStudents().map((s) => (s.id === id ? { ...s, name: n } : s)));
  }
  // 删除孩子只删名单，记录保留
  function removeStudent(id) {
    setStudents(getStudents().filter((s) => s.id !== id));
  }
  function moveStudent(id, delta) {
    const next = moved(getStudents(), id, delta);
    if (next) setStudents(next);
  }

  // ---- 理由 ----
  // 写不回存储时缓存默认理由，保证同一会话内 id 稳定
  let fallbackReasons = null;
  function defaultReasons() {
    return DEFAULT_REASONS.map((r) => ({ id: newId(), label: r.label, delta: r.delta }));
  }
  function getReasons() {
    const v = readJSON(storage, KEYS.reasons, null);
    // 只有键缺失或损坏才写入默认；空数组原样返回
    if (Array.isArray(v)) return objectList(v);
    const def = fallbackReasons || defaultReasons();
    try {
      writeJSON(storage, KEYS.reasons, def);
      fallbackReasons = null;
    } catch {
      fallbackReasons = def;
    }
    return def;
  }
  function setReasons(list) {
    writeJSON(storage, KEYS.reasons, list);
  }
  function addReason(label, delta) {
    const l = typeof label === "string" ? label.trim() : "";
    if (!l || !validDelta(delta)) return null;
    const r = { id: newId(), label: l, delta };
    setReasons([...getReasons(), r]);
    return r;
  }
  // 非法输入时不改动
  function updateReason(id, { label, delta } = {}) {
    const l = typeof label === "string" ? label.trim() : "";
    if (!l || !validDelta(delta)) return;
    setReasons(getReasons().map((r) => (r.id === id ? { ...r, label: l, delta } : r)));
  }
  function removeReason(id) {
    setReasons(getReasons().filter((r) => r.id !== id));
  }
  function moveReason(id, delta) {
    const next = moved(getReasons(), id, delta);
    if (next) setReasons(next);
  }
  function resetReasons() {
    setReasons(defaultReasons());
  }

  // ---- 记录 ----
  function getEvents() {
    return objectList(readJSON(storage, KEYS.events, []));
  }
  function makeEvent({ studentId, label, delta, ts, batchId } = {}) {
    const t = Number.isFinite(ts) ? ts : Date.now();
    const l = typeof label === "string" && label.trim() ? label.trim() : "其他";
    const e = { id: newId(), ts: t, date: localDate(t), studentId, label: l, delta };
    if (batchId != null) e.batchId = batchId;
    return e;
  }
  function addEvent(input) {
    const e = makeEvent(input);
    writeJSON(storage, KEYS.events, [...getEvents(), e]);
    return e;
  }
  // 一次写入多条（全班加分）
  function addEvents(list) {
    const made = (Array.isArray(list) ? list : []).map(makeEvent);
    if (made.length > 0) writeJSON(storage, KEYS.events, [...getEvents(), ...made]);
    return made;
  }
  function removeEvent(id) {
    writeJSON(storage, KEYS.events, getEvents().filter((e) => e.id !== id));
  }
  function removeBatch(batchId) {
    writeJSON(storage, KEYS.events, getEvents().filter((e) => e.batchId !== batchId));
  }
  function clearEvents() {
    writeJSON(storage, KEYS.events, []);
  }

  // ---- 备份恢复 ----
  function exportBackup() {
    return {
      app: "班级积分",
      version: 1,
      exportedAt: new Date().toISOString(),
      class: { name: getClassName() },
      students: getStudents(),
      reasons: getReasons(),
      events: getEvents(),
    };
  }

  // 校验并清洗备份：不是本 App 的备份返回 null
  function parseBackup(obj) {
    const ok =
      isPlainObject(obj) &&
      obj.app === "班级积分" &&
      obj.version === 1 &&
      Array.isArray(obj.students) &&
      Array.isArray(obj.reasons) &&
      Array.isArray(obj.events);
    if (!ok) return null;
    const name = isPlainObject(obj.class) && typeof obj.class.name === "string" && obj.class.name.trim()
      ? Array.from(obj.class.name.trim()).slice(0, CLASS_NAME_MAX).join("")
      : DEFAULT_CLASS_NAME;
    return { name, students: cleanStudents(obj.students), reasons: cleanReasons(obj.reasons), events: cleanEvents(obj.events) };
  }

  // 原子化：先快照五个键的原始字符串，fn 里任何一步写失败就全部写回并返回 { ok: false, error }
  function writeAll(fn) {
    const keys = [KEYS.klass, KEYS.students, KEYS.reasons, KEYS.events, KEYS.version];
    const snapshot = keys.map((key) => {
      try {
        return { key, known: true, raw: storage.getItem(key) };
      } catch {
        return { key, known: false, raw: null };
      }
    });
    try {
      return fn();
    } catch (err) {
      for (const { key, known, raw } of snapshot) {
        if (!known) continue;
        try {
          if (raw == null) storage.removeItem(key);
          else storage.setItem(key, raw);
        } catch (e) {
          console.warn(`[store] 写入失败后写回 ${key} 也失败`, e);
        }
      }
      return { ok: false, error: err.message || FULL_MSG };
    }
  }

  // 恢复：整份覆盖
  function importBackup(obj) {
    const b = parseBackup(obj);
    if (!b) return { ok: false, error: "不是班级积分的备份" };
    return writeAll(() => {
      writeJSON(storage, KEYS.klass, { name: b.name });
      writeJSON(storage, KEYS.students, b.students);
      writeJSON(storage, KEYS.reasons, b.reasons);
      writeJSON(storage, KEYS.events, b.events);
      writeRaw(storage, KEYS.version, "1");
      fallbackReasons = null;
      return { ok: true, counts: { students: b.students.length, reasons: b.reasons.length, events: b.events.length } };
    });
  }

  // 合并另一位老师的备份：不覆盖现有数据，班级名、名单顺序、理由、记录都保留。
  // 学生按姓名匹配（同名沿用本机 id，新名字追加到末尾）；记录按 id 去重、studentId 改写成本机 id；理由按 label 补缺。
  function mergeBackup(obj) {
    const b = parseBackup(obj);
    if (!b) return { ok: false, error: "不是班级积分的备份" };
    return writeAll(() => {
      // 在快照之后读本机数据：理由键缺失时 getReasons 写入的默认值也能一起回滚
      const students = getStudents();
      const reasons = getReasons();
      const events = getEvents();

      // 学生：姓名 → 本机 id；备份 id → 本机 id
      const byName = new Map();
      for (const s of students) {
        const n = typeof s.name === "string" ? s.name.trim() : "";
        if (n && !byName.has(n)) byName.set(n, s.id);
      }
      // 已占用的 id 要连本机记录里的 studentId 一起算：删掉的孩子记录还留着，新学生若沿用那个 id 会把旧分捡走
      const takenIds = new Set(students.map((s) => s.id));
      for (const e of events) takenIds.add(e.studentId);
      const idMap = new Map();
      const newStudents = [];
      for (const s of b.students) {
        if (idMap.has(s.id)) continue;
        let id = byName.get(s.name);
        if (id === undefined) {
          id = takenIds.has(s.id) ? newId() : s.id;
          takenIds.add(id);
          byName.set(s.name, id);
          newStudents.push({ id, name: s.name });
        }
        idMap.set(s.id, id);
      }

      // 记录：id 已在本机的算重复；备份名单里找不到学生的（对方已删）跳过
      const eventIds = new Set(events.map((e) => e.id));
      const newEvents = [];
      let duplicates = 0;
      for (const e of b.events) {
        if (eventIds.has(e.id)) {
          duplicates += 1;
          continue;
        }
        const sid = idMap.get(e.studentId);
        if (sid === undefined) continue;
        eventIds.add(e.id);
        newEvents.push({ ...e, studentId: sid });
      }

      // 理由：本机没有的 label 追加到末尾，已有的不动
      const labels = new Set(reasons.map((r) => (typeof r.label === "string" ? r.label.trim() : r.label)));
      const reasonIds = new Set(reasons.map((r) => r.id));
      const newReasons = [];
      for (const r of b.reasons) {
        if (labels.has(r.label)) continue;
        const id = reasonIds.has(r.id) ? newId() : r.id;
        labels.add(r.label);
        reasonIds.add(id);
        newReasons.push({ id, label: r.label, delta: r.delta });
      }

      writeJSON(storage, KEYS.students, [...students, ...newStudents]);
      writeJSON(storage, KEYS.reasons, [...reasons, ...newReasons]);
      writeJSON(storage, KEYS.events, [...events, ...newEvents]);
      writeRaw(storage, KEYS.version, "1");
      fallbackReasons = null;
      return {
        ok: true,
        counts: { students: newStudents.length, events: newEvents.length, duplicates, reasons: newReasons.length },
      };
    });
  }

  // 版本戳尽力写，存储不可用时吞掉，不能让构造失败
  try {
    storage.setItem(KEYS.version, "1");
  } catch (e) {
    console.warn("[store] 写入版本号失败", e);
  }

  return {
    getClassName, setClassName,
    getStudents, setStudents, addStudent, addStudents, renameStudent, removeStudent, moveStudent,
    getReasons, setReasons, addReason, updateReason, removeReason, moveReason, resetReasons,
    getEvents, addEvent, addEvents, removeEvent, removeBatch, clearEvents,
    exportBackup, importBackup, mergeBackup,
  };
}
