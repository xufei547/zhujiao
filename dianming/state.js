// 纯函数：名单/题库解析、剩余池计算、随机抽取。不碰 DOM、不碰存储。

export const NAME_MAX = 20;
export const TEXT_MAX = 500;

// 按「码点」截断，避免把 emoji 等代理对切成半个字符
function clip(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

// 名单：换行、中英文逗号、顿号、空白都算分隔；去空、先截断再去重（保留首次出现）
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

// 题库：一行一题；第一个「｜」「|」或 Tab 之前是题目、之后是答案（可无）；题目为空的行跳过
export function parseBank(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /[｜|\t]/.exec(line);
    const q = clip((m ? line.slice(0, m.index) : line).trim(), TEXT_MAX);
    const a = m ? clip(line.slice(m.index + 1).trim(), TEXT_MAX) : "";
    if (!q) continue;
    out.push({ q, a });
  }
  return out;
}

// 本轮还能抽的：不在已抽、也不在缺席里，保持原顺序
export function remaining(ids, drawn, absent) {
  const skip = new Set([...(drawn || []), ...(absent || [])]);
  return (ids || []).filter((id) => !skip.has(id));
}

// 等概率抽一个；池空返回 null
export function pickFrom(pool, random = Math.random) {
  if (!pool || pool.length === 0) return null;
  const i = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[i];
}

// 全是 ASCII 可打印字符与空白 → true（朗读时据此选 en-US）
export function isAscii(text) {
  return /^[\x20-\x7E\t\n\r\f\v]*$/.test(String(text ?? ""));
}
