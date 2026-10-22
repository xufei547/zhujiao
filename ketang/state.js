// 纯函数：名单/清单解析、备份名单识别、洗牌分组、转盘剩余与抽取、倒计时解析与格式化。
// 不碰 DOM、不碰存储；所有随机都可注入，便于测试。

export const NAME_MAX = 20;
export const ITEM_MAX = 100;
export const DURATION_MAX = 6 * 3600; // 倒计时上限 6 小时（秒）

// 按「码点」截断，避免把 emoji 等代理对切成半个字符
function clip(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

// 名单：换行、中英文逗号、顿号、空白都算分隔；去空、先截断再去重（保留首次出现）
// （照抄自 随机点名抽题/app/state.js）
export function parseNames(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/[\n,，、\s]+/)) {
    const name = clip(raw.trim(), NAME_MAX);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// 自定义清单：一行一条，trim、去空、截 100 字；允许重复（同一奖励可以多放几份提高概率）
export function parseListItems(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const item = clip(raw.trim(), ITEM_MAX);
    if (item) out.push(item);
  }
  return out;
}

// 识别「随机点名抽题」「班级积分」等备份 JSON：顶层对象且 students 为数组 → 取每项的字符串 name
// （trim、截 20 字、去空去重，名字内部的空格保留不拆）。
// 不是 JSON、结构不对、或一个有效名字都没有 → null（调用方据此退回按普通名单解析）
export function extractNamesFromBackup(text) {
  const s = String(text ?? "").replace(/^﻿/, "").trim();
  if (!s.startsWith("{")) return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.students)) return null;
  const out = [];
  const seen = new Set();
  for (const st of obj.students) {
    if (!st || typeof st !== "object" || typeof st.name !== "string") continue;
    const name = clip(st.name.trim(), NAME_MAX);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? out : null;
}

// 随机下标 [0, n)，random() 偶尔返回 1 也不越界
function randIndex(n, random) {
  return Math.min(n - 1, Math.floor(random() * n));
}

// Fisher–Yates 洗牌，返回新数组，不改原数组
export function shuffle(arr, random = Math.random) {
  const a = Array.from(arr || []);
  for (let i = a.length - 1; i > 0; i--) {
    const j = randIndex(i + 1, random);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 随机分组：先洗牌，再第 i 个人进第 i mod k 组 → 组间人数差 ≤1。
// mode "count"：n 是组数；mode "size"：n 是每组人数，k = ceil(人数 / n)。n 取整并夹在 [1, 人数]。
export function makeGroups(names, { mode = "count", n } = {}, random = Math.random) {
  const list = Array.from(names || []);
  const len = list.length;
  if (len === 0) return [];
  const v = Math.min(len, Math.max(1, Math.floor(Number(n)) || 1));
  const k = mode === "size" ? Math.ceil(len / v) : v;
  const groups = Array.from({ length: k }, () => []);
  shuffle(list, random).forEach((name, i) => groups[i % k].push(name));
  return groups;
}

// 转盘本轮还能抽的：不在已抽里，保持原顺序；结果为空表示一轮抽完（UI 提示并重置）
export function remaining(ids, drawn) {
  const skip = new Set(drawn || []);
  return (ids || []).filter((id) => !skip.has(id));
}

// 等概率抽一个；池空返回 null
export function pickFrom(pool, random = Math.random) {
  if (!pool || pool.length === 0) return null;
  return pool[randIndex(pool.length, random)];
}

// 倒计时输入 → 秒数。支持：纯数字=分钟（可带小数，可加「分/分钟/m/min」）、m:ss、h:mm:ss、
// 「90s / 90秒」；全角数字与中文冒号先经 NFKC 归一。非法、≤0、超过 6 小时 → null
export function parseDuration(text) {
  const s = String(text ?? "").normalize("NFKC").trim().toLowerCase();
  let sec = null;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:分钟|分|min|m)?$/.exec(s))) {
    sec = Math.round(Number(m[1]) * 60);
  } else if ((m = /^(\d+)\s*(?:s|秒)$/.exec(s))) {
    sec = Number(m[1]);
  } else if ((m = /^(\d+):(\d{1,2})$/.exec(s))) {
    if (Number(m[2]) < 60) sec = Number(m[1]) * 60 + Number(m[2]);
  } else if ((m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s))) {
    if (Number(m[2]) < 60 && Number(m[3]) < 60) sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  if (sec === null || !Number.isFinite(sec) || sec <= 0 || sec > DURATION_MAX) return null;
  return sec;
}

// 秒 → 「mm:ss」，满 1 小时「h:mm:ss」。负数/非法按 0；小数秒向上取整（倒计时惯例：剩 0.2 秒显示 00:01）
export function formatClock(sec) {
  const n = Number(sec);
  const t = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
