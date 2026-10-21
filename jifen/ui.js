// app/ui.js
// 只管 DOM：渲染页面、弹层、toast。不碰存储，所有写操作通过回调交给 main.js。
import { fmtDelta, fmtScore, MINUS } from "./copy.js";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

// 正绿负红，0 不加颜色
function signClass(n) {
  return n > 0 ? "plus" : n < 0 ? "minus" : "";
}

// 提示条。带 action 时默认停留 3 秒并显示一个按钮（如「撤销」），点了执行 onAction 并收起。
// 新提示会替换旧提示并清掉旧定时器，旧按钮随之失效。
export function showToast(msg, ms, action) {
  const t = document.getElementById("toast");
  const dur = ms ?? (action ? 3000 : 1500);
  clearTimeout(showToast._timer);
  const hide = () => {
    clearTimeout(showToast._timer);
    t.hidden = true;
    t.replaceChildren();
  };
  t.replaceChildren(document.createTextNode(msg));
  if (action) {
    let used = false;
    t.append(
      el("button", {
        text: action.label,
        onClick: () => {
          if (used) return; // 防连点
          used = true;
          hide();
          action.onAction();
        },
      })
    );
  }
  t.hidden = false;
  showToast._timer = setTimeout(hide, dur);
}

// 加分页：顶栏（班级名、全班、播报）、排序开关、学生卡片网格；名单为空时显示空状态
export function renderPoints(root, p) {
  root.replaceChildren();
  root.append(
    el("div", { class: "topbar" }, [
      el("button", { class: "classname", "aria-label": `班级名：${p.className}，点按修改`, text: p.className, onClick: p.onRenameClass }),
      el("button", { class: "iconbtn", text: "全班", onClick: p.onAll }),
      el("button", { class: "iconbtn", text: "播报", onClick: p.onBroadcast }),
    ])
  );

  if (p.students.length === 0) {
    root.append(
      el("div", { class: "empty" }, [
        el("img", { src: "assets/empty.png", alt: "" }),
        el("p", { text: "先去名单页加几个孩子" }),
        el("button", { class: "btn primary", text: "去名单", onClick: p.onGoList }),
      ])
    );
    return;
  }

  const segBtn = (mode, text) =>
    el("button", { "aria-pressed": String(p.sortMode === mode), text, onClick: () => p.onSort(mode) });
  root.append(el("div", { class: "seg", role: "group", "aria-label": "排序" }, [segBtn("list", "名单顺序"), segBtn("score", "按总分")]));

  const cards = p.students.map((s) => {
    const total = p.totals.get(s.id) ?? 0;
    const today = p.todaySums.get(s.id) ?? 0;
    const label = `${s.name}，总分 ${fmtScore(total)}` + (today !== 0 ? `，今日 ${fmtDelta(today)}` : "");
    return el("button", { class: "card", "aria-label": label, onClick: () => p.onStudent(s) }, [
      el("span", { class: "nm", text: s.name }),
      el("span", { class: `total ${total < 0 ? "minus" : ""}`.trim(), text: fmtScore(total) }),
      today !== 0 ? el("span", { class: `today ${signClass(today)}`, text: `今日 ${fmtDelta(today)}` }) : null,
    ]);
  });
  root.append(el("div", { class: "cards" }, cards));
}

// 加分弹层：标题（名字/全班 + 总分）、理由网格、「自定义…」、可选「复制 TA 的明细」。
// 点任何一个按钮都先关弹层再回调。
export function openReasonSheet({ title, total, reasons, showDetail, onPick, onCustom, onDetail }) {
  const head = el("h2", {}, [document.createTextNode(title), total != null ? el("small", { text: `总分 ${fmtScore(total)}` }) : null]);
  let sheet;
  const then = (fn) => () => {
    sheet.close();
    fn();
  };
  const grid = el("div", { class: "reasons" }, [
    ...reasons.map((r) =>
      el("button", { class: `reason ${r.delta > 0 ? "plus" : "minus"}`, text: `${r.label} ${fmtDelta(r.delta)}`, onClick: then(() => onPick(r)) })
    ),
    el("button", { class: "reason custom", text: "自定义…", onClick: then(onCustom) }),
  ]);
  const closeBtn = el("button", { class: "btn", text: "关闭" });
  const row = el("div", { class: "row" }, [
    closeBtn,
    showDetail ? el("button", { class: "btn", text: "复制 TA 的明细", onClick: then(onDetail) }) : null,
  ]);
  sheet = mountSheet({ label: title, body: [head, grid, row], focus: grid.firstElementChild });
  closeBtn.addEventListener("click", sheet.close);
  return sheet.close;
}

// 自定义加减分：分值（非 0 整数，可负，绝对值 ≤ 999）+ 理由（可空，空由存储层记「其他」）。
// 确定返回 { delta, label }；取消/Esc/点遮罩返回 null；非法时提示且不关闭。
export function askCustomDelta() {
  return new Promise((resolve) => {
    let result = null;
    const deltaInput = el("input", { id: "custom-delta", type: "number", step: "1", placeholder: "比如 3 或 -2", enterkeyhint: "next" });
    const labelInput = el("input", { id: "custom-label", maxlength: "20", placeholder: "可不填，记为「其他」", enterkeyhint: "done" });
    const err = el("p", { class: "err", role: "alert" });
    const okBtn = el("button", { class: "btn primary", text: "记上" });
    const cancelBtn = el("button", { class: "btn", text: "取消" });
    const sheet = mountSheet({
      label: "自定义加减分",
      body: [
        el("h2", { text: "自定义加减分" }),
        el("label", { for: "custom-delta", text: "分值（扣分写负数）" }),
        deltaInput,
        el("label", { for: "custom-label", text: "理由" }),
        labelInput,
        err,
        el("div", { class: "row" }, [cancelBtn, okBtn]),
      ],
      focus: deltaInput,
      onClose: () => resolve(result),
    });
    const ok = () => {
      // 有的输入法会打出全角减号，统一换成半角再解析
      const raw = deltaInput.value.trim().replace(/[−－]/g, "-");
      const delta = raw === "" ? NaN : Number(raw);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 999) {
        err.textContent = Number.isInteger(delta) && delta !== 0
          ? `分值要是 ${MINUS}999 到 999 之间的非 0 整数`
          : "分值要是非 0 整数，比如 3 或 -2";
        deltaInput.focus();
        return;
      }
      result = { delta, label: labelInput.value.trim() };
      sheet.close();
    };
    const onEnter = (next) => (e) => { if (e.key === "Enter" && !e.isComposing) next(); };
    deltaInput.addEventListener("keydown", onEnter(() => labelInput.focus()));
    labelInput.addEventListener("keydown", onEnter(ok));
    deltaInput.addEventListener("input", () => { err.textContent = ""; });
    cancelBtn.addEventListener("click", sheet.close);
    okBtn.addEventListener("click", ok);
  });
}

// 分段开关：options = [[value, 文字], ...]，当前值 aria-pressed=true
function seg(label, options, current, onPick) {
  return el(
    "div",
    { class: "seg", role: "group", "aria-label": label },
    options.map(([v, text]) => el("button", { "aria-pressed": String(current === v), "data-v": v, text, onClick: () => onPick(v) }))
  );
}

// 记录页：顶部「今天 / 本周 / 全部」，下面按时间倒序一行一条，行尾「撤销」
export function renderLog(root, p) {
  root.replaceChildren();
  root.append(seg("筛选", [["today", "今天"], ["week", "本周"], ["all", "全部"]], p.filter, p.onFilter));
  if (p.rows.length === 0) {
    root.append(el("div", { class: "empty" }, el("p", { text: "还没有记录" })));
    return;
  }
  const rows = p.rows.map((r) =>
    el("div", { class: "row" }, [
      el("span", { class: "when", text: r.when }),
      el("span", { class: "who", text: r.who }),
      el("span", { class: "why", text: r.why }),
      el("span", { class: `delta ${signClass(r.delta)}`.trim(), text: fmtDelta(r.delta) }),
      el("button", { class: "undo", text: "撤销", "aria-label": `撤销 ${r.when} ${r.who} ${r.why} ${fmtDelta(r.delta)}`, onClick: () => p.onUndo(r.id) }),
    ])
  );
  root.append(el("div", { class: "log" }, rows));
}

// 播报弹层：顶部「今天 / 本周」切换，下面是可编辑的文案。
// 直接复用 openSheet（textFor 返回 null 时它显示「这段时间还没有记录」并禁用复制）；
// 切换时关掉旧弹层、按新模式重开一个，焦点放回刚点的那个切换按钮。
export function openBroadcastSheet({ mode = "today", textFor, onCopy }) {
  let close = null;
  const open = (m, refocus) => {
    if (close) close();
    const top = seg("播报范围", [["today", "今天"], ["week", "本周"]], m, (v) => { if (v !== m) open(v, true); });
    close = openSheet({ title: "播报", text: textFor(m), onCopy, label: m === "today" ? "今日播报" : "本周播报", top });
    if (refocus) top.querySelector(`[data-v="${m}"]`)?.focus();
  };
  open(mode, false);
  return () => close();
}

// 名单页：班级名、孩子、理由、积分清零、备份与恢复、页脚。所有确认/输入都由 main 的回调去弹
export function renderList(root, p) {
  root.replaceChildren();

  // 班级名：失焦保存；把存储层规整后的值（去空格、截断、空则默认）写回输入框
  let curName = p.className;
  const nameInput = el("input", { class: "field", maxlength: "20", "aria-label": "班级名", enterkeyhint: "done" });
  nameInput.value = curName;
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) nameInput.blur(); });
  nameInput.addEventListener("blur", () => {
    if (nameInput.value === curName) return; // 没改不提示
    const saved = p.onClassName(nameInput.value);
    if (typeof saved === "string") curName = saved;
    nameInput.value = curName;
  });
  root.append(el("section", { class: "section" }, [el("h2", { text: "班级名" }), nameInput]));

  // 孩子
  const stuRows = p.students.map((s, i) =>
    el("div", { class: "item" }, [
      el("span", { class: "label", text: s.name }),
      el("button", { class: "small", text: "上移", "aria-label": `上移 ${s.name}`, disabled: i === 0 ? "" : null, onClick: () => p.onMove(s.id, -1) }),
      el("button", { class: "small", text: "下移", "aria-label": `下移 ${s.name}`, disabled: i === p.students.length - 1 ? "" : null, onClick: () => p.onMove(s.id, 1) }),
      el("button", { class: "small", text: "改名", "aria-label": `改名 ${s.name}`, onClick: () => p.onRename(s.id) }),
      el("button", { class: "small", text: "删除", "aria-label": `删除 ${s.name}`, onClick: () => p.onRemove(s.id) }),
    ])
  );
  // 多行文本框：单行 input 粘贴时会吞掉换行，名单从别处整列粘过来要用 textarea
  const addBox = el("textarea", { rows: "1", placeholder: "孩子名字，可一次粘贴多行", "aria-label": "添加孩子" });
  const add = () => {
    if (!addBox.value.trim()) return;
    // 保存失败（返回 false）时保留输入，方便老师重试
    if (p.onAdd(addBox.value) !== false) addBox.value = "";
  };
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: `孩子（${p.students.length}）` }),
      p.students.length === 0 ? el("p", { class: "hint", text: "还没有孩子。可以从表格里整列复制名字粘贴进来，按换行、逗号、顿号、空格自动拆开。" }) : null,
      ...stuRows,
      el("div", { class: "addrow" }, [addBox, el("button", { class: "btn primary", text: "添加", onClick: add })]),
    ])
  );

  // 理由
  const reasonRows = p.reasons.map((r, i) =>
    el("div", { class: "item" }, [
      el("span", { class: "label" }, [document.createTextNode(`${r.label} `), el("b", { class: signClass(r.delta), text: fmtDelta(r.delta) })]),
      el("button", { class: "small", text: "上移", "aria-label": `上移 ${r.label}`, disabled: i === 0 ? "" : null, onClick: () => p.onMoveReason(r.id, -1) }),
      el("button", { class: "small", text: "下移", "aria-label": `下移 ${r.label}`, disabled: i === p.reasons.length - 1 ? "" : null, onClick: () => p.onMoveReason(r.id, 1) }),
      el("button", { class: "small", text: "改", "aria-label": `修改 ${r.label}`, onClick: () => p.onEditReason(r.id) }),
      el("button", { class: "small", text: "删", "aria-label": `删除 ${r.label}`, onClick: () => p.onRemoveReason(r.id) }),
    ])
  );
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: "理由" }),
      p.reasons.length === 0 ? el("p", { class: "hint", text: "理由为空，点「恢复默认」或「添加理由」。" }) : null,
      ...reasonRows,
      el("div", { class: "addrow" }, [
        el("button", { class: "btn primary", text: "添加理由", onClick: p.onAddReason }),
        el("button", { class: "btn", text: "恢复默认", onClick: p.onResetReasons }),
      ]),
    ])
  );

  // 积分清零
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: "积分清零" }),
      el("p", { class: "hint", text: "删除全部记录，名单和理由保留。" }),
      el("div", { class: "addrow" }, el("button", { class: "btn danger", text: "积分清零", onClick: p.onClear })),
    ])
  );

  // 备份与恢复（照搬托管作业登记）
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: "" });
  file.addEventListener("change", () => { if (file.files[0]) p.onRestore(file.files[0]); file.value = ""; });
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: "备份与恢复" }),
      el("div", { class: "addrow" }, [
        el("button", { class: "btn", text: "备份", onClick: p.onBackup }),
        el("button", { class: "btn", text: "恢复", onClick: () => file.click() }),
        el("button", { class: "btn", text: "粘贴恢复", onClick: p.onPasteRestore }),
      ]),
      p.inApp ? el("p", { class: "hint", text: "微信/小红书里打开不能存文件：点「备份」会显示一段文字，长按复制保存；恢复时用「粘贴恢复」。" }) : null,
      file,
    ])
  );
  root.append(
    el("p", { class: "foot" }, [
      document.createTextNode("数据只在你的手机里，我们看不到。"),
      el("br"),
      document.createTextNode("建议每周备份一次。"),
    ])
  );
}

// ---------- 以下从托管作业登记 ui.js 照抄（openSheet 增加 emptyText、top 参数） ----------

// 弹层骨架：遮罩、Esc（只关最上面一层）、点遮罩关闭、打开时聚焦、关闭后把焦点还回去
let openSheets = 0; // 打开中的弹层数；>0 时 body 带 has-sheet，toast 挪到顶部避免盖住弹层按钮
export function mountSheet({ label, body, focus, onClose, role = "dialog" }) {
  const prevFocus = document.activeElement;
  const mask = el("div", { class: "sheet-mask" });
  let closed = false;
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    const masks = document.querySelectorAll(".sheet-mask");
    if (masks[masks.length - 1] !== mask) return;
    close();
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    mask.remove();
    openSheets -= 1;
    if (openSheets <= 0) { openSheets = 0; document.body.classList.remove("has-sheet"); }
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") prevFocus.focus();
    if (onClose) onClose();
  }
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  mask.append(el("div", { class: "sheet", role, "aria-modal": "true", "aria-label": label }, body));
  document.body.append(mask);
  openSheets += 1;
  document.body.classList.add("has-sheet");
  const target = [].concat(focus).find((x) => x && !x.disabled);
  if (target) target.focus();
  return { close, isClosed: () => closed };
}

// 文本弹层：可编辑后复制。onCopy(text) 返回是否复制成功；失败时选中全文提示长按复制
export function openSheet({ title, text, onCopy, label = "文案", emptyText = "这段时间还没有记录", top = null }) {
  const ta = el("textarea", { "aria-label": label });
  const copyBtn = el("button", { class: "btn primary", text: "复制" });
  const closeBtn = el("button", { class: "btn", text: "关闭" });
  let autoCloseTimer = null;

  const body = [el("h2", { text: title })];
  if (top) body.push(top); // 标题下的额外控件（播报弹层的「今天 / 本周」）
  if (text == null) {
    body.push(el("p", { class: "empty", text: emptyText }));
    copyBtn.disabled = true;
  } else {
    ta.value = text;
    copyBtn.disabled = !ta.value.trim();
    ta.addEventListener("input", () => { copyBtn.disabled = !ta.value.trim(); });
    body.push(ta);
  }
  body.push(el("div", { class: "row" }, [closeBtn, copyBtn]));
  const sheet = mountSheet({
    label: title,
    body,
    focus: [copyBtn, closeBtn],
    onClose: () => { clearTimeout(autoCloseTimer); autoCloseTimer = null; },
  });
  closeBtn.addEventListener("click", sheet.close);
  copyBtn.addEventListener("click", async () => {
    const ok = await onCopy(ta.value);
    if (sheet.isClosed()) return; // 复制期间弹层已被关掉，不再挂定时器
    if (ok) {
      showToast("已复制");
      clearTimeout(autoCloseTimer);
      autoCloseTimer = setTimeout(sheet.close, 1500);
    } else {
      ta.focus();
      ta.setSelectionRange(0, ta.value.length); // iOS 上 select() 无效
      showToast("请长按复制");
    }
  });
  return sheet.close;
}

// 空文本框弹层：粘贴内容后点主按钮。onPrimary 返回 false 时保持打开
export function openTextSheet({ title, placeholder = "", primaryLabel = "确定", onPrimary }) {
  const ta = el("textarea", { "aria-label": title, placeholder });
  const okBtn = el("button", { class: "btn primary", text: primaryLabel, disabled: "" });
  const closeBtn = el("button", { class: "btn", text: "关闭" });
  ta.addEventListener("input", () => { okBtn.disabled = !ta.value.trim(); });
  const sheet = mountSheet({
    label: title,
    body: [el("h2", { text: title }), ta, el("div", { class: "row" }, [closeBtn, okBtn])],
    focus: [okBtn, ta],
  });
  closeBtn.addEventListener("click", sheet.close);
  let busy = false;
  okBtn.addEventListener("click", async () => {
    if (busy || !ta.value.trim()) return;
    busy = true;
    try {
      const r = await onPrimary(ta.value);
      if (r !== false) sheet.close();
    } finally {
      busy = false;
    }
  });
  return sheet.close;
}

// 页内确认框：替代 confirm()，小红书等 WebView 可能吞掉原生对话框。Esc/点遮罩/取消 = false
export function askConfirm(message, { okLabel = "确定", cancelLabel = "取消" } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const okBtn = el("button", { class: "btn primary", text: okLabel });
    const cancelBtn = el("button", { class: "btn", text: cancelLabel });
    const sheet = mountSheet({
      label: message,
      role: "alertdialog",
      body: [el("p", { class: "msg", text: message }), el("div", { class: "row" }, [cancelBtn, okBtn])],
      focus: okBtn,
      onClose: () => resolve(result),
    });
    cancelBtn.addEventListener("click", sheet.close);
    okBtn.addEventListener("click", () => { result = true; sheet.close(); });
  });
}

// 页内输入框：替代 prompt()。确定返回输入的原文，取消/Esc/点遮罩返回 null
export function askText(message, defaultValue = "", maxLength = null) {
  return new Promise((resolve) => {
    let result = null;
    const input = el("input", { "aria-label": message, maxlength: maxLength != null ? String(maxLength) : null });
    input.value = defaultValue ?? "";
    const okBtn = el("button", { class: "btn primary", text: "确定" });
    const cancelBtn = el("button", { class: "btn", text: "取消" });
    const sheet = mountSheet({
      label: message,
      body: [el("h2", { text: message }), input, el("div", { class: "row" }, [cancelBtn, okBtn])],
      focus: input, // 文字输入框：直接聚焦输入框，老师能马上改
      onClose: () => resolve(result),
    });
    const ok = () => { result = input.value; sheet.close(); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) ok(); });
    cancelBtn.addEventListener("click", sheet.close);
    okBtn.addEventListener("click", ok);
  });
}
