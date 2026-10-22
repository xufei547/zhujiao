// 转盘：SVG 绘制与旋转动画。只在函数内部碰 DOM，Node 里导入不会抛错。
// 约定：扇区从顶部（12 点）开始顺时针排，第 i 个扇区中心角 = (i+0.5)*360/扇区数；指针固定在顶部。

export const WHEEL_MAX = 24; // 最多画 24 个扇区；条目更多时只画色块不画字，结果仍从全部条目里抽

const SVG_NS = "http://www.w3.org/2000/svg";
const R = 96;          // 扇区半径（viewBox 为 -100 -100 200 200）
const INK = "#4C1D95";
// 糖果教室八色 soft（粉/黄/绿/蓝/紫/橙/青/红）
const DEFAULT_COLORS = ["#FCE7F3", "#FEF3C7", "#DCFCE7", "#DBEAFE", "#EDE9FE", "#FFEDD5", "#CCFBF1", "#FEE2E2"];

// 角度（度，顶部为 0、顺时针）→ 圆上坐标
function pt(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [+(r * Math.sin(a)).toFixed(3), +(-r * Math.cos(a)).toFixed(3)];
}

function clipLabel(s, max) {
  const chars = Array.from(String(s ?? "").trim());
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
}

// 扇区配色：轮换；扇区数 >1 时保证最后一块和第一块不同色
function sectorColors(n, colors) {
  const pal = colors && colors.length ? colors : DEFAULT_COLORS;
  const out = Array.from({ length: n }, (_, i) => pal[i % pal.length]);
  if (n > 1 && pal.length > 1 && out[n - 1] === out[0]) out[n - 1] = pal[1 % pal.length] === out[n - 2] ? pal[2 % pal.length] : pal[1 % pal.length];
  return out;
}

// 画转盘：扇区等分（最多 24），每扇区一个色块 + 文字（>12 条时字号缩小，>24 条不画文字）
export function renderWheel(svg, labels, colors) {
  const doc = svg.ownerDocument || globalThis.document;
  const mk = (tag, attrs = {}) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const list = Array.from(labels || []);
  const n = Math.min(list.length, WHEEL_MAX);
  const showText = list.length <= WHEEL_MAX;
  const fontSize = n <= 12 ? 12 : 8;
  const maxChars = n <= 8 ? 6 : 4;
  const fills = sectorColors(Math.max(n, 1), colors);

  svg.setAttribute("viewBox", "-100 -100 200 200");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `转盘，共 ${list.length} 项`);
  const nodes = [];

  if (n <= 1) {
    nodes.push(mk("circle", { cx: 0, cy: 0, r: R, fill: fills[0], stroke: "#fff", "stroke-width": 2 }));
    if (n === 1) {
      const t = mk("text", { x: 0, y: -R * 0.55, "text-anchor": "middle", "dominant-baseline": "central", "font-size": fontSize, "font-weight": 700, fill: INK });
      t.textContent = clipLabel(list[0], maxChars);
      nodes.push(t);
    }
  } else {
    const step = 360 / n;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pt(i * step, R);
      const [x1, y1] = pt((i + 1) * step, R);
      nodes.push(mk("path", {
        d: `M0 0 L${x0} ${y0} A${R} ${R} 0 ${step > 180 ? 1 : 0} 1 ${x1} ${y1} Z`,
        fill: fills[i], stroke: "#fff", "stroke-width": 1.5,
      }));
    }
    if (showText) {
      for (let i = 0; i < n; i++) {
        const mid = (i + 0.5) * step;
        const t = mk("text", {
          // 左半边（mid > 180）的文字再转 180°，否则读起来是倒的
          transform: `rotate(${+(mid - 90).toFixed(3)}) translate(${R * 0.6} 0)${mid > 180 ? " rotate(180)" : ""}`,
          "text-anchor": "middle", "dominant-baseline": "central",
          "font-size": fontSize, "font-weight": 700, fill: INK,
        });
        t.textContent = clipLabel(list[i], maxChars);
        nodes.push(t);
      }
    }
  }
  nodes.push(mk("circle", { cx: 0, cy: 0, r: 10, fill: "#fff", stroke: "#7C3AED", "stroke-width": 3 }));

  if (typeof svg.replaceChildren === "function") svg.replaceChildren(...nodes);
  else {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const node of nodes) svg.appendChild(node);
  }
}

// 目标角度：从当前累计角度 current 出发，再转 turns 整圈 + 补到「index 扇区中心停在顶部」所需的角度。
// current 为 0 时恰好等于规格公式 5*360 + (360 - (index+0.5)*360/total)；
// current 不是 360 的整数倍时（第二次及以后转）也能对准，不会累积偏差。total >24 时按 24 扇区、index 取模。
export function spinTarget(current, index, total, turns = 5) {
  const sectors = Math.max(1, Math.min(Math.floor(total) || 1, WHEEL_MAX));
  const idx = (((Math.floor(index) || 0) % sectors) + sectors) % sectors;
  const step = 360 / sectors;
  const cur = Number(current) || 0;
  const want = (((360 - (idx + 0.5) * step) % 360) + 360) % 360;
  const curMod = ((cur % 360) + 360) % 360;
  const delta = (((want - curMod) % 360) + 360) % 360;
  return cur + turns * 360 + delta;
}

// 旋转 el（建议传整个 <svg> 或包它的元素，按自身中心旋转）到 index 扇区落在顶部指针下。
// 累计角度存在 el.dataset.angle；ms<=0 时不做动画、立即完成。Promise 在 transitionend 或超时兜底后 resolve。
export function spinTo(el, index, total, ms = 2500) {
  const from = Number(el.dataset && el.dataset.angle) || 0;
  const to = spinTarget(from, index, total);
  if (el.dataset) el.dataset.angle = String(to);
  el.style.transformOrigin = "50% 50%";
  el.style.transformBox = "fill-box";
  if (!(ms > 0)) {
    el.style.transition = "none";
    el.style.transform = `rotate(${to}deg)`;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (e) => { if (e.target === el && (!e.propertyName || e.propertyName === "transform")) finish(); };
    el.addEventListener("transitionend", onEnd);
    timer = setTimeout(finish, ms + 150); // 后台标签页或被打断时 transitionend 可能不来
    el.style.transition = `transform ${ms}ms cubic-bezier(0.17, 0.67, 0.12, 1)`;
    el.style.transform = `rotate(${to}deg)`;
  });
}
