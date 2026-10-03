"use strict";

const GROUPS = [
  ["rates", "금리"],
  ["inflation", "물가"],
  ["growth", "성장·고용"],
  ["markets", "환율·시장·위험"],
];
const DECIMALS = { "%": 2, "%p": 2, "원": 1, "pt": 2, "$/배럴": 2, "천 명": 0 };
const RATE_UNITS = new Set(["%", "%p"]);
const PERIOD_LABEL = { D: "전일 대비", M: "전월 대비", Q: "전기 대비" };
const COUNTRY = { KR: "한국", US: "미국" };
const SPARK_YEARS = { D: 1, M: 3, Q: 5 };
const RANGES = [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [0, "전체"]];
const SVG_NS = "http://www.w3.org/2000/svg";

const state = { data: null, country: "ALL", view: "dash" };

// ── 유틸 ──
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function fmtNum(v, unit, { signed = false } = {}) {
  const d = DECIMALS[unit] ?? 2;
  const s = Math.abs(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  return sign + s;
}

function fmtValue(s, v) {
  return fmtNum(v, s.unit, { signed: s.unit === "천 명" });
}

function fmtDate(s, iso) {
  const [y, m, d] = iso.split("-");
  if (s.freq === "Q") return `${y}년 ${Math.floor((+m - 1) / 3) + 1}분기`;
  if (s.freq === "M") return `${y}년 ${+m}월`;
  return `${y}.${m}.${d}`;
}

function fmtDelta(s) {
  const p = s.points;
  if (p.length < 2) return "";
  const cur = p[p.length - 1][1];
  const prev = p[p.length - 2][1];
  if (s.unit === "천 명") return `직전 ${fmtValue(s, prev)}${s.unit}`;
  const diff = cur - prev;
  let txt;
  if (RATE_UNITS.has(s.unit)) {
    if (Math.abs(diff) < 1e-9) return `변동 없음 · ${PERIOD_LABEL[s.freq]}`;
    txt = `${Math.abs(diff).toFixed(2)}%p`;
  } else {
    if (!prev) return "";
    const pct = (diff / Math.abs(prev)) * 100;
    if (Math.abs(pct) < 0.005) return `변동 없음 · ${PERIOD_LABEL[s.freq]}`;
    txt = `${Math.abs(pct).toFixed(2)}%`;
  }
  return `${diff > 0 ? "▲" : "▼"} ${txt} · ${PERIOD_LABEL[s.freq]}`;
}

function fmtKST(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())} KST`;
}

const toTime = (iso) => Date.parse(iso + "T00:00:00Z");

function sliceYears(points, years) {
  if (!years || !points.length) return points;
  const last = new Date(toTime(points[points.length - 1][0]));
  last.setUTCFullYear(last.getUTCFullYear() - years);
  const cut = last.getTime();
  return points.filter((p) => toTime(p[0]) >= cut);
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, lo, hi, step };
}

function tickLabel(v, step) {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ── 데이터 로드 ──
async function load(force = false) {
  const btn = $("#refresh");
  btn.classList.add("spin");
  btn.disabled = true;
  try {
    const res = await fetch("data/macro.json" + (force ? `?t=${Date.now()}` : ""), { cache: force ? "reload" : "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    $("#asof").textContent = `데이터 수집: ${fmtKST(state.data.generated_at)}`;
    renderDash();
  } catch (e) {
    $("#asof").textContent = state.data
      ? `새로고침 실패 — 이전 데이터 표시 중 (수집: ${fmtKST(state.data.generated_at)})`
      : "데이터를 불러오지 못했습니다. 네트워크를 확인해 주세요.";
  } finally {
    btn.classList.remove("spin");
    btn.disabled = false;
  }
}

// ── 대시보드 ──
function renderDash() {
  const root = $("#dash");
  root.replaceChildren();
  if (!state.data) return;
  const series = state.data.series.filter((s) => state.country === "ALL" || s.country === state.country);
  for (const [gid, gname] of GROUPS) {
    const items = series.filter((s) => s.group === gid && s.points.length);
    if (!items.length) continue;
    root.append(el("h2", { class: "section-title", text: gname }));
    const grid = el("div", { class: "grid" });
    for (const s of items) grid.append(tile(s));
    root.append(grid);
  }
}

function tile(s) {
  const last = s.points[s.points.length - 1];
  const node = el("button", { class: "tile", type: "button", onclick: () => openDetail(s) },
    el("div", { class: "tile-head" },
      el("span", { class: "badge", text: s.country }),
      el("span", { class: "tile-label", text: s.name })),
    el("div", { class: "tile-value" },
      document.createTextNode(fmtValue(s, last[1])),
      el("span", { class: "unit", text: s.unit })),
    el("div", { class: "delta", text: fmtDelta(s) }),
    sparkline(sliceYears(s.points, SPARK_YEARS[s.freq])),
    el("div", { class: "tile-date", text: `기준 ${fmtDate(s, last[0])}` }),
    s.error ? el("div", { class: "stale", text: "최근 갱신 실패 · 이전 데이터" }) : null,
  );
  node.setAttribute("aria-label", `${COUNTRY[s.country]} ${s.name} ${fmtValue(s, last[1])}${s.unit}, ${fmtDelta(s)}, 기준 ${fmtDate(s, last[0])}. 자세히 보기`);
  return node;
}

function sparkline(points) {
  const W = 100, H = 34, PAD = 3;
  const root = svg("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  if (points.length < 2) return root;
  const xs = points.map((p) => toTime(p[0]));
  const ys = points.map((p) => p[1]);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const sx = (x) => ((x - x0) / (x1 - x0 || 1)) * (W - PAD * 2) + PAD;
  const sy = (y) => H - PAD - ((y - lo) / (hi - lo || 1)) * (H - PAD * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(2)},${sy(ys[i]).toFixed(2)}`).join("");
  root.append(svg("path", { d, fill: "none", stroke: "var(--muted)", "stroke-width": "1.5", "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  // 마지막 점은 accent로 강조 (viewBox 비율 왜곡을 피하려고 별도 HTML 레이어 대신 짧은 선분으로 표시)
  const lx = sx(xs[xs.length - 1]), ly = sy(ys[ys.length - 1]);
  root.append(svg("path", { d: `M${lx},${ly}L${lx},${ly}`, stroke: "var(--accent)", "stroke-width": "6", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
  return root;
}

// ── 상세 ──
function openDetail(s) {
  const dlg = $("#sheet");
  const body = $("#sheet-body");
  $("#sheet-title").textContent = `${COUNTRY[s.country]} · ${s.name}`;
  body.replaceChildren();
  const last = s.points[s.points.length - 1];

  body.append(
    el("div", { class: "hero" }, document.createTextNode(fmtValue(s, last[1])), el("span", { class: "unit", text: s.unit })),
    el("div", { class: "hero-sub", text: `${fmtDelta(s)} · 기준 ${fmtDate(s, last[0])}` }),
  );
  if (s.error) body.append(el("div", { class: "stale", style: "margin-top:6px", text: `최근 갱신 실패 (${s.error}) · 이전 데이터 표시` }));

  const spanYears = (toTime(last[0]) - toTime(s.points[0][0])) / (365.25 * 864e5);
  const ranges = RANGES.filter(([y]) => y === 0 || y < spanYears - 0.2);
  let current = ranges.find(([y]) => y === (s.freq === "D" ? 1 : 5)) ? (s.freq === "D" ? 1 : 5) : 0;

  const rangeRow = el("div", { class: "ranges", role: "group", "aria-label": "기간" });
  const chartCard = el("div", { class: "chart-card" });
  const tableWrap = el("div", { hidden: "" });
  const tableBtn = el("button", { class: "link-btn", type: "button", text: "표로 보기" });
  tableBtn.addEventListener("click", () => {
    const show = tableWrap.hasAttribute("hidden");
    tableWrap.toggleAttribute("hidden", !show);
    tableBtn.textContent = show ? "표 숨기기" : "표로 보기";
  });

  function update() {
    const pts = sliceYears(s.points, current);
    for (const b of rangeRow.children) b.setAttribute("aria-pressed", String(+b.dataset.y === current));
    drawChart(chartCard, pts, s);
    renderTable(tableWrap, pts, s);
  }
  for (const [y, label] of ranges) {
    rangeRow.append(el("button", { class: "chip", type: "button", "data-y": String(y), text: label, onclick: () => { current = y; update(); } }));
  }

  const meta = el("dl", { class: "meta" },
    el("dt", { text: "설명" }), el("dd", { text: s.desc }),
    el("dt", { text: "출처" }), el("dd", {},
      document.createTextNode(`${s.source === "ECOS" ? "한국은행 ECOS" : "FRED (St. Louis Fed)"} · ${s.source_code} · `),
      el("a", { href: s.source_url, target: "_blank", rel: "noopener", text: "원문 보기" })),
    el("dt", { text: "수집 시각" }), el("dd", { text: fmtKST(s.fetched_at) }),
  );

  body.append(rangeRow, chartCard, tableBtn, tableWrap, meta);
  dlg.showModal();
  update();
}

function renderTable(wrap, pts, s) {
  const rows = pts.slice(-60).reverse();
  const tbody = el("tbody");
  for (const [d, v] of rows) tbody.append(el("tr", {}, el("td", { text: fmtDate(s, d) }), el("td", { text: fmtValue(s, v) })));
  wrap.replaceChildren(
    el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", { text: "기준" }), el("th", { text: `값 (${s.unit})` }))),
      tbody),
    pts.length > 60 ? el("p", { class: "tile-date", text: `최근 60개만 표시 (선택 기간 전체 ${pts.length}개)` }) : null,
  );
}

function drawChart(card, pts, s) {
  card.replaceChildren();
  const W = Math.max(card.clientWidth - 8, 260);
  const PLOT_H = 200, TOP = 10, XBAND = 26, H = TOP + PLOT_H + XBAND;
  const ys = pts.map((p) => p[1]);
  const { ticks, lo, hi, step } = niceTicks(Math.min(...ys), Math.max(...ys));
  const labels = ticks.map((t) => tickLabel(t, step));
  const LEFT = Math.max(...labels.map((l) => l.length)) * 6.5 + 10, RIGHT = 12;
  const xs = pts.map((p) => toTime(p[0]));
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const sx = (x) => LEFT + ((x - x0) / (x1 - x0 || 1)) * (W - LEFT - RIGHT);
  const sy = (y) => TOP + PLOT_H - ((y - lo) / (hi - lo || 1)) * PLOT_H;

  const root = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, tabindex: "0", role: "img",
    "aria-label": `${s.name} 추이 차트, ${fmtDate(s, pts[0][0])}부터 ${fmtDate(s, pts[pts.length - 1][0])}까지. 좌우 화살표로 값 확인` });

  // 가로 격자 + y 라벨
  ticks.forEach((t, i) => {
    const y = sy(t);
    root.append(svg("line", { x1: LEFT, x2: W - RIGHT, y1: y, y2: y, stroke: t === 0 && lo < 0 ? "var(--axis)" : "var(--grid)", "stroke-width": "1" }));
    const tx = svg("text", { x: LEFT - 6, y: y + 4, "text-anchor": "end" });
    tx.textContent = labels[i];
    root.append(tx);
  });

  // x 라벨: 기간에 따라 연/반기/분기 단위
  const yearsSpan = (x1 - x0) / (365.25 * 864e5);
  const monthStep = yearsSpan > 8 ? 24 : yearsSpan > 2.5 ? 12 : yearsSpan > 1.2 ? 6 : 3;
  const start = new Date(x0);
  let tY = start.getUTCFullYear(), tM = 0;
  while (Date.UTC(tY, tM, 1) < x0) { tM += monthStep; if (tM >= 12) { tY += Math.floor(tM / 12); tM %= 12; } }
  if (monthStep === 24 && tY % 2) tY += 1;
  for (let t = Date.UTC(tY, tM, 1); t <= x1; ) {
    const x = sx(t);
    const d = new Date(t);
    const label = monthStep >= 12 ? `${d.getUTCFullYear()}` : d.getUTCMonth() === 0 ? `${d.getUTCFullYear()}` : `${d.getUTCMonth() + 1}월`;
    root.append(svg("line", { x1: x, x2: x, y1: TOP + PLOT_H, y2: TOP + PLOT_H + 4, stroke: "var(--axis)" }));
    const anchor = x > W - RIGHT - 14 ? "end" : x < LEFT + 14 ? "start" : "middle";
    const tx = svg("text", { x: anchor === "end" ? Math.min(x + 6, W - 2) : x, y: TOP + PLOT_H + 18, "text-anchor": anchor });
    tx.textContent = label;
    root.append(tx);
    d.setUTCMonth(d.getUTCMonth() + monthStep);
    t = d.getTime();
  }
  root.append(svg("line", { x1: LEFT, x2: W - RIGHT, y1: TOP + PLOT_H, y2: TOP + PLOT_H, stroke: "var(--axis)" }));

  // 선
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
  root.append(svg("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // 마지막 값 직접 라벨용 점
  const lx = sx(x1), ly = sy(ys[ys.length - 1]);
  root.append(svg("circle", { cx: lx, cy: ly, r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": "2" }));

  // 크로스헤어
  const vline = svg("line", { y1: TOP, y2: TOP + PLOT_H, stroke: "var(--ink-2)", "stroke-width": "1", visibility: "hidden" });
  const dot = svg("circle", { r: 5, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": "2", visibility: "hidden" });
  root.append(vline, dot);
  const tip = el("div", { class: "tooltip", role: "status", "aria-live": "polite" });
  card.append(root, tip);

  let idx = -1;
  function show(i) {
    idx = Math.max(0, Math.min(pts.length - 1, i));
    const x = sx(xs[idx]), y = sy(ys[idx]);
    vline.setAttribute("x1", x); vline.setAttribute("x2", x); vline.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
    tip.replaceChildren(el("strong", { text: `${fmtValue(s, ys[idx])} ${s.unit}` }), el("span", { text: fmtDate(s, pts[idx][0]) }));
    tip.style.display = "block";
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = `${Math.min(Math.max(x + 4, half), card.clientWidth - half)}px`;
  }
  function hide() {
    vline.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
    tip.style.display = "none"; idx = -1;
  }
  function nearest(clientX) {
    const r = root.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const t = x0 + ((x - LEFT) / (W - LEFT - RIGHT)) * (x1 - x0);
    let a = 0, b = xs.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (xs[m] < t) a = m; else b = m; }
    return Math.abs(xs[a] - t) <= Math.abs(xs[b] - t) ? a : b;
  }
  root.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
  root.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
  root.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show((idx < 0 ? pts.length - 1 : idx) + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "Escape" && idx >= 0) { e.stopPropagation(); hide(); }
  });
  root.addEventListener("blur", hide);
}

// ── 브리핑 ──
const TAG = { fact: "사실", forecast: "전망", opinion: "해석" };

async function renderBrief() {
  const root = $("#brief");
  root.replaceChildren(el("p", { class: "note", text: "불러오는 중…" }));
  let b = null;
  try {
    const res = await fetch(`data/briefing.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) b = await res.json();
  } catch (_) { /* 오프라인 */ }
  root.replaceChildren();
  if (!b) {
    root.append(el("div", { class: "empty" },
      el("h3", { text: "아직 브리핑이 없습니다" }),
      el("p", { text: "Claude에게 \"매크로 브리핑 작성해줘\"라고 요청하면, 그 시점의 데이터로 작성해 이곳에 올립니다. 자동으로 생성되지 않습니다." })));
    return;
  }
  root.append(
    el("h2", { class: "section-title", style: "font-size:17px;color:var(--ink)", text: b.title || "매크로 브리핑" }),
    el("p", { class: "asof", text: `기준 시점: ${b.as_of || "-"}` }),
  );
  if (b.summary) root.append(el("div", { class: "brief-card" }, el("p", { style: "margin:0", text: b.summary })));
  for (const sec of b.sections || []) {
    const card = el("div", { class: "brief-card" }, el("h3", { text: sec.heading }));
    for (const it of sec.items || []) {
      const item = el("div", { class: "brief-item" },
        el("span", { class: "tag", text: TAG[it.type] || "기타" }),
        el("p", { text: it.text }));
      if (it.source) {
        const src = el("div", { class: "brief-src" }, document.createTextNode("출처: "));
        if (it.url && /^https?:\/\//.test(it.url)) src.append(el("a", { href: it.url, target: "_blank", rel: "noopener", text: it.source }));
        else src.append(document.createTextNode(it.source));
        item.append(src);
      }
      card.append(item);
    }
    root.append(card);
  }
  root.append(el("p", { class: "note", text: "브리핑은 정보 제공용이며, 최종 투자 판단은 본인에게 있습니다." }));
}

// ── 이벤트 ──
function setView(view) {
  state.view = view;
  for (const b of document.querySelectorAll(".tabbar button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  $("#view-dash").hidden = view !== "dash";
  $("#view-brief").hidden = view !== "brief";
  $("#page-title").textContent = view === "dash" ? "매크로 지표" : "매크로 브리핑";
  if (view === "brief") renderBrief();
  window.scrollTo(0, 0);
}

document.querySelectorAll(".filters .chip").forEach((b) =>
  b.addEventListener("click", () => {
    state.country = b.dataset.country;
    document.querySelectorAll(".filters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderDash();
  }));
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#refresh").addEventListener("click", () => (state.view === "brief" ? renderBrief() : load(true)));
$("#sheet-close").addEventListener("click", () => $("#sheet").close());
$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if ($("#sheet").open) $("#sheet .ranges .chip[aria-pressed='true']")?.click(); }, 150);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

load();
