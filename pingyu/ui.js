// app/ui.js
// 只管 DOM：渲染页面、弹层、toast。不碰存储，所有写操作通过回调交给 main.js。
// 评语助手：el / showToast / fsExit / toggleBtn / mountSheet / openSheet / openTextSheet / askConfirm / askText 复制自课堂互动。
import { DIMS, DIM_TITLES, TAGS } from "./bank.js";
import { countChars } from "./state.js";

export function el(tag, attrs = {}, children = []) {
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


// 投屏时右上角的「退出」按钮
export function fsExit(p) {
  return el("button", { class: "fs-exit", text: "退出", onClick: p.onExitFullscreen });
}

// 开关按钮：aria-pressed 表示开/关，右侧一个小圆点开关
export function toggleBtn(label, on, onClick, disabled = false) {
  return el("button", { class: "toggle", "aria-pressed": on ? "true" : "false", disabled: disabled ? "" : null, onClick }, [
    el("span", { class: "toggle-label", text: label }),
    el("span", { class: "knob", "aria-hidden": "true" }),
  ]);
}

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
export function openSheet({ title, text, onCopy, label = "文案", emptyText = "没有内容", top = null }) {
  const ta = el("textarea", { "aria-label": label });
  const copyBtn = el("button", { class: "btn primary", text: "复制" });
  const closeBtn = el("button", { class: "btn", text: "关闭" });
  let autoCloseTimer = null;

  const body = [el("h2", { text: title })];
  if (top) body.push(top); // 标题下的额外控件
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

// 页内输入框：替代 prompt()。确定返回输入的原文，取消/Esc/点遮罩返回 null。
// opts.placeholder / opts.inputmode 可选（倒计时自定义要用）
export function askText(message, defaultValue = "", maxLength = null, opts = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = el("input", {
      "aria-label": message,
      maxlength: maxLength != null ? String(maxLength) : null,
      placeholder: opts.placeholder || null,
      inputmode: opts.inputmode || null,
    });
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

// ---------- 评语助手：三个页面 ----------

// 五个维度各一种柔色（标签底色与标题小圆点同色），选中态统一玫红
const DIM_CLASS = { 课堂: "d-class", 作业: "d-work", 品行: "d-moral", 交往: "d-social", 建议: "d-advice" };

function charHint(text, manual) {
  if (!text) return "";
  const n = `${countChars(text)} 字`;
  return manual ? `已手改 · ${n}` : n;
}

// 评语页：顶栏（名字大字 + 上一个/下一个 + 进度），五行标签，信纸 textarea，换一换/加一句/复制
// onTextChange(text) 每次输入即保存，返回是否算手改；只就地更新字数提示，不整页重画（重画会吞掉紧接着的那次点击）
export function renderWrite(root, p) {
  root.replaceChildren();
  if (!p.student) {
    root.append(el("div", { class: "empty" }, [
      el("p", { text: p.hasAnyStudents ? "名单是空的" : "先去设置页粘名单，再回来点标签。" }),
      el("button", { class: "btn primary", text: "去设置", onClick: p.onGoSettings }),
    ]));
    return;
  }
  root.append(el("div", { class: "topbar" }, [
    el("button", { class: "iconbtn", text: "‹ 上一个", "aria-label": "上一个", onClick: p.onPrev, disabled: p.index === 0 ? "" : null }),
    // 名字超过 6 字换小字号、最多两行（见 .date.long）
    el("div", { class: Array.from(p.student.name).length > 6 ? "date long" : "date", title: p.student.name }, [el("span", { class: "nm", text: p.student.name }), el("small", { text: `${p.index + 1} / ${p.total}` })]),
    el("button", { class: "iconbtn", text: "下一个 ›", "aria-label": "下一个", onClick: p.onNext, disabled: p.index >= p.total - 1 ? "" : null }),
  ]));
  root.append(el("section", { class: "section tagcard" }, DIMS.map((d) =>
    el("div", { class: `dim ${DIM_CLASS[d]}` }, [
      el("h2", { class: "dimtitle" }, [el("span", { class: "dot", "aria-hidden": "true" }), document.createTextNode(DIM_TITLES[d])]),
      el("div", { class: "chips" }, TAGS[d].map((t) => el("button", { class: "chip" + (p.tags[d] === t ? " on" : ""), text: t, "aria-pressed": p.tags[d] === t ? "true" : "false", onClick: () => p.onTag(d, t) }))),
    ]))));
  const hint = el("span", { class: "count", text: charHint(p.text, p.manual) });
  const ta = el("textarea", { class: "comment", "aria-label": "评语", placeholder: "点几个标签，评语就出来了", rows: "8" });
  ta.value = p.text;
  // 信纸跟着字数长高，整段一眼看全（上限交给 CSS max-height）
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 4}px`; };
  ta.addEventListener("input", () => { const manual = p.onTextChange(ta.value); hint.textContent = charHint(ta.value, manual); fit(); });
  root.append(el("section", { class: "section letter" }, [
    el("div", { class: "rowhead" }, [el("h2", { text: "评语" }), hint]),
    ta,
    el("div", { class: "actions" }, [
      el("button", { class: "btn", text: "换一换", onClick: p.onShuffle }),
      el("button", { class: "btn", text: "加一句", onClick: p.onExtra }),
      el("button", { class: "btn primary", text: "复制", onClick: p.onCopy }),
    ]),
  ]));
  requestAnimationFrame(fit);
}

const STATUS_CLASS = { 未点: "st-none", 已生成: "st-gen", 已手改: "st-manual" };

// 全班页：大字进度 + 细进度条，复制全班/导出，卡片列表（名字左、状态药丸右）
export function renderAll(root, p) {
  root.replaceChildren();
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  root.append(el("div", { class: "topbar" }, [
    el("div", { class: "left bigstat" }, [
      el("span", { class: "lbl", text: "已完成" }),
      el("b", { class: "num", text: String(p.done) }),
      el("span", { class: "of", text: ` / ${p.total}` }),
    ]),
  ]));
  root.append(el("div", { class: "progress", role: "progressbar", "aria-label": "完成进度", "aria-valuemin": "0", "aria-valuemax": String(p.total), "aria-valuenow": String(p.done) }, [
    el("i", { style: `width:${pct}%` }),
  ]));
  root.append(el("div", { class: "actions" }, [
    el("button", { class: "btn primary", text: "复制全班", onClick: p.onCopyAll }),
    el("button", { class: "btn", text: "导出 txt", onClick: p.onExport }),
  ]));
  if (p.total === 0) { root.append(el("p", { class: "hint", text: "先去设置页粘名单。" })); return; }
  root.append(el("div", { class: "rows" }, p.rows.map((r, i) =>
    el("button", { class: "row", onClick: () => p.onOpen(i) }, [
      el("span", { class: "no", text: String(i + 1) }),
      el("span", { class: "nm", text: r.name }),
      el("span", { class: "st " + STATUS_CLASS[r.status], text: r.status === "未点" ? "未点" : `${r.status} · ${r.chars} 字` }),
    ]))));
}

export function renderSettings(root, p) {
  root.replaceChildren();
  root.append(el("div", { class: "topbar" }, [el("div", { class: "left", text: "设置" })]));
  const ta = el("textarea", { class: "field roster", "aria-label": "名单", placeholder: "一行一个名字", rows: "6" }); ta.value = p.namesText;
  root.append(el("section", { class: "section" }, [
    el("h2", { text: "名单" }), ta,
    el("div", { class: "row" }, [
      el("button", { class: "btn primary", text: "保存名单", onClick: () => p.onSaveNames(ta.value) }),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn", text: "一键带入班级积分", onClick: p.onImportPoints }),
      el("button", { class: "btn", text: "粘贴积分备份", onClick: p.onPastePoints }),
    ]),
    el("p", { class: "hint", text: "和班级积分在同一台手机上用，点一下就能带入名单和积分记录；不在同一台就粘备份。" }),
  ]));
  root.append(el("section", { class: "section" }, [
    el("h2", { text: "句库" }),
    el("div", { class: "row" }, [
      el("button", { class: "btn", text: "改句库", onClick: p.onEditBank }),
      el("button", { class: "btn", text: "恢复默认", onClick: p.onResetBank }),
    ]),
  ]));
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: "" });
  file.addEventListener("change", () => { if (file.files[0]) p.onRestore(file.files[0]); file.value = ""; });
  root.append(el("section", { class: "section" }, [
    el("h2", { text: "备份与恢复" }),
    el("div", { class: "row" }, [
      el("button", { class: "btn", text: "备份", onClick: p.onBackup }),
      el("button", { class: "btn", text: "恢复", onClick: () => file.click() }),
      el("button", { class: "btn", text: "粘贴恢复", onClick: p.onPasteRestore }),
    ]),
    p.inApp ? el("p", { class: "hint", text: "小红书等 App 内打开不能存文件：点「备份」会显示一段文字，长按复制保存；恢复时用「粘贴恢复」。" }) : null,
    file,
  ]));
  root.append(el("p", { class: "foot" }, [document.createTextNode("名单和评语只在你的手机里，我们看不到。"), el("br"), document.createTextNode("建议写完一次备份一次。")]));
}

// 句库编辑弹层：每个维度/标签一组，每句一个文本框；空的删掉；每标签至少留 1 句
export function openBankEditor({ bank, onSave }) {
  const draft = JSON.parse(JSON.stringify(bank));
  const body = [el("h2", { text: "改句库" }), el("p", { class: "hint", text: "{名} 会换成孩子的名。留空的句子会被删掉，每个标签至少留一句。" })];
  const groups = [["称呼", draft.称呼], ["结尾", draft.结尾]];
  for (const d of DIMS) for (const t of TAGS[d]) groups.push([`${DIM_TITLES[d]} · ${t}`, draft.维度[d][t]]);
  const inputs = [];
  for (const [title, arr] of groups) {
    const box = el("div", { class: "bankgroup" }, [el("h3", { text: title })]);
    const addBtn = el("button", { class: "btn small", text: "加一句" });
    const addRow = (v) => { const i = el("textarea", { rows: "2", "aria-label": title, maxlength: "60" }); i.value = v; inputs.push([arr, i]); addBtn.before(i); return i; };
    box.append(addBtn);
    arr.forEach(addRow);
    addBtn.addEventListener("click", () => addRow("").focus());
    body.push(box);
  }
  const saveBtn = el("button", { class: "btn primary", text: "保存" }), closeBtn = el("button", { class: "btn", text: "关闭" });
  body.push(el("div", { class: "row sticky" }, [closeBtn, saveBtn]));
  const sheet = mountSheet({ label: "改句库", body, focus: saveBtn });
  closeBtn.addEventListener("click", sheet.close);
  saveBtn.addEventListener("click", () => {
    const byArr = new Map();
    for (const [arr, i] of inputs) { if (!byArr.has(arr)) byArr.set(arr, []); const v = i.value.trim(); if (v) byArr.get(arr).push(v); }
    for (const [, vals] of byArr) if (vals.length === 0) { showToast("每个标签至少留一句"); return; }
    for (const [arr, vals] of byArr) { arr.length = 0; arr.push(...vals); }
    onSave(draft); sheet.close();
  });
  return sheet.close;
}
