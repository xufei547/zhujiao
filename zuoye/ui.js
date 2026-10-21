// app/ui.js
import { formatDate, weekdayLabel } from "./copy.js";

const SYMBOL = { done: "✓", fix: "✎", undone: "✗" };
const STATUS_LABEL = { done: "完成", fix: "订正", undone: "未完成" };

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

export function showToast(msg, ms = 1500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => (t.hidden = true), ms);
}

export function renderToday(root, p) {
  root.replaceChildren();
  const topbar = el("div", { class: "topbar" }, [
    el("button", { class: "iconbtn", "aria-label": "前一天", text: "‹", onClick: p.onPrev }),
    el("button", { class: "date", onClick: p.onToday }, [
      document.createTextNode(formatDate(p.dateKey)),
      el("small", { text: weekdayLabel(p.dateKey) }),
    ]),
    el("button", { class: "iconbtn", "aria-label": "后一天", text: "›", onClick: p.onNext }),
  ]);
  root.append(topbar);

  if (p.students.length === 0) {
    root.append(
      el("div", { class: "empty" }, [
        el("img", { src: "assets/empty.png", alt: "" }),
        el("p", { text: "还没有孩子名单" }),
        el("button", { class: "btn primary", text: "去名单页加几个孩子", onClick: p.onGoList }),
      ])
    );
    return;
  }

  root.append(
    el("div", { class: "actions" }, [
      el("button", { class: "btn", text: "全部完成", onClick: p.onAllDone }),
      el("button", { class: "btn primary", text: "复制全部", onClick: p.onCopyAll }),
    ])
  );

  const head = el("tr", {}, [el("th", { text: "孩子" }), ...p.subjects.map((s) => el("th", { text: s.name }))]);
  const rows = p.students.map((stu) => {
    const rec = p.dayRecords[stu.id] || {};
    return el("tr", {}, [
      el("td", {}, el("button", { class: "name", text: stu.name, onClick: () => p.onName(stu.id) })),
      ...p.subjects.map((sub) => {
        const st = rec[sub.id] || null;
        return el(
          "td",
          {},
          el("button", {
            class: "cell",
            "data-status": st,
            "aria-label": `${stu.name} ${sub.name} ${STATUS_LABEL[st] || "没布置"}`,
            text: st ? SYMBOL[st] : "",
            onClick: () => p.onCell(stu.id, sub.id),
          })
        );
      }),
    ]);
  });
  root.append(el("div", { class: "grid" }, el("table", {}, [el("thead", {}, head), el("tbody", {}, rows)])));
}

function editableList({ title, items, placeholder, onChange, minCount = 0 }) {
  const list = items.map((it, i) =>
    el("div", { class: "item" }, [
      el("span", { class: "label", text: it.name }),
      el("button", { class: "small", text: "上移", disabled: i === 0 ? "" : null, onClick: () => {
        const next = items.slice(); [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next);
      } }),
      el("button", { class: "small", text: "下移", disabled: i === items.length - 1 ? "" : null, onClick: () => {
        const next = items.slice(); [next[i + 1], next[i]] = [next[i], next[i + 1]]; onChange(next);
      } }),
      el("button", { class: "small", text: "改名", onClick: async () => {
        const name = await askText("改成什么名字？", it.name);
        if (name == null) return;
        const n = name.trim();
        if (!n) return;
        onChange(items.map((x) => (x.id === it.id ? { ...x, name: n } : x)));
      } }),
      el("button", { class: "small", text: "删除", disabled: items.length <= minCount ? "" : null, onClick: async () => {
        if (items.length <= minCount) return;
        if (!(await askConfirm(`删除「${it.name}」？历史记录会保留但不再显示。`))) return;
        onChange(items.filter((x) => x.id !== it.id));
      } }),
    ])
  );
  const input = el("input", { placeholder, "aria-label": placeholder });
  const add = () => {
    const n = input.value.trim();
    if (!n) return;
    // 保存失败（返回 false）时保留输入，方便老师重试
    if (onChange([...items, { id: null, name: n }]) !== false) input.value = "";
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) add(); });
  return el("section", { class: "section" }, [
    el("h2", { text: title }),
    ...list,
    el("div", { class: "addrow" }, [input, el("button", { class: "btn primary", text: "添加", onClick: add })]),
  ]);
}

const TPL_FIELDS = [
  ["done", "完成时写"], ["fix", "订正时写"], ["undone", "未完成时写"],
  ["allDone", "结尾：全部完成"], ["hasFix", "结尾：有订正"], ["hasUndone", "结尾：有未完成"],
];

export function renderList(root, p) {
  root.replaceChildren();
  root.append(editableList({ title: "孩子", items: p.students, placeholder: "孩子名字", onChange: p.onStudents }));
  root.append(editableList({ title: "科目", items: p.subjects, placeholder: "科目名", onChange: p.onSubjects, minCount: 1 }));

  const tplInputs = {};
  let curTpl = p.template; // 改字段后不重渲染，这里记住最近一次保存的模板
  const tpl = el("section", { class: "section tpl" }, [
    el("h2", { text: "文案模板" }),
    ...TPL_FIELDS.flatMap(([k, label]) => {
      tplInputs[k] = el("input", { value: p.template[k], "aria-label": label });
      tplInputs[k].addEventListener("change", () => {
        const next = { ...curTpl };
        for (const [kk] of TPL_FIELDS) {
          next[kk] = tplInputs[kk].value.trim() || curTpl[kk];
          // 不再整页重渲染：清空的框就地填回原值，保持界面和存储一致
          if (tplInputs[kk].value !== next[kk]) tplInputs[kk].value = next[kk];
        }
        p.onTemplate(next);
        curTpl = next;
      });
      return [el("label", { text: label }), tplInputs[k]];
    }),
    el("div", { class: "addrow" }, el("button", { class: "btn", text: "恢复默认", onClick: () => p.onTemplate(null) })),
  ]);
  root.append(tpl);

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
      p.inApp ? el("p", { class: "hint", text: "微信/小红书里打开不能存文件，建议用 Safari 或浏览器打开" }) : null,
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

// 弹层骨架：遮罩、Esc（只关最上面一层）、点遮罩关闭、打开时聚焦、关闭后把焦点还回去
function mountSheet({ label, body, focus, onClose, role = "dialog" }) {
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
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") prevFocus.focus();
    if (onClose) onClose();
  }
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  mask.append(el("div", { class: "sheet", role, "aria-modal": "true", "aria-label": label }, body));
  document.body.append(mask);
  const target = [].concat(focus).find((x) => x && !x.disabled);
  if (target) target.focus();
  return { close, isClosed: () => closed };
}

export function openSheet({ title, text, onCopy, label = "反馈文案" }) {
  const ta = el("textarea", { "aria-label": label });
  const copyBtn = el("button", { class: "btn primary", text: "复制" });
  const closeBtn = el("button", { class: "btn", text: "关闭" });
  let autoCloseTimer = null;

  const body = [el("h2", { text: title })];
  if (text == null) {
    body.push(el("p", { class: "empty", text: "今天还没登记" }));
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
export function askText(message, defaultValue = "") {
  return new Promise((resolve) => {
    let result = null;
    const input = el("input", { "aria-label": message });
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
