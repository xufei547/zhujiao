// app/main.js
// 接线：状态、页面切换、加分/撤销、记录、播报、名单、备份恢复、复制。数据每次都从 store 现读，不在内存里缓存记录。
import { createStore, openStorage, newId } from "./store.js";
import { dateKey, totals, sumInRange, sortStudents, eventsInRange, weekStartKey, formatDate, pad2 } from "./state.js";
import { composeToday, composeWeek, composeStudent, fmtDelta } from "./copy.js";
import { isInAppBrowser } from "./env.js";
import {
  renderPoints, renderLog, renderList, showToast, openSheet, openTextSheet, openReasonSheet, openBroadcastSheet,
  askCustomDelta, askText, askConfirm,
} from "./ui.js";

// 禁用 Cookie/存储、隐私模式下 localStorage 可能访问就抛、或者写不进去：试写一次，失败就用内存存储
const { storage, blocked: storageBlocked } = openStorage(() => window.localStorage);
const store = createStore(storage);
const root = document.getElementById("view");
const state = { view: "points", sortMode: "list", logFilter: "today", today: dateKey() };
// 微信/小红书内置浏览器下载不了文件，备份要改走复制
const inApp = isInAppBrowser(navigator.userAgent);
const RESTORE_CONFIRM = "恢复会覆盖手机里现在的全部数据，继续？";

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

// 撤销：删掉刚记的一条或一批，重渲染后提示
function undo(fn) {
  if (!save(fn)) return;
  rerender();
  showToast("已撤销");
}

// 给一个孩子记一条
function addOne(student, { label, delta }) {
  let ev;
  if (!save(() => { ev = store.addEvent({ studentId: student.id, label, delta }); })) return;
  rerender();
  showToast(`${student.name} ${fmtDelta(ev.delta)} ${ev.label}`, 3000, {
    label: "撤销",
    onAction: () => undo(() => store.removeEvent(ev.id)),
  });
}

// 全班：名单里每个孩子各记一条，同一个 batchId，撤销时整批删
function addAll({ label, delta }) {
  const students = store.getStudents();
  if (students.length === 0) {
    showToast("先去名单页加几个孩子");
    return;
  }
  const batchId = newId();
  let made;
  if (!save(() => { made = store.addEvents(students.map((s) => ({ studentId: s.id, label, delta, batchId }))); })) return;
  rerender();
  showToast(`全班 ${fmtDelta(delta)} ${made[0].label}`, 3000, {
    label: "撤销",
    onAction: () => undo(() => store.removeBatch(batchId)),
  });
}

// 「自定义…」：输入分值与理由后照常记
async function custom(record) {
  const r = await askCustomDelta();
  if (r) record(r);
}

function openStudent(student) {
  const events = store.getEvents();
  const total = totals(events, [student]).get(student.id);
  openReasonSheet({
    title: student.name,
    total,
    reasons: store.getReasons(),
    showDetail: true,
    onPick: (r) => addOne(student, r),
    onCustom: () => custom((r) => addOne(student, r)),
    onDetail() {
      const text = composeStudent({ todayKey: dateKey(), student, events: store.getEvents() });
      openSheet({ title: `${student.name} · 本周明细`, text, onCopy: copyText, label: "明细文案" });
    },
  });
}

function openAll() {
  if (store.getStudents().length === 0) {
    showToast("先去名单页加几个孩子");
    return;
  }
  openReasonSheet({
    title: "全班",
    reasons: store.getReasons(),
    showDetail: false,
    onPick: (r) => addAll(r),
    onCustom: () => custom((r) => addAll(r)),
  });
}

async function renameClass() {
  const name = await askText("班级名", store.getClassName());
  if (name == null) return;
  // 留空由存储层恢复成「我的班」，超长截到 20 字
  if (save(() => store.setClassName(name))) rerender();
}

// 播报：今天 / 本周，每次切换都现算文案；当期没记录时 compose 返回 null
function onBroadcast() {
  openBroadcastSheet({
    mode: "today",
    textFor(mode) {
      const today = dateKey();
      const args = { className: store.getClassName(), students: store.getStudents(), events: store.getEvents() };
      return mode === "week" ? composeWeek({ ...args, todayKey: today }) : composeToday({ ...args, dateKey: today });
    },
    onCopy: copyText,
  });
}

// ---------- 记录页 ----------

// 记录时间：今天只写 HH:mm，其他天写 M月D日 HH:mm（日期用记录时存下的 date）
function fmtWhen(e, todayKey) {
  const d = new Date(e.ts);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return e.date === todayKey ? hm : `${formatDate(e.date)} ${hm}`;
}

function renderLogView() {
  const today = state.today;
  const names = new Map(store.getStudents().map((s) => [s.id, s.name]));
  const events = store.getEvents();
  let list;
  if (state.logFilter === "today") list = eventsInRange(events, today, today);
  else if (state.logFilter === "week") list = eventsInRange(events, weekStartKey(today), today);
  else list = events.slice().sort((a, b) => b.ts - a.ts); // 全部：不按日期过滤
  // 已删除的孩子：记录保留但不显示；名字取名单里现在的名字
  const rows = list
    .filter((e) => names.has(e.studentId))
    .map((e) => ({ id: e.id, when: fmtWhen(e, today), who: names.get(e.studentId), why: e.label, delta: e.delta }));
  renderLog(root, {
    filter: state.logFilter,
    rows,
    onFilter(f) { state.logFilter = f; rerender(); },
    async onUndo(id) {
      if (!(await askConfirm("撤销这条记录？"))) return;
      undo(() => store.removeEvent(id));
    },
  });
}

// ---------- 名单页 ----------

// 分值输入：允许全角减号，必须是非 0 整数且绝对值 ≤ 999（与自定义加减分一致）；不合法返回 null
function parseDelta(raw) {
  const t = String(raw ?? "").trim().replace(/[−－]/g, "-");
  const n = t === "" ? NaN : Number(t);
  return Number.isInteger(n) && n !== 0 && Math.abs(n) <= 999 ? n : null;
}

// 理由编辑：先问理由文字，再问分值。任何一步取消都不改动；返回 { label, delta } 或 null
async function askReason(title, current) {
  const label = await askText(`${title}：理由`, current?.label ?? "", 20);
  if (label == null) return null;
  if (!label.trim()) {
    showToast("理由不能为空");
    return null;
  }
  const raw = await askText(`${title}：分值（扣分写负数）`, current ? String(current.delta) : "");
  if (raw == null) return null;
  const delta = parseDelta(raw);
  if (delta == null) {
    const n = Number(String(raw).trim().replace(/[−－]/g, "-"));
    showToast(Number.isInteger(n) && n !== 0 ? "分值要是 −999 到 999 之间的非 0 整数" : "分值要是非 0 整数");
    return null;
  }
  return { label: Array.from(label.trim()).slice(0, 20).join(""), delta };
}

// 写操作 + 重渲染 + 可选提示；失败已在 save 里 toast
function act(fn, msg) {
  if (!save(fn)) return false;
  rerender();
  if (msg) showToast(msg);
  return true;
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
    showToast("不是班级积分的备份");
    return false;
  }
  const res = store.importBackup(obj);
  if (!res.ok) {
    showToast(res.error || "恢复失败");
    return false;
  }
  rerender();
  const msg = `已恢复：${res.counts.students} 人，${res.counts.events} 条记录`;
  // 备份里理由为空时加分弹层只剩「自定义…」，提醒去恢复默认（两句合成一条，免得后一条把前一条顶掉）
  if (res.counts.reasons === 0) showToast(`${msg}。理由为空，可在名单页恢复默认`, 4000);
  else showToast(msg);
  return true;
}

function renderListView() {
  const students = store.getStudents();
  const reasons = store.getReasons();
  const findStudent = (id) => store.getStudents().find((s) => s.id === id);
  const findReason = (id) => store.getReasons().find((r) => r.id === id);
  renderList(root, {
    className: store.getClassName(),
    students,
    reasons,
    inApp,
    // 失焦保存，不重渲染（免得吃掉老师紧接着的点击）；返回存储层规整后的名字给输入框回显
    onClassName(name) {
      if (!save(() => store.setClassName(name))) return null;
      showToast("已保存");
      return store.getClassName();
    },
    onAdd(text) {
      const names = text.split(/[\n,，、\s]+/).filter(Boolean);
      if (names.length === 0) return true;
      let added;
      if (!save(() => { added = store.addStudents(names); })) return false;
      if (added.length === 0) {
        showToast("都已在名单里");
        return true;
      }
      rerender();
      showToast(`已添加 ${added.length} 人`);
      return true;
    },
    async onRename(id) {
      const s = findStudent(id);
      if (!s) return;
      const name = await askText("改成什么名字？", s.name);
      if (name == null || !name.trim() || name.trim() === s.name) return;
      act(() => store.renameStudent(id, name), "已改名");
    },
    async onRemove(id) {
      const s = findStudent(id);
      if (!s) return;
      if (!(await askConfirm(`删除「${s.name}」？TA 的记录会保留，但不再显示、不计入榜单和播报。`))) return;
      act(() => store.removeStudent(id), "已删除");
    },
    onMove(id, d) { act(() => store.moveStudent(id, d)); },
    async onAddReason() {
      const r = await askReason("添加理由");
      if (r) act(() => store.addReason(r.label, r.delta), "已添加");
    },
    async onEditReason(id) {
      const cur = findReason(id);
      if (!cur) return;
      const r = await askReason("修改理由", cur);
      if (r) act(() => store.updateReason(id, r), "已保存");
    },
    async onRemoveReason(id) {
      const r = findReason(id);
      if (!r) return;
      if (!(await askConfirm(`删除理由「${r.label}」？以前记过的不受影响。`))) return;
      act(() => store.removeReason(id), "已删除");
    },
    onMoveReason(id, d) { act(() => store.moveReason(id, d)); },
    async onResetReasons() {
      if (!(await askConfirm("把理由恢复成默认的 7 个？现在的理由会被替换，以前记过的不受影响。"))) return;
      act(() => store.resetReasons(), "已恢复默认");
    },
    async onClear() {
      const n = store.getEvents().length;
      if (n === 0) {
        showToast("还没有记录");
        return;
      }
      if (!(await askConfirm(`会删掉全部 ${n} 条记录，建议先备份`, { okLabel: "清零" }))) return;
      act(() => store.clearEvents(), "已清零");
    },
    onBackup() {
      const json = JSON.stringify(store.exportBackup());
      if (inApp) {
        // 微信/小红书内置浏览器下载不了文件：显示文本让老师复制保存
        openSheet({ title: "备份内容，长按复制保存", text: json, onCopy: copyText, label: "备份内容" });
        return;
      }
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `班级积分-备份-${dateKey()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000); // 慢的浏览器下载还没开始就撤销会失败
    },
    async onRestore(file) {
      if (!(await askConfirm(RESTORE_CONFIRM))) return;
      let text;
      try {
        text = await readFileText(file);
      } catch {
        showToast("读不出这个文件");
        return;
      }
      restoreFrom(text);
    },
    onPasteRestore() {
      openTextSheet({
        title: "粘贴备份内容",
        placeholder: "把之前复制保存的备份内容粘贴到这里",
        primaryLabel: "恢复",
        async onPrimary(text) {
          if (!(await askConfirm(RESTORE_CONFIRM))) return false;
          return restoreFrom(text);
        },
      });
    },
  });
}

function rerender() {
  state.today = dateKey(); // 跨午夜后任何一次重渲染都用新的今天
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (state.view === "log") {
    renderLogView();
    return;
  }
  if (state.view === "list") {
    renderListView();
    return;
  }
  const students = store.getStudents();
  const events = store.getEvents();
  const totalMap = totals(events, students);
  renderPoints(root, {
    className: store.getClassName(),
    students: sortStudents(students, totalMap, state.sortMode),
    totals: totalMap,
    todaySums: sumInRange(events, students, state.today, state.today),
    sortMode: state.sortMode,
    onRenameClass: renameClass,
    onSort(mode) { state.sortMode = mode; rerender(); },
    onAll: openAll,
    onBroadcast,
    onStudent: openStudent,
    onGoList() { state.view = "list"; rerender(); },
  });
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => { state.view = b.dataset.view; rerender(); });
}
rerender();
if (storageBlocked) showToast("浏览器禁用了存储，本次记录关掉页面就没了", 4000);

// 跨午夜：页面从后台回来时如果日期变了，重算「今日」变动
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (dateKey() === state.today) return;
  rerender();
});
