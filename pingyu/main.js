// app/main.js
// 接线：三页切换、标签→评语、换一换/加一句/手改、全班复制导出、名单与积分备份、句库编辑、备份恢复。
import { createStore, openStorage } from "./store.js";
import DEFAULT_BANK from "./bank.js";
import { parseNamesInfo, parsePointsBackup, mergePointsBackup, compose, exportAllInfo, countChars, nextOffsets, writtenMissing, localDate, pointsBackupFromStorage } from "./state.js";
import { isInAppBrowser } from "./env.js";
import { renderWrite, renderAll, renderSettings, openBankEditor, showToast, askConfirm, askText, openSheet, openTextSheet } from "./ui.js";

const { storage, blocked: storageBlocked } = openStorage(() => window.localStorage);
const store = createStore(storage);
const root = document.getElementById("view");
const VIEWS = ["write", "all", "settings"];
const inApp = isInAppBrowser(navigator.userAgent);
const OVERWRITE_CONFIRM = "会覆盖你改过的评语，继续？";
const RESTORE_CONFIRM = "恢复会覆盖手机里现在的全部数据，继续？";
const state = { view: "write", index: 0 };

function bank() { return store.getBank() || DEFAULT_BANK; }
function students() { return store.getStudents(); }
function textFor(st, i) { return compose({ name: st.name, index: i, marks: store.getMark(st.name), bank: bank(), points: store.getPoints()[st.name] || null }); }
// 写操作统一兜底：存储层抛错时 toast 它给的消息，返回是否成功
function save(fn) { try { fn(); return true; } catch (e) { showToast(e?.message || "保存失败"); return false; } }
function hasTags(m) { return Object.values(m.tags || {}).some((v) => typeof v === "string" && v); }

// ---------- 复制（照抄课堂互动） ----------
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
// 先走 clipboard API，失败退老办法；都失败返回 false
async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 落到老办法 */ }
  }
  return legacyCopy(text);
}
// 复制成功 toast；失败弹文本层让老师长按复制
async function copyOut(text, label = "评语", okMsg = null) {
  if (await copyText(text)) showToast(okMsg || `已复制${label}`, okMsg ? 3000 : undefined);
  else openSheet({ title: `${label}，长按复制`, text, onCopy: copyText, label });
}
function readFileText(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error || new Error("read failed")); r.readAsText(file); });
}
function download(text, type, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// 手改保护：有 manual 时先确认；确认后清掉 manual 再执行
async function guarded(name, fn) {
  const m = store.getMark(name);
  if (typeof m.manual === "string" && m.manual.trim()) {
    if (!(await askConfirm(OVERWRITE_CONFIRM))) return;
    if (!save(() => store.setMark(name, { manual: null }))) return;
  }
  fn();
}
function setView(v) {
  state.view = VIEWS.includes(v) ? v : "write";
  document.querySelectorAll(".tab").forEach((b) => { if (b.dataset.view === state.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0, 0);
  render();
}

function render() {
  try { renderView(); } catch (e) { console.error(e); showToast(e?.message || "出错了，刷新试试", 3000); }
}

function renderView() {
  const list = students();
  if (state.index >= list.length) state.index = Math.max(0, list.length - 1);
  root.dataset.view = state.view;
  if (state.view === "write") {
    const st = list[state.index] || null;
    const mark = st ? store.getMark(st.name) : {};
    renderWrite(root, {
      student: st, index: state.index, total: list.length, tags: mark.tags || {}, text: st ? textFor(st, state.index) : "",
      manual: !!(typeof mark.manual === "string" && mark.manual.trim()), hasAnyStudents: list.length > 0,
      onPrev() { state.index = Math.max(0, state.index - 1); render(); },
      onNext() { state.index = Math.min(list.length - 1, state.index + 1); render(); },
      // 第一次点标签（标签从空变非空）锁下座号，之后名单增删这个孩子的句子不跟着变；旧数据没座号的也顺手锁上
      onTag(dim, tag) { guarded(st.name, () => { const m = store.getMark(st.name); const tags = { ...(m.tags || {}) }; if (tags[dim] === tag) delete tags[dim]; else tags[dim] = tag; const patch = { tags }; if (hasTags({ tags }) && (!hasTags(m) || !Number.isInteger(m.seat))) patch.seat = state.index; save(() => store.setMark(st.name, patch)); render(); }); },
      // 换一换：只挪称呼、已点的维度、结尾，并避开左右邻座正在用的同一句
      onShuffle() {
        if (!hasTags(store.getMark(st.name))) { showToast("先点标签"); return; }
        guarded(st.name, () => {
          const m = store.getMark(st.name);
          const nb = (j) => (j >= 0 && j < list.length ? store.getMark(list[j].name) : null);
          const offsets = nextOffsets({ index: state.index, marks: m, neighbors: [nb(state.index - 1), nb(state.index + 1)], neighborIndexes: [state.index - 1, state.index + 1], bank: bank() });
          const patch = { offsets }; if (!Number.isInteger(m.seat)) patch.seat = state.index;
          save(() => store.setMark(st.name, patch)); render();
        });
      },
      async onExtra() { const cur = store.getMark(st.name).extra || ""; const v = await askText("加一句你自己的话（60 字内）", cur, 60); if (v == null) return; guarded(st.name, () => { if (!save(() => store.setMark(st.name, { extra: v.trim() || null }))) return; render(); if (v.trim() && !hasTags(store.getMark(st.name))) showToast("先点标签，这句会加在结尾前", 3000); }); },
      onCopy() { const t = textFor(st, state.index); if (!t) { showToast("还没点标签"); return; } copyOut(t); },
      // 每次输入都存；和生成的一样（或清空）就不算手改。返回是否手改，界面只就地改字数提示
      onTextChange(text) {
        const gen = compose({ name: st.name, index: state.index, marks: { ...store.getMark(st.name), manual: null }, bank: bank(), points: store.getPoints()[st.name] || null });
        const manual = !!text.trim() && text !== gen;
        save(() => store.setMark(st.name, { manual: manual ? text : null }));
        return manual;
      },
      onGoSettings() { setView("settings"); },
    });
  } else if (state.view === "all") {
    const rows = list.map((st, i) => { const m = store.getMark(st.name); const t = textFor(st, i); return { name: st.name, status: !t ? "未点" : (typeof m.manual === "string" && m.manual.trim() ? "已手改" : "已生成"), chars: countChars(t) }; });
    renderAll(root, {
      rows, done: rows.filter((r) => r.status !== "未点").length, total: list.length,
      onOpen(i) { state.index = i; setView("write"); },
      onCopyAll() { const r = exportAllInfo(list, store.getMarks(), bank(), store.getPoints()); if (!r.text) { showToast("还没有评语"); return; } copyOut(r.text, "全班评语", `已复制 ${r.count} 人${r.skipped > 0 ? `，${r.skipped} 人未点已跳过` : ""}`); },
      onExport() {
        const t = exportAllInfo(list, store.getMarks(), bank(), store.getPoints()).text; if (!t) { showToast("还没有评语"); return; }
        if (inApp) { openSheet({ title: "全班评语，长按复制保存", text: t, onCopy: copyText, label: "全班评语" }); return; }
        download(t, "text/plain;charset=utf-8", "评语.txt");
      },
    });
  } else {
    renderSettings(root, {
      namesText: list.map((s) => s.name).join("\n"), inApp,
      // 第一次存名单（之前是空的）存完直接去评语页从第 1 人开始
      async onSaveNames(text) {
        const wasEmpty = list.length === 0; const { names, duplicates } = parseNamesInfo(text);
        const missing = writtenMissing(list.map((s) => s.name), names, store.getMarks());
        if (missing.length > 0 && !(await askConfirm(`${missing.length} 个已写评语的名字不在新名单里，改名会让评语找不到，继续？`))) return;
        if (!save(() => store.setStudentsByNames(names))) return;
        showToast(duplicates > 0 ? `已保存 ${names.length} 人，${duplicates} 个重名只留了一个，可写成 张浩(大)/张浩(小)` : `已保存 ${names.length} 人`, duplicates > 0 ? 4000 : undefined);
        if (wasEmpty && names.length) { state.index = 0; setView("write"); } else render();
      },
      onPastePoints() {
        openTextSheet({ title: "粘贴班级积分的备份", placeholder: "在班级积分里点「备份」，把内容粘到这里", primaryLabel: "带入", onPrimary(text) {
          const r = parsePointsBackup(text); if (!r) { showToast("不是班级积分的备份"); return false; }
          return applyPoints(r);
        } });
      },
      // 同一台设备、同一个网站下的班级积分：直接读它存的名单和记录
      onImportPoints() {
        const obj = pointsBackupFromStorage((k) => window.localStorage.getItem(k));
        const r = obj ? parsePointsBackup(JSON.stringify(obj)) : null;
        if (!r || r.names.length === 0) { showToast("这台设备上没有班级积分的数据，可以用「粘贴积分备份」", 3500); return; }
        applyPoints(r);
      },
      onEditBank() { openBankEditor({ bank: bank(), onSave(b) { if (save(() => store.setBank(b))) showToast("句库已保存"); render(); } }); },
      async onResetBank() { if (!(await askConfirm("把句库恢复成默认？你加的句子会被删掉。"))) return; store.setBank(null); showToast("已恢复默认句库"); render(); },
      onBackup() {
        const json = JSON.stringify(store.exportBackup());
        if (inApp) { openSheet({ title: "备份内容，长按复制保存", text: json, onCopy: copyText, label: "备份内容" }); return; }
        download(json, "application/json", `评语助手-备份-${localDate()}.json`);
      },
      async onRestore(file) { if (!(await askConfirm(RESTORE_CONFIRM))) return; let text; try { text = await readFileText(file); } catch { showToast("读不出这个文件"); return; } restoreFrom(text); },
      onPasteRestore() { openTextSheet({ title: "粘贴备份内容", placeholder: "把之前复制保存的备份内容粘贴到这里", primaryLabel: "恢复", async onPrimary(text) { if (!(await askConfirm(RESTORE_CONFIRM))) return false; return restoreFrom(text); } }); },
    });
  }
}
// 积分备份合并进来；名单从空变非空时和保存名单一样直接去评语页
function applyPoints(r) {
  const wasEmpty = students().length === 0;
  const m = mergePointsBackup(students().map((s) => s.name), store.getPoints(), r);
  if (!save(() => { store.setStudentsByNames(m.names); store.setPoints(m.points); })) return false;
  if (wasEmpty && m.names.length) { state.index = 0; setView("write"); } else render();
  showToast(`已带入 ${r.names.length} 人（新增 ${m.added} 人），${m.withPoints} 人有积分记录${r.duplicates > 0 ? `，${r.duplicates} 个重名已跳过` : ""}`, 4000);
  return true;
}
function restoreFrom(text) {
  let obj; try { obj = JSON.parse(text); } catch { showToast("不是评语助手的备份"); return false; }
  const r = store.importBackup(obj); if (!r.ok) { showToast(r.error || "恢复失败"); return false; }
  state.index = 0; render(); showToast(`已恢复：${r.counts.students} 人，${r.counts.marks} 份评语${r.bankDropped ? "；句库不完整，已用默认句库" : ""}`, r.bankDropped ? 4000 : undefined); return true;
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
setView(students().length === 0 ? "settings" : "write");
if (storageBlocked) showToast("浏览器不让存数据，这次关掉就没了", 5000);
