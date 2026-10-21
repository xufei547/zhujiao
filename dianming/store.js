// app/store.js
// localStorage 读写：名单、题库、抽取轮次、偏好、备份恢复。存储被禁用时由 openStorage 退回内存存储。

export const KEYS = { students: "dm_students", banks: "dm_banks", round: "dm_round", prefs: "dm_prefs", version: "dm_version" };

export const DEFAULT_PREFS = Object.freeze({ bankId: null, withName: false, autoSpeak: false });

const APP_NAME = "随机点名抽题";
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

function trimmed(v) {
  return typeof v === "string" ? v.trim() : "";
}

// 字符串数组：不是数组按空；非字符串元素滤掉
function stringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

// 名单：只留 {id: 非空 string, name: 非空 string}；脏元素（null/原始值/缺字段）滤掉
function cleanStudents(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && trimmed(x.name))
    .map((x) => ({ id: x.id, name: x.name.trim() }));
}

// 题目：id/q 必须是字符串（q 去空白后非空），a 不是字符串就置空串
function cleanItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && trimmed(x.q))
    .map((x) => ({ id: x.id, q: x.q, a: typeof x.a === "string" ? x.a : "" }));
}

// 题库：id/name 字符串且 items 是数组，题目逐条清洗
function cleanBanks(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isPlainObject(x) && typeof x.id === "string" && x.id && trimmed(x.name) && Array.isArray(x.items))
    .map((x) => ({ id: x.id, name: x.name.trim(), items: cleanItems(x.items) }));
}

// 新题目配新 id；q 不是非空字符串的跳过
function makeItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((x) => isPlainObject(x) && trimmed(x.q))
    .map((x) => ({ id: newId(), q: x.q, a: typeof x.a === "string" ? x.a : "" }));
}

function emptyRound() {
  return { drawn: [], absent: [], bankDrawn: {} };
}

// 轮次：字段类型不对就归默认
function cleanRound(v) {
  if (!isPlainObject(v)) return emptyRound();
  const bankDrawn = {};
  if (isPlainObject(v.bankDrawn)) {
    for (const [k, ids] of Object.entries(v.bankDrawn)) {
      if (Array.isArray(ids)) bankDrawn[k] = stringList(ids);
    }
  }
  return { drawn: stringList(v.drawn), absent: stringList(v.absent), bankDrawn };
}

// 偏好：只取三个已知键且类型正确，其余用默认
function cleanPrefs(v, base = DEFAULT_PREFS) {
  const p = { ...base };
  if (!isPlainObject(v)) return p;
  if (v.bankId === null || (typeof v.bankId === "string" && v.bankId)) p.bankId = v.bankId;
  if (typeof v.withName === "boolean") p.withName = v.withName;
  if (typeof v.autoSpeak === "boolean") p.autoSpeak = v.autoSpeak;
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
    st.setItem("__dm_probe", "1");
    st.removeItem("__dm_probe");
    return { storage: st, blocked: false };
  } catch {
    return { storage: memoryStorage(), blocked: true };
  }
}

export function createStore(storage) {
  // ---- 轮次 ----
  function getRound() {
    return cleanRound(readJSON(storage, KEYS.round, null));
  }
  function setRound(round) {
    writeJSON(storage, KEYS.round, cleanRound(round));
  }
  // 点名轮次全局唯一：已抽、缺席都清空，题库轮次不动
  function resetNameRound() {
    setRound({ ...getRound(), drawn: [], absent: [] });
  }
  function resetBankRound(bankId) {
    const r = getRound();
    setRound({ ...r, bankDrawn: { ...r.bankDrawn, [bankId]: [] } });
  }

  // ---- 名单 ----
  function getStudents() {
    return cleanStudents(readJSON(storage, KEYS.students, []));
  }
  // 用已解析的名字整体覆盖名单（全部新 id），旧 id 作废，所以点名轮次一并清空
  function setStudents(names) {
    const list = (Array.isArray(names) ? names : []).map(trimmed).filter(Boolean).map((name) => ({ id: newId(), name }));
    writeJSON(storage, KEYS.students, list);
    resetNameRound();
    return list;
  }

  // ---- 题库 ----
  function getBanks() {
    return cleanBanks(readJSON(storage, KEYS.banks, []));
  }
  function setBanks(list) {
    writeJSON(storage, KEYS.banks, list);
  }
  function addBank(name, items) {
    const n = trimmed(name);
    if (!n) return null;
    const bank = { id: newId(), name: n, items: makeItems(items) };
    setBanks([...getBanks(), bank]);
    return bank;
  }
  // 空名字不改
  function renameBank(id, name) {
    const n = trimmed(name);
    if (!n) return;
    setBanks(getBanks().map((b) => (b.id === id ? { ...b, name: n } : b)));
  }
  // 换题后旧题 id 作废，该题库的本轮记录清空
  function replaceBankItems(id, items) {
    setBanks(getBanks().map((b) => (b.id === id ? { ...b, items: makeItems(items) } : b)));
    resetBankRound(id);
  }
  // 删题库：连带删它的轮次；当前选中的是它就置空
  function removeBank(id) {
    setBanks(getBanks().filter((b) => b.id !== id));
    const r = getRound();
    if (Object.prototype.hasOwnProperty.call(r.bankDrawn, id)) {
      const { [id]: _gone, ...rest } = r.bankDrawn;
      setRound({ ...r, bankDrawn: rest });
    }
    if (getPrefs().bankId === id) setPrefs({ bankId: null });
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
      banks: getBanks(),
      prefs: getPrefs(),
    };
  }

  function importBackup(obj) {
    const ok =
      isPlainObject(obj) &&
      obj.app === APP_NAME &&
      obj.version === 1 &&
      Array.isArray(obj.students) &&
      Array.isArray(obj.banks);
    if (!ok) return { ok: false, error: "不是随机点名抽题的备份" };

    // 先全部校验清洗，再一次性写入
    const students = cleanStudents(obj.students);
    const banks = cleanBanks(obj.banks);
    const prefs = cleanPrefs(obj.prefs);
    // 选中的题库不在备份里就置空，避免指向不存在的题库
    if (prefs.bankId !== null && !banks.some((b) => b.id === prefs.bankId)) prefs.bankId = null;

    // 原子化：先快照五个键的原始字符串，任何一步写失败就全部写回
    const keys = [KEYS.students, KEYS.banks, KEYS.round, KEYS.prefs, KEYS.version];
    const snapshot = keys.map((key) => {
      try {
        return { key, known: true, raw: storage.getItem(key) };
      } catch {
        return { key, known: false, raw: null };
      }
    });
    try {
      writeJSON(storage, KEYS.students, students);
      writeJSON(storage, KEYS.banks, banks);
      writeJSON(storage, KEYS.round, emptyRound());
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
    const items = banks.reduce((n, b) => n + b.items.length, 0);
    return { ok: true, counts: { students: students.length, banks: banks.length, items } };
  }

  // 版本戳尽力写，存储不可用时吞掉，不能让构造失败
  try {
    storage.setItem(KEYS.version, "1");
  } catch (e) {
    console.warn("[store] 写入版本号失败", e);
  }

  return {
    getStudents, setStudents,
    getBanks, addBank, renameBank, replaceBankItems, removeBank,
    getRound, setRound, resetNameRound, resetBankRound,
    getPrefs, setPrefs,
    exportBackup, importBackup,
  };
}
