// app/main.js
// 接线：状态、页面切换、点名与抽题的滚动动画、投屏模式、朗读、设置、备份恢复、复制。
// 数据每次都从 store 现读，不在内存里缓存名单和题库。
import { createStore, openStorage } from "./store.js";
import { remaining, pickFrom, parseNames, parseBank, isAscii, NAME_MAX } from "./state.js";
import { canSpeak, speak, stopSpeaking } from "./speech.js";
import { isInAppBrowser } from "./env.js";
import {
  renderDraw, renderQuiz, renderSettings, openBankEditor,
  showToast, askConfirm, askText, openSheet, openTextSheet,
} from "./ui.js";

// 禁用 Cookie/存储、隐私模式下 localStorage 可能访问就抛、或者写不进去：试写一次，失败就用内存存储
const { storage, blocked: storageBlocked } = openStorage(() => window.localStorage);
const store = createStore(storage);
const root = document.getElementById("view");
const state = {
  view: "draw",
  rolling: false,
  rollName: "", // 滚动中正在显示的名字；中途整页重渲染（如切投屏）时接着显示它
  landed: false, // 只在落定那一次渲染为 true，播放放大动画
  current: null, // { id, name }：本页刚抽中的人
  fullscreen: false,
  // 抽题页：current = { bankId, id, q, a }；who = { id, name }（同时点名抽中的人）
  // rollQ/rollWho：滚动中显示的「第 N 题」和名字（rollWho 为 null 表示这次不点名）
  quiz: { current: null, who: null, showAnswer: false, rolling: false, rollQ: "", rollWho: null, landed: false },
};
// 进行中的滚动动画的取消函数；恢复备份、改名单/题库时取消，免得旧 id 落定写回新数据
const cancels = { draw: null, quiz: null };
// 微信/小红书内置浏览器下载不了文件，备份要改走复制
const inApp = isInAppBrowser(navigator.userAgent);

const ROLL_TICK = 60; // 每 60ms 换一个名字/题号
const ROLL_TOTAL = 800; // 0.8 秒后停下

const RESTORE_CONFIRM = "恢复会覆盖现在的名单和题库，本轮记录也会清空，继续？";

// ---------- 复制（照抄班级积分，备份要用） ----------

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

// ---------- 点名 ----------

// 通用滚动动画：先 tick 一次，之后每 step 毫秒 tick 一次，ms 毫秒后停下并调用 onLand。
// 返回取消函数：取消后既不再 tick 也不调 onLand（存储只在 onLand 里写，取消就什么都不留）
function roll({ tick, ms = ROLL_TOTAL, step = ROLL_TICK, onLand }) {
  let done = false;
  tick();
  const timer = setInterval(tick, step);
  const end = setTimeout(() => {
    if (done) return;
    done = true;
    clearInterval(timer);
    onLand();
  }, ms);
  return () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(end);
  };
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// 取消所有进行中的滚动（数据被整体换掉之前调用）
function cancelRolls() {
  for (const k of Object.keys(cancels)) {
    if (cancels[k]) cancels[k]();
    cancels[k] = null;
  }
  state.rolling = false;
  state.quiz.rolling = false;
}

// 点名池：本轮未抽且未缺席；空了就开新一轮（缺席也清空）并提示。返回 { students, id } 或 null
function pickStudent(notes) {
  const students = store.getStudents();
  if (students.length === 0) return null;
  const ids = students.map((s) => s.id);
  let round = store.getRound();
  let pool = remaining(ids, round.drawn, round.absent);
  if (pool.length === 0) {
    if (!save(() => store.resetNameRound())) return null;
    notes.push("这一轮都抽过了，重新开始");
    round = store.getRound();
    pool = remaining(ids, round.drawn, round.absent);
  }
  const id = pickFrom(pool);
  return id == null ? null : { students, id };
}

// 落定时把这人记成本轮已抽（顺带从缺席里拿掉）
function markDrawn(r, id) {
  if (!r.drawn.includes(id)) r.drawn.push(id);
  r.absent = r.absent.filter((x) => x !== id);
}

function onDraw() {
  if (state.rolling || state.quiz.rolling) return;
  const notes = [];
  const picked = pickStudent(notes);
  for (const n of notes) showToast(n, 2500);
  if (!picked) return;
  // 落点在动画开始前就定好，但只在落定时写入；中途刷新页面不会留下半截状态
  const { students, id } = picked;
  const finalName = students.find((s) => s.id === id).name;
  const names = students.map((s) => s.name);

  state.rolling = true;
  state.landed = false;
  state.current = null;
  state.rollName = "";
  rerender();
  // 每 60ms 从全部名字里随机挑一个直接改 .stage .name 的文字（不整页重渲染）。
  // 每次都现查节点，中途整页重渲染（切投屏等）也能接着滚
  cancels.draw = roll({
    tick: () => {
      state.rollName = randomOf(names);
      if (state.view !== "draw") return;
      const node = root.querySelector(".stage .name");
      if (node) node.textContent = state.rollName;
    },
    onLand: () => {
      cancels.draw = null;
      state.rolling = false;
      const ok = save(() => {
        const r = store.getRound();
        markDrawn(r, id);
        store.setRound(r);
      });
      if (ok) {
        state.current = { id, name: finalName };
        state.landed = true;
      }
      rerender();
      state.landed = false; // 之后的重渲染不再重播放大动画
    },
  });
}

// 不在：把当前这人从已抽挪到缺席（本轮不算抽过），马上再抽一个
function onAbsent() {
  if (state.rolling || !state.current) return;
  const id = state.current.id;
  const ok = save(() => {
    const r = store.getRound();
    r.drawn = r.drawn.filter((x) => x !== id);
    if (!r.absent.includes(id)) r.absent.push(id);
    store.setRound(r);
  });
  if (!ok) return;
  state.current = null;
  onDraw();
}

async function onReset() {
  if (state.rolling) return;
  const students = store.getStudents();
  const round = store.getRound();
  const valid = new Set(students.map((s) => s.id));
  const drawnN = round.drawn.filter((id) => valid.has(id)).length;
  const absentN = round.absent.filter((id) => valid.has(id)).length;
  if (drawnN + absentN === 0) {
    showToast("本轮还没抽过");
    return;
  }
  const msg = absentN ? `清空本轮已抽的 ${drawnN} 人和缺席的 ${absentN} 人？` : `清空本轮已抽的 ${drawnN} 人？`;
  if (!(await askConfirm(msg, { okLabel: "清空" }))) return;
  if (!save(() => store.resetNameRound())) return;
  state.current = null;
  rerender();
  showToast("已重新开始");
}

// ---------- 抽题 ----------

// 当前题库：偏好里选的还在就用它，否则第一个（并记下这个选择）
function currentBank(banks, prefs) {
  const bank = banks.find((b) => b.id === prefs.bankId) || banks[0] || null;
  if (bank && bank.id !== prefs.bankId) save(() => store.setPrefs({ bankId: bank.id }));
  return bank;
}

function clearQuiz() {
  state.quiz.current = null;
  state.quiz.who = null;
  state.quiz.showAnswer = false;
}

// 朗读状态：speechSynthesis 正在读或排队中
function isSpeaking() {
  if (!canSpeak()) return false;
  try {
    const s = globalThis.speechSynthesis;
    return Boolean(s.speaking || s.pending);
  } catch {
    return false;
  }
}

// 读完后把「停止」按钮改回「朗读」（speech.js 不给结束回调，轮询一下）
let speakWatch = null;
function watchSpeaking() {
  clearInterval(speakWatch);
  speakWatch = setInterval(() => {
    if (isSpeaking()) return;
    clearInterval(speakWatch);
    speakWatch = null;
    const b = root.querySelector(".speak");
    if (b) {
      b.textContent = "朗读";
      b.setAttribute("aria-pressed", "false");
    }
  }, 300);
}

function speakQuestion(q) {
  speak(q, isAscii(q) ? "en-US" : "zh-CN");
  watchSpeaking();
}

function stopAll() {
  stopSpeaking();
  clearInterval(speakWatch);
  speakWatch = null;
}

function onQuizDraw() {
  if (state.rolling || state.quiz.rolling) return;
  const prefs = store.getPrefs();
  const bank = currentBank(store.getBanks(), prefs);
  if (!bank || bank.items.length === 0) return;
  const itemIds = bank.items.map((it) => it.id);
  const notes = [];
  let pool = remaining(itemIds, store.getRound().bankDrawn[bank.id] || [], []);
  if (pool.length === 0) {
    if (!save(() => store.resetBankRound(bank.id))) return;
    notes.push("这套题都抽过了，重新开始");
    pool = itemIds.slice();
  }
  const itemId = pickFrom(pool);
  if (itemId == null) return;
  const item = bank.items.find((it) => it.id === itemId);

  // 同时点名：按点名页的规则先定一个人（共用同一轮）
  let picked = null;
  if (prefs.withName) {
    picked = pickStudent(notes);
    if (!picked && store.getStudents().length === 0) notes.push("名单是空的，这次只抽题");
  }
  // 两条提示合成一条，免得后一条把前一条顶掉
  if (notes.length) showToast(notes.join("；"), 2500);
  const who = picked ? { id: picked.id, name: picked.students.find((s) => s.id === picked.id).name } : null;
  const names = picked ? picked.students.map((s) => s.name) : null;

  stopAll();
  const q = state.quiz;
  q.rolling = true;
  q.landed = false;
  clearQuiz();
  q.rollQ = "";
  q.rollWho = names ? "" : null;
  rerender();
  // 一个动画同时滚：.q 里滚「第 N 题」，.who 里滚名字；只改文字不整页重渲染
  cancels.quiz = roll({
    tick: () => {
      q.rollQ = `第 ${1 + Math.floor(Math.random() * itemIds.length)} 题`;
      if (names) q.rollWho = randomOf(names);
      if (state.view !== "quiz") return;
      const qn = root.querySelector(".stage .q");
      if (qn) qn.textContent = q.rollQ;
      const wn = root.querySelector(".stage .who");
      if (wn && names) wn.textContent = q.rollWho;
    },
    onLand: () => {
      cancels.quiz = null;
      q.rolling = false;
      q.rollWho = null;
      // 题目和人一次写进本轮
      const ok = save(() => {
        const r = store.getRound();
        const list = r.bankDrawn[bank.id] || [];
        if (!list.includes(itemId)) list.push(itemId);
        r.bankDrawn[bank.id] = list;
        if (who) markDrawn(r, who.id);
        store.setRound(r);
      });
      if (ok) {
        q.current = { bankId: bank.id, id: item.id, q: item.q, a: item.a };
        q.who = who;
        q.showAnswer = false;
        q.landed = true;
        // 先开读再渲染，「朗读」按钮一出来就是「停止」
        if (store.getPrefs().autoSpeak && canSpeak() && state.view === "quiz") speakQuestion(item.q);
      }
      rerender();
      q.landed = false;
    },
  });
}

function onQuizBank(id) {
  if (state.quiz.rolling) return;
  stopAll();
  if (!save(() => store.setPrefs({ bankId: id }))) return;
  clearQuiz();
  rerender();
}

function onToggleWithName(v) {
  if (state.quiz.rolling) return; // 滚动中不许切，否则落定结果和开关对不上
  if (!save(() => store.setPrefs({ withName: v }))) return;
  if (!v) state.quiz.who = null;
  rerender();
}

function onToggleAnswer() {
  state.quiz.showAnswer = !state.quiz.showAnswer;
  rerender();
}

function onSpeak() {
  const cur = state.quiz.current;
  if (isSpeaking()) stopAll();
  else if (cur) speakQuestion(cur.q);
  rerender();
}

async function onQuizReset() {
  if (state.quiz.rolling) return;
  const bank = currentBank(store.getBanks(), store.getPrefs());
  if (!bank) return;
  const valid = new Set(bank.items.map((it) => it.id));
  const n = (store.getRound().bankDrawn[bank.id] || []).filter((id) => valid.has(id)).length;
  if (n === 0) {
    showToast("这套题本轮还没抽过");
    return;
  }
  if (!(await askConfirm(`清空这套题本轮已抽的 ${n} 题？`, { okLabel: "清空" }))) return;
  if (!save(() => store.resetBankRound(bank.id))) return;
  stopAll();
  clearQuiz();
  rerender();
  showToast("已重新开始");
}

// ---------- 设置 ----------

// 题库编辑框的预填：一行一题，有答案用｜接上
function bankText(bank) {
  return bank.items.map((it) => (it.a ? `${it.q}｜${it.a}` : it.q)).join("\n");
}

function clip20(s) {
  return Array.from(String(s).trim()).slice(0, NAME_MAX).join("");
}

async function onSaveNames(text) {
  const names = parseNames(text);
  if (names.length === 0) {
    showToast("没有解析到名字");
    return;
  }
  if (!(await askConfirm("会覆盖名单并清空本轮点名，继续？"))) return;
  if (cancels.draw || cancels.quiz) cancelRolls();
  if (!save(() => store.setStudents(names))) return;
  state.current = null;
  state.quiz.who = null;
  rerender();
  showToast(`已保存 ${names.length} 人`);
}

function onAddBank() {
  openBankEditor({
    title: "新建题库",
    onSave(name, text) {
      const items = parseBank(text);
      if (items.length === 0) {
        showToast("没有解析到题目");
        return false;
      }
      let bank = null;
      if (!save(() => { bank = store.addBank(clip20(name), items); })) return false;
      if (!bank) return false;
      rerender();
      showToast(`已新建「${bank.name}」· ${bank.items.length} 题`);
      return true;
    },
  });
}

async function onRenameBank(id) {
  const bank = store.getBanks().find((b) => b.id === id);
  if (!bank) return;
  const name = await askText("题库改名", bank.name, NAME_MAX);
  if (name == null) return;
  if (!name.trim()) {
    showToast("题库名不能为空");
    return;
  }
  if (!save(() => store.renameBank(id, clip20(name)))) return;
  rerender();
  showToast("已改名");
}

function onReplaceBank(id) {
  const bank = store.getBanks().find((b) => b.id === id);
  if (!bank) return;
  openBankEditor({
    title: "替换题目",
    name: bank.name,
    text: bankText(bank),
    onSave(name, text) {
      const items = parseBank(text);
      if (items.length === 0) {
        showToast("没有解析到题目");
        return false;
      }
      // 换题后旧题 id 作废：正在滚的抽题取消，抽题页当前题跟着作废
      if (cancels.quiz) cancelRolls();
      const ok = save(() => {
        store.renameBank(id, clip20(name));
        store.replaceBankItems(id, items);
      });
      if (!ok) return false;
      if (state.quiz.current && state.quiz.current.bankId === id) clearQuiz();
      rerender();
      showToast(`已保存 ${items.length} 题`);
      return true;
    },
  });
}

async function onRemoveBank(id) {
  const bank = store.getBanks().find((b) => b.id === id);
  if (!bank) return;
  if (!(await askConfirm(`删除题库「${bank.name}」？里面的 ${bank.items.length} 题会一起删掉`, { okLabel: "删除" }))) return;
  if (cancels.quiz) cancelRolls();
  if (!save(() => store.removeBank(id))) return;
  if (state.quiz.current && state.quiz.current.bankId === id) clearQuiz();
  rerender();
  showToast("已删除");
}

function onToggleAutoSpeak(v) {
  if (!save(() => store.setPrefs({ autoSpeak: v }))) return;
  rerender();
}

// ---------- 备份恢复（照抄班级积分） ----------

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
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    showToast("不是随机点名抽题的备份");
    return false;
  }
  cancelRolls();
  const res = store.importBackup(obj);
  if (!res.ok) {
    showToast(res.error || "恢复失败");
    rerender(); // 刚才取消了滚动，按钮要恢复可点
    return false;
  }
  stopAll();
  state.current = null;
  clearQuiz();
  rerender();
  showToast(`已恢复：${res.counts.students} 人，${res.counts.banks} 个题库`);
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
  a.download = `随机点名抽题-备份-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000); // 慢的浏览器下载还没开始就撤销会失败
}

async function onRestore(file) {
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

// ---------- 投屏 ----------

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

function goView(view) {
  stopAll();
  if (state.fullscreen) exitFullscreen();
  state.view = view;
  rerender();
}

// ---------- 渲染 ----------

function renderDrawView() {
  const students = store.getStudents();
  const round = store.getRound();
  // 当前抽中的人只在仍是「本轮已抽」时有效：重新开始、改名单、标缺席后都作废
  if (state.current && !(round.drawn.includes(state.current.id) && students.some((s) => s.id === state.current.id))) {
    state.current = null;
  }
  renderDraw(root, {
    students,
    round,
    current: state.current,
    rolling: state.rolling,
    rollName: state.rollName,
    landed: state.landed,
    fullscreen: state.fullscreen,
    onDraw,
    onAbsent,
    onReset,
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
    onGoSettings: () => goView("settings"),
  });
}

function renderQuizView() {
  const banks = store.getBanks();
  const prefs = store.getPrefs();
  const bank = currentBank(banks, prefs);
  const round = store.getRound();
  const students = store.getStudents();
  const q = state.quiz;
  // 当前题只在仍属于选中题库、题还在、且仍是这套题本轮已抽时有效：换题库、重新开始、替换题目后都作废
  if (
    q.current &&
    !(bank && q.current.bankId === bank.id && bank.items.some((it) => it.id === q.current.id) &&
      (round.bankDrawn[bank.id] || []).includes(q.current.id))
  ) {
    clearQuiz();
  }
  // 同时点名的人：名单里还在、仍是本轮已抽才显示（点名页重新开始/标缺席后作废）
  if (q.who && !(students.some((s) => s.id === q.who.id) && round.drawn.includes(q.who.id))) q.who = null;
  renderQuiz(root, {
    banks,
    bankId: bank ? bank.id : null,
    round,
    prefs: store.getPrefs(),
    current: q.current,
    who: q.who,
    showAnswer: q.showAnswer,
    rolling: q.rolling,
    rollQ: q.rollQ,
    rollWho: q.rollWho,
    landed: q.landed,
    fullscreen: state.fullscreen,
    canSpeak: canSpeak(),
    speaking: isSpeaking(),
    onBank: onQuizBank,
    onToggleWithName,
    onDraw: onQuizDraw,
    onToggleAnswer,
    onSpeak,
    onReset: onQuizReset,
    onFullscreen: enterFullscreen,
    onExitFullscreen: exitFullscreen,
    onGoSettings: () => goView("settings"),
  });
}

function renderSettingsView() {
  renderSettings(root, {
    students: store.getStudents(),
    banks: store.getBanks(),
    prefs: store.getPrefs(),
    inApp,
    canSpeak: canSpeak(),
    onSaveNames,
    onAddBank,
    onRenameBank,
    onReplaceBank,
    onRemoveBank,
    onToggleAutoSpeak,
    onBackup,
    onRestore,
    onPasteRestore,
  });
}

function rerender() {
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (state.view === "quiz") renderQuizView();
  else if (state.view === "settings") renderSettingsView();
  else renderDrawView();
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => goView(b.dataset.view));
}
rerender();
if (storageBlocked) showToast("浏览器禁用了存储，本次名单关掉页面就没了", 4000);
