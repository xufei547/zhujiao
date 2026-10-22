// app/store.js
// localStorage 读写：名单、自定义清单、小组计分、偏好、转盘记录、备份恢复。存储被禁用时由 openStorage 退回内存存储。

export const KEYS = { students: "kt_students", lists: "kt_lists", scores: "kt_scores", prefs: "kt_prefs", wheel: "kt_wheel", version: "kt_version" };

export const DEFAULT_PREFS = Object.freeze({ groupMode: "count", groupN: 4, wheelSource: "students", wheelNoRepeat: true, lastPreset: 60 });

export const DEFAULT_SCORES = Object.freeze({ names: Object.freeze(["第 1 组", "第 2 组", "第 3 组", "第 4 组"]), scores: Object.freeze([0, 0, 0, 0]) });

const APP_NAME = "课堂互动";
const FULL_MSG = "没存上，可能是隐私模式";
const GROUP_N_MIN = 2, GROUP_N_MAX = 12;      // 分组步进器范围
const SCORE_GROUPS_MIN = 2, SCORE_GROUPS_MAX = 8; // 计分组数范围
const PRESET_MAX = 6 * 3600;                    // 倒计时上限 6 小时（秒）

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

function trimmed(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// 名单：只留 {id: 非空 string, name: 非空 string}；脏元素（null/原始值/缺字段）滤掉
function cleanStudents(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && trimmed(x.name))
    .map((x) => ({ id: x.id, name: x.name.trim() }));
}

// 清单条目：只留字符串，trim 后去空；允许重复
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).map(trimmed).filter(Boolean);
}

// 清单：id/name 字符串且 items 是数组，条目逐条清洗
function cleanLists(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && trimmed(x.name) && Array.isArray(x.items))
    .map((x) => ({ id: x.id, name: x.name.trim(), items: cleanItems(x.items) }));
}

// 计分合法：2～8 组，组名全是字符串，分数全是整数，长度一致
function validScores(v) {
  return (
    isPlainObject(v) &&
    Array.isArray(v.names) &&
    Array.isArray(v.scores) &&
    v.names.length === v.scores.length &&
    v.names.length >= SCORE_GROUPS_MIN &&
    v.names.length <= SCORE_GROUPS_MAX &&
    v.names.every((n) => typeof n === "string") &&
    v.scores.every((n) => Number.isInteger(n))
  );
}

function defaultScores() {
  return { names: [...DEFAULT_SCORES.names], scores: [...DEFAULT_SCORES.scores] };
}

// 不合法就退回默认 4 组；总是返回新数组，调用方改了也不影响存储
function cleanScores(v) {
  return validScores(v) ? { names: [...v.names], scores: [...v.scores] } : defaultScores();
}

// 转盘记录：名单存学生 id（字符串），清单存条目下标（非负整数）；其他元素滤掉
function cleanDrawnList(arr) {
  return (Array.isArray(arr) ? arr : []).filter((x) => (typeof x === "string" && x) || (Number.isInteger(x) && x >= 0));
}

function emptyWheel() {
  return { drawn: {} };
}

function cleanWheel(v) {
  if (!isPlainObject(v) || !isPlainObject(v.drawn)) return emptyWheel();
  const drawn = {};
  for (const [k, arr] of Object.entries(v.drawn)) {
    if (Array.isArray(arr)) drawn[k] = cleanDrawnList(arr);
  }
  return { drawn };
}

// 偏好：只取已知键且类型/范围正确，其余沿用 base
function cleanPrefs(v, base = DEFAULT_PREFS) {
  const p = { ...base };
  if (!isPlainObject(v)) return p;
  if (v.groupMode === "count" || v.groupMode === "size") p.groupMode = v.groupMode;
  if (isIntIn(v.groupN, GROUP_N_MIN, GROUP_N_MAX)) p.groupN = v.groupN;
  if (typeof v.wheelSource === "string" && v.wheelSource) p.wheelSource = v.wheelSource;
  if (typeof v.wheelNoRepeat === "boolean") p.wheelNoRepeat = v.wheelNoRepeat;
  if (isIntIn(v.lastPreset, 1, PRESET_MAX)) p.lastPreset = v.lastPreset;
  return p;
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
    st.setItem("__kt_probe", "1");
    st.removeItem("__kt_probe");
    return { storage: st, blocked: false };
  } catch {
    return { storage: memoryStorage(), blocked: true };
  }
}

export function createStore(storage) {
  // ---- 转盘记录 ----
  function getWheel() {
    return cleanWheel(readJSON(storage, KEYS.wheel, null));
  }
  function setWheelDrawn(sourceKey, arr) {
    const w = getWheel();
    writeJSON(storage, KEYS.wheel, { drawn: { ...w.drawn, [sourceKey]: cleanDrawnList(arr) } });
  }
  // 重置一个来源的本轮记录（置空数组），其他来源不动
  function resetWheel(sourceKey) {
    setWheelDrawn(sourceKey, []);
  }
  function dropWheel(sourceKey) {
    const w = getWheel();
    if (!Object.prototype.hasOwnProperty.call(w.drawn, sourceKey)) return;
    const { [sourceKey]: _gone, ...rest } = w.drawn;
    writeJSON(storage, KEYS.wheel, { drawn: rest });
  }

  // ---- 名单 ----
  function getStudents() {
    return cleanStudents(readJSON(storage, KEYS.students, []));
  }
  // 用已解析的名字整体覆盖名单（全部新 id），旧 id 作废，所以名单的转盘记录一并清空
  function setStudents(names) {
    const list = (Array.isArray(names) ? names : []).map(trimmed).filter(Boolean).map((name) => ({ id: newId(), name }));
    writeJSON(storage, KEYS.students, list);
    resetWheel("students");
    return list;
  }

  // ---- 自定义清单 ----
  function getLists() {
    return cleanLists(readJSON(storage, KEYS.lists, []));
  }
  function setLists(list) {
    writeJSON(storage, KEYS.lists, list);
  }
  function addList(name, items) {
    const n = trimmed(name);
    if (!n) return null;
    const list = { id: newId(), name: n, items: cleanItems(items) };
    setLists([...getLists(), list]);
    return list;
  }
  // 空名字不改
  function renameList(id, name) {
    const n = trimmed(name);
    if (!n) return;
    setLists(getLists().map((l) => (l.id === id ? { ...l, name: n } : l)));
  }
  // 换条目后旧下标作废，该清单的转盘记录清空
  function replaceListItems(id, items) {
    setLists(getLists().map((l) => (l.id === id ? { ...l, items: cleanItems(items) } : l)));
    resetWheel(id);
  }
  // 删清单：连带删它的转盘记录；转盘正在转它就回到名单
  function removeList(id) {
    setLists(getLists().filter((l) => l.id !== id));
    dropWheel(id);
    if (getPrefs().wheelSource === id) setPrefs({ wheelSource: "students" });
  }

  // ---- 小组计分 ----
  function getScores() {
    return cleanScores(readJSON(storage, KEYS.scores, null));
  }
  // 不合法（组数不在 2～8、长度不一致、组名非字符串、分数非整数）直接不写
  function setScores(v) {
    if (!validScores(v)) return;
    writeJSON(storage, KEYS.scores, { names: [...v.names], scores: [...v.scores] });
  }
  // 下标越界或 delta 不是整数时忽略；允许减到负分
  function addScore(i, delta) {
    const s = getScores();
    if (!Number.isInteger(i) || i < 0 || i >= s.scores.length || !Number.isInteger(delta)) return;
    s.scores[i] += delta;
    setScores(s);
  }
  // 只清分数，组名和组数不动
  function resetScores() {
    const s = getScores();
    setScores({ names: s.names, scores: s.scores.map(() => 0) });
  }

  // ---- 偏好 ----
  function getPrefs() {
    return cleanPrefs(readJSON(storage, KEYS.prefs, null));
  }
  function setPrefs(partial) {
    const p = cleanPrefs(partial, getPrefs());
    writeJSON(storage, KEYS.prefs, p);
    return p;
  }

  // ---- 备份恢复 ----
  function exportBackup() {
    return {
      app: APP_NAME,
      version: 1,
      exportedAt: new Date().toISOString(),
      students: getStudents(),
      lists: getLists(),
      scores: getScores(),
      prefs: getPrefs(),
    };
  }

  function importBackup(obj) {
    const ok =
      isPlainObject(obj) &&
      obj.app === APP_NAME &&
      obj.version === 1 &&
      Array.isArray(obj.students) &&
      Array.isArray(obj.lists);
    if (!ok) return { ok: false, error: "不是课堂互动的备份" };

    // 先全部校验清洗，再一次性写入
    const students = cleanStudents(obj.students);
    const lists = cleanLists(obj.lists);
    const scores = cleanScores(obj.scores);
    const prefs = cleanPrefs(obj.prefs);
    // 转盘来源指向备份里没有的清单就回到名单
    if (prefs.wheelSource !== "students" && !lists.some((l) => l.id === prefs.wheelSource)) prefs.wheelSource = "students";

    // 原子化：先快照全部键的原始字符串，任何一步写失败就全部写回
    const keys = [KEYS.students, KEYS.lists, KEYS.scores, KEYS.wheel, KEYS.prefs, KEYS.version];
    const snapshot = keys.map((key) => {
      try {
        return { key, known: true, raw: storage.getItem(key) };
      } catch {
        return { key, known: false, raw: null };
      }
    });
    try {
      writeJSON(storage, KEYS.students, students);
      writeJSON(storage, KEYS.lists, lists);
      writeJSON(storage, KEYS.scores, scores);
      writeJSON(storage, KEYS.wheel, emptyWheel()); // 新数据的 id/下标和旧记录对不上，清空
      writeJSON(storage, KEYS.prefs, prefs);
      writeRaw(storage, KEYS.version, "1");
    } catch (err) {
      for (const { key, known, raw } of snapshot) {
        if (!known) continue;
        try {
          if (raw == null) storage.removeItem(key);
          else storage.setItem(key, raw);
        } catch (e) {
          console.warn(`[store] 恢复失败后写回 ${key} 也失败`, e);
        }
      }
      return { ok: false, error: err.message || FULL_MSG };
    }
    const items = lists.reduce((n, l) => n + l.items.length, 0);
    return { ok: true, counts: { students: students.length, lists: lists.length, items } };
  }

  // 版本戳尽力写，存储不可用时吞掉，不能让构造失败
  try {
    storage.setItem(KEYS.version, "1");
  } catch (e) {
    console.warn("[store] 写入版本号失败", e);
  }

  return {
    getStudents, setStudents,
    getLists, addList, renameList, replaceListItems, removeList,
    getScores, setScores, addScore, resetScores,
    getPrefs, setPrefs,
    getWheel, setWheelDrawn, resetWheel,
    exportBackup, importBackup,
  };
}
