// app/main.js
// 接线：页面切换、投屏、倒计时（引擎 + 提示音 + 闪屏）、转盘（先定结果再转，落定才写存储）、
// 分组（结果只在本页）、计分（持久化）、设置（名单/清单/计分组名/备份恢复）。
// 数据每次都从 store 现读，不在内存里缓存名单和清单。
import { createStore, openStorage } from "./store.js";
import { remaining, pickFrom, parseDuration, parseNames, parseListItems, extractNamesFromBackup, makeGroups, NAME_MAX } from "./state.js";
import { createTimer } from "./timer.js";
import { spinTo } from "./wheel.js";
import { isInAppBrowser } from "./env.js";
import {
  renderTimer, renderWheelPage, renderGroups, renderScores, renderSettings,
  paintClock, showToast, askText, askConfirm, openSheet, openTextSheet, openListEditor,
  defaultGroupName, SCORE_GROUPS_MIN, SCORE_GROUPS_MAX,
} from "./ui.js";

// 禁用 Cookie/存储、隐私模式下 localStorage 可能访问就抛、或者写不进去：试写一次，失败就用内存存储
const { storage, blocked: storageBlocked } = openStorage(() => window.localStorage);
const store = createStore(storage);
const root = document.getElementById("view");
const VIEWS = ["timer", "groups", "wheel", "scores", "settings"];
const state = {
  view: "timer",
  fullscreen: false,
  timer: { done: false, flashing: false },
  // result: { key, text }：本页刚抽到的（只在来源没变时显示）；angle：转盘累计角度，重渲染后摆回原位
  wheel: { spinning: false, result: null, angle: 0 },
  // 分组：result 是本次分组结果（名字二维数组）；names[i] 是改过的组名；out 是划掉的人（这次不参加）。都不存
  groups: { result: null, names: [], out: new Set() },
};
// 微信/小红书内置浏览器下载不了文件，备份要改走复制（设置页用）
const inApp = isInAppBrowser(navigator.userAgent);

const SPIN_MS = 2500;
const FLASH_MS = 1100; // 与 style.css 的 .stage.flash（0.35s × 3）对齐

// ---------- 复制（照抄随机点名抽题，分组「复制结果」和备份要用） ----------

// 老办法复制：隐藏 textarea + execCommand("copy")，给没有/不让用 clipboard API 的内置浏览器
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", ""); // iOS 不弹键盘
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;font-size:16px;";
  const prev = document.activeElement;
  document.body.append(ta);
  let ok = false;
  try {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length); // iOS 上 select() 无效
    ok = document.execCommand("copy") === true;
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (prev && prev.isConnected && typeof prev.focus === "function") prev.focus();
  }
  return ok;
}

// 先走 clipboard API，失败退老办法；都失败返回 false，由文本弹层提示长按复制
async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到老办法
    }
  }
  return legacyCopy(text);
}

// 执行一次写操作；失败 toast 存储层给的消息并返回 false
function save(fn) {
  try {
    fn();
    return true;
  } catch (e) {
    showToast(e?.message || "保存失败");
    return false;
  }
}

// ---------- 提示音（WebAudio 合成，不加载音频文件） ----------

// AudioContext 必须在用户手势里创建/恢复，否则 iOS 不出声：首次点击时建，之后每次点击顺手 resume
let audioCtx = null;
function primeAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  } catch {
    audioCtx = null;
  }
}
document.addEventListener("click", primeAudio, true);

// 三声短音：440Hz 正弦，每声 150ms，声与声之间隔 200ms；音量做个短包络避免爆音
function beep3() {
  try {
    if (!audioCtx) return;
    if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime + 0.02;
    for (let i = 0; i < 3; i++) {
      const start = t0 + i * 0.35;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.01);
      gain.gain.setValueAtTime(0.4, start + 0.13);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    }
  } catch {
    // 出不了声就算了，闪屏和「时间到」照常
  }
}

// ---------- 倒计时 ----------

let flashTimer = null;
const timer = createTimer({
  // 运行中每次 tick 只改大字，不整页重渲染
  onTick: (ms) => {
    if (state.view === "timer") paintClock(root, { remainingMs: ms, running: timer.running, done: state.timer.done });
  },
  onDone: () => {
    state.timer.done = true;
    state.timer.flashing = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.timer.flashing = false;
      const st = root.querySelector(".stage.flash");
      if (st) st.classList.remove("flash");
    }, FLASH_MS);
    beep3();
    if (state.view === "timer") rerender();
    else showToast("倒计时：时间到", 3000);
  },
});

// 切后台回来按真实时间校正（过点了当场响）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") timer.resync();
});

function clearDone() {
  state.timer.done = false;
  state.timer.flashing = false;
  clearTimeout(flashTimer);
}

function setPreset(sec) {
  save(() => store.setPrefs({ lastPreset: sec }));
  clearDone();
  timer.set(sec);
  rerender();
}

async function onCustomPreset() {
  const text = await askText("自定义时长", "", 10, { placeholder: "分钟数，或 分:秒（如 1:30）" });
  if (text == null) return;
  const sec = parseDuration(text);
  if (sec == null) {
    showToast("请输入分钟数，或 分:秒", 2500);
    return;
  }
  setPreset(sec);
}

function onTimerToggle() {
  if (timer.running) {
    // 恰好走到 0 时 pause 会把剩余记成 0 却不触发 onDone：这时改走 tick，让到点流程照常跑
    if (timer.remainingMs() <= 0) timer.tick();
    else timer.pause();
  } else {
    clearDone(); // 到点后再点开始：引擎从上次预设重新开始
    timer.start();
  }
  rerender();
}

function onTimerReset() {
  clearDone();
  timer.reset();
  rerender();
}

// ---------- 转盘 ----------

// 当前来源：偏好里的清单不在了就回到名单（并记下）。返回 { key, labels, keys, sources }
// 名单的 keys 是学生 id，清单的 keys 是条目下标（与 kt_wheel.drawn 的约定一致）
function wheelSource() {
  const lists = store.getLists();
  let key = store.getPrefs().wheelSource;
  if (key !== "students" && !lists.some((l) => l.id === key)) {
    key = "students";
    save(() => store.setPrefs({ wheelSource: "students" }));
  }
  const sources = [{ value: "students", label: "名单" }, ...lists.map((l) => ({ value: l.id, label: l.name }))];
  if (key === "students") {
    const students = store.getStudents();
    return { key, sources, labels: students.map((s) => s.name), keys: students.map((s) => s.id) };
  }
  const list = lists.find((l) => l.id === key);
  return { key, sources, labels: [...list.items], keys: list.items.map((_, i) => i) };
}

function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

async function onSpin() {
  if (state.wheel.spinning) return; // 一次只转一个
  const src = wheelSource();
  if (src.labels.length < 2) return;
  const noRepeat = store.getPrefs().wheelNoRepeat;
  let pool = noRepeat ? remaining(src.keys, store.getWheel().drawn[src.key] || []) : src.keys;
  if (pool.length === 0) {
    if (!save(() => store.resetWheel(src.key))) return;
    showToast("都抽过了，重新开始一轮", 2500);
    pool = remaining(src.keys, store.getWheel().drawn[src.key] || []);
  }
  // 先定结果，动画只是表演
  const picked = pickFrom(pool);
  if (picked == null) return;
  const index = src.keys.indexOf(picked);
  const text = src.labels[index];
  const snapshot = JSON.stringify(src.labels);

  state.wheel.spinning = true;
  state.wheel.result = null;
  rerender(); // 禁用按钮、显示「……」
  const svg = root.querySelector(".wheelwrap svg");
  let spin = Promise.resolve();
  if (svg) {
    svg.getBoundingClientRect(); // 刚插进页面的节点先算一次样式，否则过渡不生效
    spin = spinTo(svg, index, src.labels.length, reducedMotion() ? 0 : SPIN_MS);
    state.wheel.angle = Number(svg.dataset.angle) || 0; // 中途重渲染（切投屏等）直接摆到终点
  }
  try {
    await spin;
  } finally {
    state.wheel.spinning = false;
  }

  // 转的过程中来源或条目被换掉（下标/id 作废）就不记
  const now = wheelSource();
  if (now.key === src.key && JSON.stringify(now.labels) === snapshot) {
    save(() => {
      const drawn = store.getWheel().drawn[src.key] || [];
      // 只有开着「抽过的不再抽」才记已抽，否则关掉开关转几次再打开，「本轮还剩」会无故变少
      if (store.getPrefs().wheelNoRepeat && !drawn.includes(picked)) store.setWheelDrawn(src.key, [...drawn, picked]);
    });
    state.wheel.result = { key: src.key, text };
    showToast(`抽到：${text}`, 2500);
  }
  rerender();
}

function onWheelSource(value) {
  if (state.wheel.spinning) return;
  save(() => store.setPrefs({ wheelSource: value }));
  state.wheel.result = null;
  rerender();
}

function onToggleNoRepeat() {
  if (state.wheel.spinning) return;
  save(() => store.setPrefs({ wheelNoRepeat: !store.getPrefs().wheelNoRepeat }));
  rerender();
}

function onWheelReset() {
  if (state.wheel.spinning) return;
  const src = wheelSource();
  const n = (store.getWheel().drawn[src.key] || []).filter((k) => src.keys.includes(k)).length;
  if (n === 0 && state.wheel.result == null) {
    showToast("本轮还没抽过");
    return;
  }
  if (!save(() => store.resetWheel(src.key))) return;
  state.wheel.result = null;
  rerender();
  showToast("已重新开始");
}

// ---------- 分组（结果只在本页状态里，不存） ----------

// 名单里这次参加的人（没被划掉的）
function activeNames() {
  return store.getStudents().map((s) => s.name).filter((n) => !state.groups.out.has(n));
}

// 第 i 组显示用的名字：改过就用改的，没改用「第 N 组」
function groupName(i) {
  return state.groups.names[i] || defaultGroupName(i);
}

function doGroup() {
  const names = activeNames();
  if (names.length === 0) {
    showToast(store.getStudents().length ? "都划掉了，没人可分" : "先去设置页粘名单");
    return;
  }
  const prefs = store.getPrefs();
  state.groups.result = makeGroups(names, { mode: prefs.groupMode, n: prefs.groupN });
  rerender();
}

function onGroupMode(mode) {
  if (!save(() => store.setPrefs({ groupMode: mode }))) return;
  rerender();
}

function onGroupN(n) {
  if (!save(() => store.setPrefs({ groupN: n }))) return;
  rerender();
}

// 点名字：划掉 / 恢复（本次有效，下次分组排除）
function onToggleOut(name) {
  const out = state.groups.out;
  if (out.has(name)) out.delete(name);
  else out.add(name);
  rerender();
}

async function onRenameGroup(i) {
  const name = await askText("改组名（仅本次）", groupName(i), 20);
  if (name == null) return;
  const n = name.trim();
  if (n) state.groups.names[i] = n;
  else delete state.groups.names[i]; // 清空 = 回到默认组名
  rerender();
}

// 复制文案：每组一行「第1组：甲、乙、丙」，划掉的人不算；改过名的组用新名字
function groupsText() {
  return (state.groups.result || [])
    .map((members, i) => {
      const label = state.groups.names[i] || `第${i + 1}组`;
      return `${label}：${members.filter((m) => !state.groups.out.has(m)).join("、")}`;
    })
    .join("\n");
}

async function onCopyGroups() {
  const text = groupsText();
  if (!text) return;
  if (await copyText(text)) showToast("已复制");
  else openSheet({ title: "分组结果", text, onCopy: copyText, label: "分组结果" });
}

// 名单被覆盖（保存/恢复）后，旧分组结果和划掉记录作废
function clearGroups() {
  state.groups.result = null;
  state.groups.out.clear();
}

// ---------- 计分（分数持久化） ----------

// 改组数：多出来的组补「第 N 组」和 0 分；减少时如果要删掉的组有分数先确认
async function onScoreCount(n) {
  const s = store.getScores();
  const len = s.names.length;
  if (!Number.isInteger(n) || n < SCORE_GROUPS_MIN || n > SCORE_GROUPS_MAX || n === len) return;
  if (n < len) {
    const dropped = s.names.slice(n).filter((_, k) => s.scores[n + k] !== 0);
    if (dropped.length && !(await askConfirm(`减到 ${n} 组，${dropped.join("、")}的分数会删掉，继续？`, { okLabel: "删掉" }))) return;
  }
  // 确认期间可能有别的改动，重新读一次再改
  const cur = store.getScores();
  const names = cur.names.slice(0, n);
  const scores = cur.scores.slice(0, n);
  for (let i = names.length; i < n; i++) {
    names.push(defaultGroupName(i));
    scores.push(0);
  }
  if (!save(() => store.setScores({ names, scores }))) return;
  rerender();
}

async function onRenameScore(i) {
  const s = store.getScores();
  if (i < 0 || i >= s.names.length) return;
  const name = await askText("改组名", s.names[i], 20);
  if (name == null) return;
  const n = Array.from(name.trim()).slice(0, 20).join("");
  if (!n) {
    showToast("组名不能为空");
    return;
  }
  const cur = store.getScores();
  if (i >= cur.names.length) return;
  cur.names[i] = n;
  if (!save(() => store.setScores(cur))) return;
  rerender();
}

// 点 ±1：写存储后返回该组最新分数（页面只改这张卡的数字）；写失败返回 null
function onAddScore(i, delta) {
  if (!save(() => store.addScore(i, delta))) return null;
  const v = store.getScores().scores[i];
  return Number.isInteger(v) ? v : null;
}

async function onResetScores() {
  if (!(await askConfirm("把所有组的分数清零？", { okLabel: "清零" }))) return;
  if (!save(() => store.resetScores())) return;
  rerender();
  showToast("已清零");
}

// ---------- 设置 ----------

const SPINNING_MSG = "转盘还在转，等一下";
const RESTORE_CONFIRM = "恢复会覆盖现在的名单、清单和计分，转盘记录也会清空，继续？";

// 转盘转动中不许改名单/清单（转完要按快照核对才记，改了这次就白转）；返回 true 表示被挡下
function blockedBySpin() {
  if (!state.wheel.spinning) return false;
  showToast(SPINNING_MSG);
  return true;
}

function clip20(s) {
  return Array.from(String(s).trim()).slice(0, NAME_MAX).join("");
}

// 名单框：先认备份 JSON（随机点名抽题/班级积分/本工具的 students[].name），不是再按普通名单拆
async function onSaveNames(text) {
  if (blockedBySpin()) return;
  let names = extractNamesFromBackup(text);
  if (names) showToast(`从备份里读到 ${names.length} 个名字`, 2500);
  else names = parseNames(text);
  if (names.length === 0) {
    showToast("没有解析到名字");
    return;
  }
  if (!(await askConfirm("会覆盖名单，继续？"))) return;
  if (blockedBySpin()) return; // 确认期间可能有人回去点了「转」
  if (!save(() => store.setStudents(names))) return;
  clearGroups();
  if (state.wheel.result && state.wheel.result.key === "students") state.wheel.result = null;
  rerender();
  showToast(`已保存 ${names.length} 人`);
}

function onAddList() {
  openListEditor({
    title: "新建清单",
    onSave(name, text) {
      const items = parseListItems(text);
      if (items.length === 0) {
        showToast("没有解析到条目");
        return false;
      }
      let list = null;
      if (!save(() => { list = store.addList(clip20(name), items); })) return false;
      if (!list) return false;
      rerender();
      showToast(`已新建「${list.name}」· ${list.items.length} 条`);
      return true;
    },
  });
}

async function onRenameList(id) {
  const list = store.getLists().find((l) => l.id === id);
  if (!list) return;
  const name = await askText("清单改名", list.name, NAME_MAX);
  if (name == null) return;
  if (!name.trim()) {
    showToast("清单名不能为空");
    return;
  }
  if (!store.getLists().some((l) => l.id === id)) return; // 期间被删了
  if (!save(() => store.renameList(id, clip20(name)))) return;
  rerender();
  showToast("已改名");
}

function onReplaceList(id) {
  if (blockedBySpin()) return;
  const list = store.getLists().find((l) => l.id === id);
  if (!list) return;
  openListEditor({
    title: "替换条目",
    name: list.name,
    text: list.items.join("\n"),
    onSave(name, text) {
      if (blockedBySpin()) return false;
      const items = parseListItems(text);
      if (items.length === 0) {
        showToast("没有解析到条目");
        return false;
      }
      if (!store.getLists().some((l) => l.id === id)) {
        showToast("这个清单已经不在了");
        return true;
      }
      const ok = save(() => {
        store.renameList(id, clip20(name));
        store.replaceListItems(id, items);
      });
      if (!ok) return false;
      if (state.wheel.result && state.wheel.result.key === id) state.wheel.result = null;
      rerender();
      showToast(`已保存 ${items.length} 条`);
      return true;
    },
  });
}

async function onRemoveList(id) {
  if (blockedBySpin()) return;
  const list = store.getLists().find((l) => l.id === id);
  if (!list) return;
  if (!(await askConfirm(`删除清单「${list.name}」？里面的 ${list.items.length} 条会一起删掉`, { okLabel: "删除" }))) return;
  if (blockedBySpin()) return;
  if (!save(() => store.removeList(id))) return;
  if (state.wheel.result && state.wheel.result.key === id) state.wheel.result = null;
  rerender();
  showToast("已删除");
}

// ---------- 备份恢复（照抄随机点名抽题） ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 本地日期 YYYY-MM-DD，用于备份文件名
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// file.text() 老浏览器没有，用 FileReader 兜底
function readFileText(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsText(file);
  });
}

// 恢复：成功 toast + 重渲染返回 true；不是 JSON / 不是本 App 的备份 / 写不进去时 toast 原因并返回 false
function restoreFrom(text) {
  if (blockedBySpin()) return false;
  let obj;
  try {
    obj = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch {
    showToast("不是课堂互动的备份");
    return false;
  }
  const res = store.importBackup(obj);
  if (!res.ok) {
    showToast(res.error || "恢复失败", 2500);
    return false;
  }
  clearGroups();
  state.groups.names = [];
  state.wheel.result = null;
  // 备份里带着 lastPreset，倒计时引擎要跟着重设，否则高亮预设和大字对不上
  if (!timer.running) { clearDone(); timer.set(store.getPrefs().lastPreset); }
  rerender();
  showToast(`已恢复：${res.counts.students} 人，${res.counts.lists} 个清单`, 2500);
  return true;
}

function onBackup() {
  const json = JSON.stringify(store.exportBackup());
  if (inApp) {
    // 微信/小红书内置浏览器下载不了文件：显示文本让老师复制保存
    openSheet({ title: "备份内容，长按复制保存", text: json, onCopy: copyText, label: "备份内容" });
    return;
  }
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `课堂互动-备份-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000); // 慢的浏览器下载还没开始就撤销会失败
}

async function onRestore(file) {
  if (blockedBySpin()) return;
  if (!(await askConfirm(RESTORE_CONFIRM))) return;
  let text;
  try {
    text = await readFileText(file);
  } catch {
    showToast("读不出这个文件");
    return;
  }
  restoreFrom(text);
}

function onPasteRestore() {
  openTextSheet({
    title: "粘贴备份内容",
    placeholder: "把之前复制保存的备份内容粘贴到这里",
    primaryLabel: "恢复",
    async onPrimary(text) {
      if (!(await askConfirm(RESTORE_CONFIRM))) return false;
      return restoreFrom(text);
    },
  });
}

// ---------- 投屏（照抄随机点名抽题） ----------

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

// 进入大字模式：页面样式先切过去；浏览器全屏尽力而为，iPhone Safari 等不支持或被拒都忽略
function enterFullscreen() {
  state.fullscreen = true;
  document.body.classList.add("fullscreen");
  rerender();
  const de = document.documentElement;
  const req = de.requestFullscreen || de.webkitRequestFullscreen;
  if (!req) return;
  try {
    const r = req.call(de);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    // 忽略
  }
}

function exitFullscreen() {
  state.fullscreen = false;
  document.body.classList.remove("fullscreen");
  rerender();
  if (!fsElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const r = exit.call(document);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    // 忽略
  }
}

// 用户按 Esc / 系统手势退出浏览器全屏时，大字模式一起退
function onFullscreenChange() {
  if (!fsElement() && state.fullscreen) exitFullscreen();
}
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);
// 浏览器全屏没进成（只是页面大字模式）时，Esc 也能退；有弹层时 Esc 留给弹层
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.fullscreen || fsElement()) return;
  if (document.querySelector(".sheet-mask")) return;
  exitFullscreen();
});

// 切页：倒计时和转盘在后台继续（到点照样响、转完照样记）
function goView(view) {
  if (!VIEWS.includes(view)) return;
  if (state.fullscreen) exitFullscreen();
  state.view = view;
  rerender();
}

// ---------- 渲染 ----------

function renderTimerView() {
  renderTimer(root, {
    presetSec: store.getPrefs().lastPreset,
    remainingMs: timer.remainingMs(),
    running: timer.running,
    done: state.timer.done,
    flashing: state.timer.flashing,
    fullscreen: state.fullscreen,
    onPreset: setPreset,
    onCustom: onCustomPreset,
    onToggle: onTimerToggle,
    onReset: onTimerReset,
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
  });
}

function renderWheelView() {
  const src = wheelSource();
  const prefs = store.getPrefs();
  const w = state.wheel;
  if (w.result && w.result.key !== src.key) w.result = null;
  renderWheelPage(root, {
    sources: src.sources,
    source: src.key,
    sourceIsStudents: src.key === "students",
    labels: src.labels,
    noRepeat: prefs.wheelNoRepeat,
    left: remaining(src.keys, store.getWheel().drawn[src.key] || []).length,
    spinning: w.spinning,
    result: w.result ? w.result.text : null,
    angle: w.angle,
    fullscreen: state.fullscreen,
    onSource: onWheelSource,
    onToggleNoRepeat,
    onSpin,
    onReset: onWheelReset,
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
    onGoSettings: () => goView("settings"),
  });
}

function renderGroupsView() {
  const prefs = store.getPrefs();
  const roster = store.getStudents().map((s) => s.name);
  const out = state.groups.out;
  const g = state.groups;
  renderGroups(root, {
    total: roster.length,
    active: roster.filter((n) => !out.has(n)).length,
    mode: prefs.groupMode,
    n: prefs.groupN,
    groups: g.result
      ? g.result.map((members, i) => ({ name: groupName(i), members: members.map((name) => ({ name, out: out.has(name) })) }))
      : null,
    // 分好后不在任何卡里的被划掉的人（卡里的直接在卡上点回来）
    absent: roster.filter((n) => out.has(n) && !(g.result || []).some((m) => m.includes(n))),
    fullscreen: state.fullscreen,
    onMode: onGroupMode,
    onN: onGroupN,
    onGroup: doGroup,
    onRegroup: doGroup,
    onCopy: onCopyGroups,
    onRename: onRenameGroup,
    onToggleOut,
    onGoSettings: () => goView("settings"),
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
  });
}

function renderScoresView() {
  const s = store.getScores();
  renderScores(root, {
    names: s.names,
    scores: s.scores,
    fullscreen: state.fullscreen,
    onCount: onScoreCount,
    onRename: onRenameScore,
    onAdd: onAddScore,
    onReset: onResetScores,
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
  });
}

function renderSettingsView() {
  renderSettings(root, {
    students: store.getStudents(),
    lists: store.getLists(),
    scores: store.getScores(),
    inApp,
    onSaveNames,
    onAddList,
    onRenameList,
    onReplaceList,
    onRemoveList,
    onScoreCount,
    onRenameScore,
    onBackup,
    onRestore,
    onPasteRestore,
  });
}

function rerender() {
  root.dataset.view = state.view; // 投屏样式按页区分
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  try {
    if (state.view === "wheel") renderWheelView();
    else if (state.view === "groups") renderGroupsView();
    else if (state.view === "scores") renderScoresView();
    else if (state.view === "settings") renderSettingsView();
    else renderTimerView();
  } catch (e) {
    console.error(e);
    showToast(e?.message || "出错了，刷新试试", 3000);
  }
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => goView(b.dataset.view));
}
timer.set(store.getPrefs().lastPreset);
rerender();
if (storageBlocked) showToast("浏览器禁用了存储，本次数据关掉页面就没了", 4000);
