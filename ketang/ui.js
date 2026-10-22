// app/ui.js
// 只管 DOM：渲染页面、弹层、toast。不碰存储，所有写操作通过回调交给 main.js。
// el / showToast / mountSheet / openSheet / openTextSheet / askConfirm / askText / toggleBtn / fsExit 照抄随机点名抽题。
import { formatClock } from "./state.js";
import { renderWheel } from "./wheel.js";

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

// 空状态：插画 + 一句话 + 按钮
function emptyState(text, btnText, onClick) {
  return el("div", { class: "empty" }, [
    el("img", { src: "assets/empty.png", alt: "" }),
    el("p", { text }),
    btnText ? el("button", { class: "btn primary", text: btnText, onClick }) : null,
  ]);
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

// ---------- 倒计时 ----------

// 预设（秒）
export const TIMER_PRESETS = [
  { sec: 30, label: "30 秒" },
  { sec: 60, label: "1 分" },
  { sec: 120, label: "2 分" },
  { sec: 180, label: "3 分" },
  { sec: 300, label: "5 分" },
];

const WARN_MS = 10000; // 剩余 ≤10 秒变红

// 只改 .clock 的文字和样式，不整页重渲染（main 每次 tick 调用）。
// s = { remainingMs, running, done }
export function paintClock(root, s) {
  const c = root.querySelector(".stage .clock");
  if (!c) return;
  const t = s.done ? "时间到" : formatClock(s.remainingMs / 1000);
  if (c.textContent !== t) c.textContent = t;
  // 满 1 小时显示 h:mm:ss，7 个字符按 24vw 会溢出，字号收小
  const fs = t.length > 5 ? "clamp(48px, 14vw, 180px)" : "";
  if (c.style.fontSize !== fs) c.style.fontSize = fs;
  c.classList.toggle("warn", Boolean(s.running && s.remainingMs > 0 && s.remainingMs <= WARN_MS));
}

// 倒计时页。p = { presetSec, remainingMs, running, done, flashing, fullscreen,
//   onPreset(sec), onCustom(), onToggle(), onReset(), onFullscreen(), onExitFullscreen() }
// 运行中的每次 tick 只走 paintClock；这里只在状态变化（开始/暂停/重置/换预设/到点）时整页渲染
export function renderTimer(root, p) {
  root.replaceChildren();
  root.append(
    el("div", { class: "topbar fs-hide" }, [
      el("span", { class: "left", text: "倒计时" }),
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );

  const isPreset = TIMER_PRESETS.some((x) => x.sec === p.presetSec);
  const chips = TIMER_PRESETS.map((x) =>
    el("button", {
      class: "chipbtn",
      text: x.label,
      "aria-pressed": x.sec === p.presetSec ? "true" : "false",
      onClick: () => p.onPreset(x.sec),
    })
  );
  chips.push(
    el("button", {
      class: "chipbtn",
      text: isPreset ? "自定义…" : `自定义 ${formatClock(p.presetSec)}`,
      "aria-pressed": isPreset ? "false" : "true",
      onClick: p.onCustom,
    })
  );
  root.append(el("div", { class: "presets fs-hide", role: "group", "aria-label": "预设时长" }, chips));

  const clock = el("div", { class: "clock", role: "timer", "aria-live": "off" });
  const stage = el("div", { class: p.flashing ? "stage flash" : "stage" }, clock);
  root.append(stage);
  paintClock(root, p);

  root.append(el("button", { class: "bigbtn", text: p.running ? "暂停" : "开始", onClick: p.onToggle }));
  root.append(el("div", { class: "small-row" }, el("button", { class: "btn", text: "重置", onClick: p.onReset })));

  if (p.fullscreen) root.append(fsExit(p));
}

// ---------- 转盘 ----------

// 糖果教室八色 soft（粉/黄/绿/蓝/紫/橙/青/红），与 style.css 的 .c0～.c7 一致
export const SOFT_COLORS = ["#FCE7F3", "#FEF9C3", "#DCFCE7", "#DBEAFE", "#EDE9FE", "#FFEDD5", "#CCFBF1", "#FEE2E2"];

// 转盘页。p = { sources: [{value,label}], source, labels: [string], noRepeat, left, spinning, result: string|null,
//   angle, fullscreen, onSource(v), onToggleNoRepeat(), onSpin(), onReset(), onFullscreen(), onExitFullscreen(), onGoSettings() }
// angle：转盘当前累计角度（spinTo 存在 svg.dataset.angle 里；整页重渲染后按它摆回原位）
export function renderWheelPage(root, p) {
  root.replaceChildren();

  const sel = el("select", {
    class: "field",
    "aria-label": "转什么",
    style: "min-width:0",
    disabled: p.spinning ? "" : null,
  });
  for (const s of p.sources) {
    const opt = el("option", { value: s.value, text: s.label });
    if (s.value === p.source) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener("change", () => p.onSource(sel.value));
  root.append(
    el("div", { class: "topbar fs-hide" }, [
      sel,
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );

  if (p.labels.length < 2) {
    root.append(emptyState("至少要 2 个条目", "去设置", p.onGoSettings));
    if (p.fullscreen) root.append(fsExit(p));
    return;
  }

  root.append(
    el("div", { class: "switch-row fs-hide" }, [
      toggleBtn("抽过的不再抽", p.noRepeat, p.onToggleNoRepeat, p.spinning),
      p.noRepeat ? el("span", { class: "hint", style: "margin-top:0", text: `本轮还剩 ${p.left} / ${p.labels.length}` }) : null,
    ])
  );

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  renderWheel(svg, p.labels, SOFT_COLORS);
  // 和 spinTo 一样的旋转基准，重渲染后停在原角度
  const angle = Number(p.angle) || 0;
  svg.dataset.angle = String(angle);
  svg.style.transformOrigin = "50% 50%";
  svg.style.transformBox = "fill-box";
  svg.style.transform = `rotate(${angle}deg)`;
  root.append(el("div", { class: "wheelwrap" }, [svg, el("div", { class: "ptr", "aria-hidden": "true" })]));

  const has = p.result != null && !p.spinning;
  root.append(
    el("div", {
      class: "result",
      "aria-live": "polite",
      style: has ? null : "color:var(--muted)",
      text: p.spinning ? "……" : has ? p.result : (p.sourceIsStudents === false ? "转到什么？" : "转到谁？"),
    })
  );

  root.append(el("button", { class: "bigbtn", text: "转", disabled: p.spinning ? "" : null, onClick: p.onSpin }));
  root.append(
    el("div", { class: "small-row" }, el("button", { class: "btn", text: "重置", disabled: p.spinning ? "" : null, onClick: p.onReset }))
  );

  if (p.fullscreen) root.append(fsExit(p));
}

// ---------- 分组 / 计分 共用 ----------

// 数字步进器（−  n  +）；到边界的那一侧按钮禁用
function stepper(label, value, min, max, onChange) {
  return el("div", { class: "stepper", role: "group", "aria-label": label }, [
    el("button", { text: "−", "aria-label": `${label}减一`, disabled: value <= min ? "" : null, onClick: () => onChange(value - 1) }),
    el("b", { text: String(value), "aria-live": "polite" }),
    el("button", { text: "+", "aria-label": `${label}加一`, disabled: value >= max ? "" : null, onClick: () => onChange(value + 1) }),
  ]);
}

// 默认组名「第 N 组」（N 从 1 开始）
export function defaultGroupName(i) {
  return `第 ${i + 1} 组`;
}

// ---------- 分组 ----------

export const GROUP_N_MIN = 2, GROUP_N_MAX = 12;

// 分组页。p = { total: 名单人数, active: 这次参加人数, mode: "count"|"size", n,
//   groups: [{ name, members: [{ name, out }] }] | null, absent: [string]（名单里被划掉的人）, fullscreen,
//   onMode(m), onN(n), onGroup(), onRegroup(), onCopy(), onRename(i), onToggleOut(name), onGoSettings(),
//   onFullscreen(), onExitFullscreen() }
export function renderGroups(root, p) {
  root.replaceChildren();
  root.append(
    el("div", { class: "topbar fs-hide" }, [
      el("span", { class: "left", text: "分组" }),
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );

  if (p.total === 0) {
    root.append(emptyState("先去设置页粘名单", "去设置", p.onGoSettings));
    if (p.fullscreen) root.append(fsExit(p));
    return;
  }

  const modeBtn = (m, label) =>
    el("button", { text: label, "aria-pressed": p.mode === m ? "true" : "false", onClick: () => p.onMode(m) });
  root.append(
    el("div", { class: "groupctl fs-hide" }, [
      el("div", { class: "seg", role: "group", "aria-label": "分组方式" }, [modeBtn("count", "按组数"), modeBtn("size", "按每组人数")]),
      el("div", { class: "steprow" }, [
        el("span", { class: "label", text: p.mode === "size" ? "每组人数" : "组数" }),
        stepper(p.mode === "size" ? "每组人数" : "组数", p.n, GROUP_N_MIN, GROUP_N_MAX, p.onN),
        el("span", { class: "hint", text: p.active === p.total ? `共 ${p.total} 人` : `${p.active} / ${p.total} 人参加` }),
      ]),
    ])
  );

  if (p.groups) {
    const cards = p.groups.map((g, i) =>
      el("div", { class: `gcard c${i % 8}` }, [
        el("h3", {}, el("button", { class: "gname", text: g.name, "aria-label": `改组名 ${g.name}`, onClick: () => p.onRename(i) })),
        el(
          "div",
          { class: "mem" },
          g.members.map((m) =>
            el("button", {
              class: m.out ? "out" : "",
              text: m.name,
              "aria-pressed": m.out ? "true" : "false",
              "aria-label": m.out ? `${m.name}（这次不参加，点一下恢复）` : `${m.name}（点一下划掉，这次不参加）`,
              onClick: () => p.onToggleOut(m.name),
            })
          )
        ),
      ])
    );
    root.append(el("div", { class: "groupcards" }, cards));
  } else {
    root.append(el("p", { class: "hint fs-hide", text: "点「分组」随机分；分好后点组名可改名，点名字可划掉（这次不参加，再分时排除）。" }));
  }

  // 被划掉的人：分组后不在任何卡里，留个入口点回来
  if (p.absent.length) {
    root.append(
      el("div", { class: "absentrow fs-hide" }, [
        el("span", { class: "label", text: "这次不参加（点一下恢复）" }),
        el(
          "div",
          { class: "chips" },
          p.absent.map((name) => el("button", { class: "chip absent", text: name, "aria-label": `恢复 ${name}`, onClick: () => p.onToggleOut(name) }))
        ),
      ])
    );
  }

  // 投屏时：已有结果只留组卡；还没分就留着「分组」大按钮
  root.append(el("button", { class: p.groups ? "bigbtn fs-hide" : "bigbtn", text: "分组", onClick: p.onGroup }));
  if (p.groups) {
    root.append(
      el("div", { class: "small-row fs-hide" }, [
        el("button", { class: "btn", text: "再分一次", onClick: p.onRegroup }),
        el("button", { class: "btn", text: "复制结果", onClick: p.onCopy }),
      ])
    );
  }

  if (p.fullscreen) root.append(fsExit(p));
}

// ---------- 计分 ----------

export const SCORE_GROUPS_MIN = 2, SCORE_GROUPS_MAX = 8;

// 计分页。p = { names, scores, fullscreen, onCount(n), onRename(i), onAdd(i, delta) → 新分数|null, onReset(),
//   onFullscreen(), onExitFullscreen() }
// 点 ±1 只改那张卡的 .num，不整页重渲染
export function renderScores(root, p) {
  root.replaceChildren();
  root.append(
    el("div", { class: "topbar fs-hide" }, [
      el("span", { class: "left", text: "计分" }),
      el("button", { class: "iconbtn text", text: "全部清零", onClick: p.onReset }),
      el("button", { class: "iconbtn text", text: "投屏", onClick: p.onFullscreen }),
    ])
  );
  root.append(
    el("div", { class: "steprow fs-hide" }, [
      el("span", { class: "label", text: "组数" }),
      stepper("组数", p.names.length, SCORE_GROUPS_MIN, SCORE_GROUPS_MAX, p.onCount),
    ])
  );

  const cards = p.names.map((name, i) => {
    const num = el("div", { class: "num", "aria-live": "polite", text: String(p.scores[i]) });
    const bump = (d) => {
      const v = p.onAdd(i, d);
      if (v != null) num.textContent = String(v);
    };
    return el("div", { class: `scard c${i % 8}` }, [
      el("h3", {}, el("button", { class: "gname", text: name, "aria-label": `改组名 ${name}`, onClick: () => p.onRename(i) })),
      num,
      el("div", { class: "pm" }, [
        el("button", { class: "plus", text: "+1", "aria-label": `${name} 加 1 分`, onClick: () => bump(1) }),
        el("button", { class: "minus", text: "−1", "aria-label": `${name} 减 1 分`, onClick: () => bump(-1) }),
      ]),
    ]);
  });
  root.append(el("div", { class: "scoreboard" }, cards));

  if (p.fullscreen) root.append(fsExit(p));
}

// ---------- 设置 ----------

let rosterDraft = null; // { base: 渲染时的名单文本, text: 草稿 }；切页回来草稿还在，名单被别处改了就作废

// p = { students, lists, scores, inApp, onSaveNames(text), onAddList(), onRenameList(id), onReplaceList(id), onRemoveList(id),
//       onScoreCount(n), onRenameScore(i), onBackup(), onRestore(file), onPasteRestore() }
export function renderSettings(root, p) {
  root.replaceChildren();
  root.append(el("div", { class: "topbar" }, el("span", { class: "left", text: "设置" })));

  // 名单：一行一个预填；保存时整体覆盖
  const base = p.students.map((s) => s.name).join("\n");
  if (rosterDraft && rosterDraft.base !== base) rosterDraft = null;
  const roster = el("textarea", {
    class: "field roster",
    rows: "6",
    placeholder: "一行一个名字，也可以用逗号分开；也能直接粘贴「随机点名抽题」「班级积分」的备份内容",
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
          ? "分组和转盘都用这份名单。改完点「保存名单」。"
          : "还没有名单。可以从表格里整列复制名字粘贴进来，按换行、逗号、顿号、空格自动拆开。",
      }),
      el("div", { class: "addrow" }, el("button", { class: "btn primary", text: "保存名单", onClick: () => p.onSaveNames(roster.value) })),
    ])
  );

  // 自定义清单（转盘用）
  const listRows = p.lists.map((l) =>
    el("div", { class: "item" }, [
      el("span", { class: "txt", text: `${l.name} · ${l.items.length} 条` }),
      el("button", { class: "small", text: "改名", "aria-label": `改名 ${l.name}`, onClick: () => p.onRenameList(l.id) }),
      el("button", { class: "small", text: "替换", "aria-label": `替换条目 ${l.name}`, onClick: () => p.onReplaceList(l.id) }),
      el("button", { class: "small", text: "删除", "aria-label": `删除 ${l.name}`, onClick: () => p.onRemoveList(l.id) }),
    ])
  );
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: `转盘清单（${p.lists.length}）` }),
      p.lists.length === 0 ? el("p", { class: "hint", text: "还没有清单。点「新建清单」，一行一条粘进去，比如奖励、题目、值日任务。" }) : null,
      ...listRows,
      el("div", { class: "addrow" }, el("button", { class: "btn primary", text: "新建清单", onClick: p.onAddList })),
    ])
  );

  // 计分：组数与组名
  const scoreRows = p.scores.names.map((name, i) =>
    el("div", { class: "item" }, [
      el("span", { class: "txt", text: `${name} · ${p.scores.scores[i]} 分` }),
      el("button", { class: "small", text: "改名", "aria-label": `改组名 ${name}`, onClick: () => p.onRenameScore(i) }),
    ])
  );
  root.append(
    el("section", { class: "section" }, [
      el("h2", { text: "计分小组" }),
      el("div", { class: "steprow" }, [
        el("span", { class: "label", text: "组数" }),
        stepper("计分组数", p.scores.names.length, SCORE_GROUPS_MIN, SCORE_GROUPS_MAX, p.onScoreCount),
      ]),
      ...scoreRows,
    ])
  );

  // 备份与恢复（照抄随机点名抽题）
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

// 清单编辑弹层（照抄随机点名抽题 openBankEditor）：清单名 + 多行条目。onSave(name, text) 返回 false 时保持打开
export function openListEditor({ title, name = "", text = "", onSave }) {
  const nameInput = el("input", { maxlength: "20", "aria-label": "清单名", placeholder: "比如：课堂奖励", enterkeyhint: "next" });
  nameInput.value = name;
  const ta = el("textarea", { "aria-label": "条目", placeholder: "一行一条，比如：\n免作业一次\n当一天小老师" });
  ta.value = text;
  const okBtn = el("button", { class: "btn primary", text: "保存" });
  const cancelBtn = el("button", { class: "btn", text: "取消" });
  const sheet = mountSheet({
    label: title,
    body: [
      el("h2", { text: title }),
      el("label", { class: "flabel", text: "清单名" }),
      nameInput,
      el("label", { class: "flabel", text: "条目（一行一条）" }),
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
      showToast("清单名不能为空");
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

// ---------- 以下照抄随机点名抽题 ui.js（弹层骨架、文本弹层、确认框、输入框） ----------

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
