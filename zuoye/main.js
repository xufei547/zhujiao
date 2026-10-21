// app/main.js
import { createStore, openStorage } from "./store.js";
import { nextStatus, mergeAllDone, todayKey, shiftDay } from "./state.js";
import { composeAll, composeOne, formatDate, DEFAULT_TEMPLATE } from "./copy.js";
import { isInAppBrowser } from "./env.js";
import { renderToday, renderList, showToast, openSheet, openTextSheet, askConfirm } from "./ui.js";

// 禁用 Cookie/存储、隐私模式下 localStorage 可能访问就抛、或者写不进去：试写一次，失败就用内存存储
const { storage, blocked: storageBlocked } = openStorage(() => window.localStorage);
const store = createStore(storage);
const root = document.getElementById("view");
const state = { view: "today", dateKey: todayKey() };
let lastToday = state.dateKey; // 上次计算的「今天」，用于跨午夜刷新
const inApp = isInAppBrowser(navigator.userAgent);

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

// 恢复：成功 toast + 重渲染返回 true；格式不对/写不进去 alert 返回 false
function restoreFrom(json) {
  try {
    store.importBackup(json);
  } catch (e) {
    alert(e?.message || "恢复失败");
    return false;
  }
  showToast("已恢复");
  rerender();
  return true;
}

function rerender() {
  for (const b of document.querySelectorAll(".tab")) {
    const on = b.dataset.view === state.view;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (state.view === "today") {
    const students = store.getStudents();
    const subjects = store.getSubjects();
    renderToday(root, {
      dateKey: state.dateKey,
      students,
      subjects,
      dayRecords: store.getDayRecords(state.dateKey),
      onCell(sid, subId) {
        const cur = (store.getDayRecords(state.dateKey)[sid] || {})[subId] || null;
        try {
          store.setStatus(state.dateKey, sid, subId, nextStatus(cur));
        } catch (e) {
          showToast(e?.message || "保存失败");
          return;
        }
        rerender();
      },
      onName(sid) {
        const stu = students.find((s) => s.id === sid);
        const rec = store.getDayRecords(state.dateKey)[sid];
        const text = composeOne({ dateKey: state.dateKey, student: stu, subjects, record: rec, template: store.getTemplate() });
        openSheet({ title: `${stu.name} · ${formatDate(state.dateKey)}`, text, onCopy: copyText });
      },
      onPrev() { state.dateKey = shiftDay(state.dateKey, -1); rerender(); },
      onNext() { state.dateKey = shiftDay(state.dateKey, 1); rerender(); },
      onToday() { state.dateKey = todayKey(); lastToday = state.dateKey; rerender(); },
      async onAllDone() {
        const dateKey = state.dateKey;
        if (!(await askConfirm(`把 ${formatDate(dateKey)} 所有孩子的所有科目都设为「完成」？已登记的会改成完成。`))) return;
        try {
          // 逐个孩子合并，已删除孩子/科目的历史保留
          store.setDayRecords(dateKey, mergeAllDone(store.getDayRecords(dateKey), store.getStudents(), store.getSubjects()));
        } catch (e) {
          showToast(e?.message || "保存失败");
          return;
        }
        rerender();
      },
      async onCopyAll() {
        const { text, count } = composeAll({ dateKey: state.dateKey, students, subjects, dayRecords: store.getDayRecords(state.dateKey), template: store.getTemplate() });
        if (count === 0) return showToast("今天还没登记");
        if (await copyText(text)) return showToast(`已复制 ${count} 个孩子`);
        // 两条路都不通（内置浏览器常见）：弹出文本让老师长按复制
        openSheet({ title: "全部 · " + formatDate(state.dateKey), text, onCopy: copyText });
      },
      onGoList() { state.view = "list"; rerender(); },
    });
  } else {
    const save = (fn, msg, { redraw = true } = {}) => {
      try {
        fn();
      } catch (e) {
        showToast(e?.message || "保存失败");
        return false;
      }
      if (redraw) rerender();
      if (msg) showToast(msg);
      return true;
    };
    renderList(root, {
      students: store.getStudents(),
      subjects: store.getSubjects(),
      template: store.getTemplate(),
      inApp,
      onStudents(list) { return save(() => store.setStudents(list.map((s) => (s.id ? s : { ...s, id: store.newId() })))); },
      onSubjects(list) {
        if (list.length === 0) {
          showToast("至少保留一个科目");
          return false;
        }
        return save(() => store.setSubjects(list.map((s) => (s.id ? s : { ...s, id: store.newId() }))));
      },
      onTemplate(t) {
        // 改单个字段只保存不重渲染，免得丢键盘焦点；恢复默认要把输入框刷回默认值
        if (t) save(() => store.setTemplate(t), "已保存", { redraw: false });
        else save(() => store.setTemplate({ ...DEFAULT_TEMPLATE }), "已保存");
      },
      onBackup() {
        const json = store.exportBackup();
        if (inApp) {
          // 微信/小红书内置浏览器下载不了文件：显示文本让老师复制保存
          openSheet({ title: "备份内容，长按复制保存", text: json, onCopy: copyText, label: "备份内容" });
          return;
        }
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `托管作业登记-备份-${todayKey()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000); // 慢的浏览器下载还没开始就撤销会失败
      },
      async onRestore(file) {
        if (!(await askConfirm("恢复会覆盖手机里现在的全部数据，继续？"))) return;
        let json;
        try {
          json = await readFileText(file);
        } catch {
          alert("恢复失败");
          return;
        }
        restoreFrom(json);
      },
      onPasteRestore() {
        openTextSheet({
          title: "粘贴备份内容",
          placeholder: "把之前复制保存的备份内容粘贴到这里",
          primaryLabel: "恢复",
          async onPrimary(text) {
            if (!(await askConfirm("恢复会覆盖手机里现在的全部数据，继续？"))) return false;
            return restoreFrom(text);
          },
        });
      },
    });
  }
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => { state.view = b.dataset.view; rerender(); });
}
rerender();
if (storageBlocked) showToast("浏览器禁用了存储，本次登记关掉页面就没了", 4000);

// 跨午夜：页面从后台回来时，如果停在「旧的今天」就跳到新的今天
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const now = todayKey();
  if (now === lastToday) return;
  const wasOnToday = state.dateKey === lastToday;
  lastToday = now;
  if (wasOnToday) {
    state.dateKey = now;
    rerender();
  }
});
