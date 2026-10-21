// app/ui.js
// 只管 DOM：渲染页面、弹层、toast。不碰存储，所有写操作通过回调交给 main.js。
import { remaining } from "./state.js";

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

// 名单/题库为空时的空状态：插画 + 一句话 + 去设置页的按钮
function emptyState(text, btnText, onClick) {
  return el("div", { class: "empty" }, [
    el("img", { src: "assets/empty.png", alt: "" }),
    el("p", { text }),
    el("button", { class: "btn primary", text: btnText, onClick }),
  ]);
}

// 「本轮已抽」折叠列表的展开状态，跨重渲染保留（每抽一次都会整页重渲染）
let drawnListOpen = false;

// 点名页。p = { students, round, current: {id,name}|null, rolling, rollName, landed, fullscreen,
//   onDraw, onAbsent, onReset, onFullscreen, onExitFullscreen, onGoSettings }
// rollName：滚动中当前显示的名字（滚动期间 main 直接改 .stage .name 的文字，不走这里）；
// landed：刚落定的这一次渲染，加 landed 类播放放大动画
export function renderDraw(root, p) {
  root.replaceChildren();
  if (p.students.length === 0) {
    root.append(emptyState("先去设置页粘名单", "去设置", p.onGoSettings));
    return;
  }

  const ids = p.students.map((s) => s.id);
  const names = new Map(p.students.map((s) => [s.id, s.name]));
  // 剩余按 id 求交集算，不信 drawn.length（名单改过后 drawn 里可能有失效 id）
  const left = remaining(ids, p.round.drawn, p.round.absent).length;

  root.append(
    el("div", { class: "topbar fs-hide" }, [
      el("span", { class: "left", text: `剩余 ${left} 人` }),
      el("button", { class: "iconbtn text", text: "重新开始", disabled: p.rolling ? "" : null, onClick: p.onReset }),
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );

  let main;
  if (p.rolling) main = el("div", { class: "name rolling", text: p.rollName || "" });
  else if (p.current) main = el("div", { class: p.landed ? "name landed" : "name", text: p.current.name });
  else main = el("div", { class: "hint", text: "点下面按钮" });
  root.append(el("div", { class: "stage" }, main));

  root.append(el("button", { class: "bigbtn", text: "抽一个", disabled: p.rolling ? "" : null, onClick: p.onDraw }));

  // 投屏时只留大字区和「抽一个」，这两个小按钮也藏起来
  if (p.current && !p.rolling) {
    root.append(
      el("div", { class: "small-row fs-hide" }, [
        el("button", { class: "btn", text: "不在，再抽", onClick: p.onAbsent }),
        el("button", { class: "btn", text: "再抽一个", onClick: p.onDraw }),
      ])
    );
  }

  // 本轮已抽：按抽中顺序；缺席的排在后面，灰字带「缺」。只列名单里还在的人
  const drawnIds = p.round.drawn.filter((id) => names.has(id));
  const absentIds = p.round.absent.filter((id) => names.has(id));
  const total = drawnIds.length + absentIds.length;
  if (total > 0) {
    const chips = [
      ...drawnIds.map((id) => el("span", { class: "chip", text: names.get(id) })),
      ...absentIds.map((id) => el("span", { class: "chip absent", text: `${names.get(id)} 缺` })),
    ];
    const details = el("details", { class: "drawn fs-hide" }, [
      el("summary", { text: `本轮已抽 ${drawnIds.length} 人` + (absentIds.length ? `，缺席 ${absentIds.length} 人` : "") }),
      el("div", { class: "chips" }, chips),
    ]);
    details.open = drawnListOpen;
    details.addEventListener("toggle", () => { drawnListOpen = details.open; });
    root.append(details);
  }

  if (p.fullscreen) root.append(el("button", { class: "fs-exit", text: "退出", onClick: p.onExitFullscreen }));
}

// 投屏时右上角的「退出」按钮
function fsExit(p) {
  return el("button", { class: "fs-exit", text: "退出", onClick: p.onExitFullscreen });
}

// 题库下拉
function bankSelect(p) {
  const sel = el("select", { class: "field", "aria-label": "选择题库", disabled: p.rolling ? "" : null });
  for (const b of p.banks) {
    const opt = el("option", { value: b.id, text: b.name });
    if (b.id === p.bankId) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener("change", () => p.onBank(sel.value));
  return sel;
}

// 开关按钮：aria-pressed 表示开/关，右侧一个小圆点开关
function toggleBtn(label, on, onClick, disabled = false) {
  return el("button", { class: "toggle", "aria-pressed": on ? "true" : "false", disabled: disabled ? "" : null, onClick }, [
    el("span", { class: "toggle-label", text: label }),
    el("span", { class: "knob", "aria-hidden": "true" }),
  ]);
}

// 抽题页。p = { banks, bankId, round, prefs, current: {id,q,a}|null, who: {id,name}|null, showAnswer, rolling, fullscreen, canSpeak,
//   rollQ, rollWho, landed, speaking,
//   onBank(id), onToggleWithName(v), onDraw(), onToggleAnswer(), onSpeak(), onReset(), onFullscreen(), onExitFullscreen(), onGoSettings() }
// rollQ：滚动中显示的「第 N 题」；rollWho：滚动中显示的名字（不同时点名时为 null，不渲染名字行）
// 滚动期间 main 直接改 .stage .q / .stage .who 的文字，不走这里
export function renderQuiz(root, p) {
  root.replaceChildren();
  const bank = p.banks.find((b) => b.id === p.bankId) || null;
  if (!bank || bank.items.length === 0) {
    // 有题库但选中的是空题库：留着下拉，能换到别的题库
    if (p.banks.length > 0) root.append(el("div", { class: "topbar quizbar fs-hide" }, bankSelect(p)));
    root.append(emptyState("先去设置页粘题目", "去设置", p.onGoSettings));
    if (p.fullscreen) root.append(fsExit(p));
    return;
  }

  // 剩余按 id 求交集算，不信 bankDrawn 的长度（换过题后可能有失效 id）
  const itemIds = bank.items.map((it) => it.id);
  const left = remaining(itemIds, p.round.bankDrawn[bank.id] || [], []).length;

  root.append(
    el("div", { class: "topbar quizbar fs-hide" }, [
      bankSelect(p),
      el("span", { class: "left", text: `剩余 ${left} 题` }),
      el("button", { class: "iconbtn text", text: "重新开始", disabled: p.rolling ? "" : null, onClick: p.onReset }),
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );
  root.append(
    el("div", { class: "switch-row fs-hide" }, toggleBtn("同时点名", p.prefs.withName, () => p.onToggleWithName(!p.prefs.withName), p.rolling))
  );

  const stage = [];
  if (p.rolling) {
    if (p.rollWho != null) stage.push(el("div", { class: "who rolling", text: p.rollWho }));
    stage.push(el("div", { class: "q rolling", text: p.rollQ || "" }));
  } else if (p.current) {
    if (p.who) stage.push(el("div", { class: p.landed ? "who landed" : "who", text: p.who.name }));
    stage.push(el("div", { class: p.landed ? "q landed" : "q", text: p.current.q }));
    if (p.current.a) {
      stage.push(
        el("button", {
          class: "btn ansbtn",
          text: p.showAnswer ? "收起答案" : "看答案",
          "aria-expanded": p.showAnswer ? "true" : "false",
          onClick: p.onToggleAnswer,
        })
      );
      if (p.showAnswer) stage.push(el("div", { class: "answer", text: p.current.a }));
    }
  } else {
    stage.push(el("div", { class: "hint", text: "点下面按钮" }));
  }
  root.append(el("div", { class: "stage" }, stage));

  root.append(el("button", { class: "bigbtn", text: "抽一题", disabled: p.rolling ? "" : null, onClick: p.onDraw }));

  // 朗读：浏览器不支持就不渲染；投屏时藏起来
  if (p.canSpeak && p.current && !p.rolling) {
    root.append(
      el("div", { class: "small-row fs-hide" }, [
        el("button", {
          class: "btn speak",
          text: p.speaking ? "停止" : "朗读",
          "aria-pressed": p.speaking ? "true" : "false",
          onClick: p.onSpeak,
        }),
      ])
    );
  }

  if (p.fullscreen) root.append(fsExit(p));
}

// 名单输入框里没保存的草稿，跨重渲染（切页、改题库等）保留；名单变了（保存或恢复）就作废
let rosterDraft = null; // { base: 渲染时的名单文本, text: 草稿 }

// 设置页：名单、题库、朗读、备份与恢复、页脚。所有确认/输入都由 main 的回调去弹
// p = { students, banks, prefs, inApp, canSpeak, onSaveNames(text), onAddBank(), onRenameBank(id), onReplaceBank(id), onRemoveBank(id),
//       onToggleAutoSpeak(v), onBackup(), onRestore(file), onPasteRestore() }
export function renderSettings(root, p) {
  root.replaceChildren();

  // 名单：一行一个预填；保存时整体覆盖
  const base = p.students.map((s) => s.name).join("\n");
  if (rosterDraft && rosterDraft.base !== base) rosterDraft = null;
  const roster = el("textarea", {
    class: "field roster",
    rows: "6",
    placeholder: "一行一个名字，也可以用逗号分开",
    "aria-label": "名单",
  });
  roster.value = rosterDraft ? rosterDraft.text : base;
  roster.addEventListener("input", () => { rosterDraft = { base, text: roster.value }; });
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: `名单（${p.students.length} 人）` }),
      roster,
      el("p", {
        class: "hint",
        text: p.students.length
          ? `当前 ${p.students.length} 人：${p.students.map((s) => s.name).join("、")}`
          : "还没有名单。可以从表格里整列复制名字粘贴进来，按换行、逗号、顿号、空格自动拆开。",
      }),
      el("div", { class: "addrow" }, el("button", { class: "btn primary", text: "保存名单", onClick: () => p.onSaveNames(roster.value) })),
    ])
  );

  // 题库
  const bankRows = p.banks.map((b) =>
    el("div", { class: "item" }, [
      el("span", { class: "label", text: `${b.name} · ${b.items.length} 题` }),
      el("button", { class: "small", text: "改名", "aria-label": `改名 ${b.name}`, onClick: () => p.onRenameBank(b.id) }),
      el("button", { class: "small", text: "替换题目", "aria-label": `替换题目 ${b.name}`, onClick: () => p.onReplaceBank(b.id) }),
      el("button", { class: "small", text: "删除", "aria-label": `删除 ${b.name}`, onClick: () => p.onRemoveBank(b.id) }),
    ])
  );
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: `题库（${p.banks.length}）` }),
      p.banks.length === 0 ? el("p", { class: "hint", text: "还没有题库。点「新建题库」，一行一题粘进去，答案写在同一行用｜隔开。" }) : null,
      ...bankRows,
      el("div", { class: "addrow" }, el("button", { class: "btn primary", text: "新建题库", onClick: p.onAddBank })),
    ])
  );

  // 朗读：浏览器不支持就整段不显示
  if (p.canSpeak) {
    root.append(
      el("section", { class: "section" }, [
        el("h2", { text: "朗读" }),
        toggleBtn("抽题后自动朗读", p.prefs.autoSpeak, () => p.onToggleAutoSpeak(!p.prefs.autoSpeak)),
      ])
    );
  }

  // 备份与恢复（照搬班级积分）
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
      document.createTextNode("数据只在你的设备里，我们看不到。"),
      el("br"),
      document.createTextNode("建议每学期备份一次。"),
    ])
  );
}

// 题库编辑弹层：题库名 + 多行题目。onSave(name, text) 返回 false 时保持打开（如没解析到题目）
export function openBankEditor({ title, name = "", text = "", onSave }) {
  const nameInput = el("input", { maxlength: "20", "aria-label": "题库名", placeholder: "比如：英语口语", enterkeyhint: "next" });
  nameInput.value = name;
  const ta = el("textarea", { "aria-label": "题目", placeholder: "一行一题；答案写在同一行，用｜或|或 Tab 隔开" });
  ta.value = text;
  const okBtn = el("button", { class: "btn primary", text: "保存" });
  const cancelBtn = el("button", { class: "btn", text: "取消" });
  const sheet = mountSheet({
    label: title,
    body: [
      el("h2", { text: title }),
      el("label", { text: "题库名" }),
      nameInput,
      el("label", { text: "题目" }),
      ta,
      el("div", { class: "row" }, [cancelBtn, okBtn]),
    ],
    focus: name ? ta : nameInput,
  });
  cancelBtn.addEventListener("click", sheet.close);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) ta.focus(); });
  let busy = false;
  okBtn.addEventListener("click", async () => {
    if (busy) return;
    if (!nameInput.value.trim()) {
      showToast("题库名不能为空");
      nameInput.focus();
      return;
    }
    busy = true;
    try {
      const r = await onSave(nameInput.value, ta.value);
      if (r !== false) sheet.close();
    } finally {
      busy = false;
    }
  });
}

// ---------- 以下从班级积分 ui.js 照抄（弹层骨架、文本弹层、确认框、输入框） ----------

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
