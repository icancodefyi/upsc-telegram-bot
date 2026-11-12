import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayLabel, type Count, type ReportData } from "./site-report";

/**
 * Turns a report's numbers into a branded A4 document (HTML for the PDF renderer).
 * Brand: Funnel Sans, ballpoint blue, highlighter yellow, examiner red, Gilu the squirrel (see the site's brand.css).
 */

const C = {
  ink: "#0b0c10", ink2: "#3f4450", muted: "#858a96", canvas: "#f4f5f9", paper: "#ffffff",
  line: "rgba(11,12,16,0.10)", accent: "#1f3fd6", accentInk: "#172fa3", accentSoft: "rgba(31,63,214,0.09)", accentLight: "#c6d1ff",
  hl: "#ffe45c", hlSoft: "#fff6c2", hlInk: "#5c4a00", mark: "#ff4a3d", markDeep: "#d9342a", markSoft: "rgba(255,74,61,0.12)",
};

const asset = (p: string) => readFileSync(join(process.cwd(), "assets", p));
const dataUri = (p: string, mime: string) => `data:${mime};base64,${asset(p).toString("base64")}`;
const gilu = (pose: string) => dataUri(`gilu/gilu-${pose}.svg`, "image/svg+xml");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => n.toLocaleString("en-IN");
const rupees = (n: number) => `₹${num(n)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- small parts ----------

function delta(cur: number, prev: number, comparable = true): string {
  if (!comparable || (cur === 0 && prev === 0)) return "";
  if (prev === 0) return `<span class="chip chip-new">new</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<span class="chip chip-same">same</span>`;
  const up = pct > 0;
  const tri = up ? `<svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 1l3.5 6h-7z" fill="currentColor"/></svg>` : `<svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 7L.5 1h7z" fill="currentColor"/></svg>`;
  return `<span class="chip ${up ? "chip-up" : "chip-down"}">${tri}${Math.abs(pct)}%</span>`;
}

const tile = (label: string, value: string, d = "", note = "") =>
  `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div><div class="tile-foot">${d}${note ? `<span class="note">${esc(note)}</span>` : ""}</div></div>`;

/** Vertical bars. `stack` draws a second, lighter segment under the first. */
function bars(values: number[], labels: string[], opts: { stack?: number[]; height?: number; every?: number; unit?: string } = {}): string {
  const W = 700, H = opts.height ?? 170, padL = 4, padB = 22, padT = 22;
  const n = values.length;
  const totals = values.map((v, i) => v + (opts.stack?.[i] ?? 0));
  const max = Math.max(1, ...totals);
  const slot = (W - padL * 2) / n;
  const bw = Math.min(34, slot * 0.62);
  const peak = totals.indexOf(Math.max(...totals));
  const every = opts.every ?? (n > 16 ? Math.ceil(n / 12) : 1);
  let g = "";
  for (let i = 0; i < n; i++) {
    const x = padL + slot * i + (slot - bw) / 2;
    const h1 = ((values[i] ?? 0) / max) * (H - padT - padB);
    const h2 = ((opts.stack?.[i] ?? 0) / max) * (H - padT - padB);
    const y1 = H - padB - h1;
    const y2 = y1 - h2;
    const isPeak = i === peak && totals[i] > 0;
    if (h2 > 0) g += `<rect x="${x}" y="${y2}" width="${bw}" height="${h2}" rx="3" fill="${C.accentLight}"/>`;
    if (h1 > 0) g += `<rect x="${x}" y="${y1}" width="${bw}" height="${h1}" rx="3" fill="${isPeak && !opts.stack ? C.hl : C.accent}"/>`;
    if (isPeak) g += `<text x="${x + bw / 2}" y="${y2 - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="${C.ink}">${num(totals[i])}</text>`;
    if (i % every === 0) g += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="${C.muted}">${esc(labels[i])}</text>`;
  }
  g += `<line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="${C.line}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

/** Horizontal bars with the label on the left and the value on the right. */
function hbars(items: Count[], opts: { width?: number; empty?: string } = {}): string {
  if (!items.length) return `<p class="empty">${esc(opts.empty ?? "Nothing to show yet.")}</p>`;
  const max = Math.max(1, ...items.map((x) => x.n));
  return `<div class="hbars">${items
    .map((x) => `<div class="hb"><div class="hb-label">${esc(clip(x.label, opts.width ?? 40))}</div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(3, Math.round((x.n / max) * 100))}%"></div></div><div class="hb-n">${num(x.n)}</div></div>`)
    .join("")}</div>`;
}

const card = (title: string, body: string, sub = "") => `<section class="card"><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${body}</section>`;

function table(head: string[], rows: string[][]): string {
  return `<table><thead><tr>${head.map((h, i) => `<th class="${i ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "r" : ""}">${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

// ---------- the document ----------

const CSS = `
@font-face{font-family:"Funnel Sans";font-weight:300 800;src:url(${dataUri("fonts/funnel-latin-ext.woff2", "font/woff2")}) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Funnel Sans";font-weight:300 800;src:url(${dataUri("fonts/funnel-latin.woff2", "font/woff2")}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:"Funnel Sans",-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:${C.ink};font-size:11.5px;line-height:1.5;background:#fff;letter-spacing:-0.005em}
.tab,.tile-value,.hb-n,td{font-variant-numeric:tabular-nums}
.head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid ${C.line};margin-bottom:16px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14.5px;letter-spacing:-0.02em}
.brand img{width:26px;height:26px;display:block}
.head-r{color:${C.muted};font-size:11px;text-align:right}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:16px}
h1{font-size:40px;line-height:1.02;letter-spacing:-0.035em;font-weight:700}
.range{display:inline-block;margin-top:12px;font-size:15px;font-weight:700;letter-spacing:-0.015em;background:linear-gradient(transparent 58%,${C.hl} 58%,${C.hl} 92%,transparent 92%);padding:0 3px}
.cmp{margin-top:8px;color:${C.muted};font-size:11px}
.hero img{width:92px;height:auto;display:block;margin-bottom:-4px}
.tiles{break-inside:avoid;display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.tile{background:${C.canvas};border-radius:18px;padding:13px 17px}
.tile-label{color:${C.ink2};font-size:11.5px}
.tile-value{font-size:31px;font-weight:700;letter-spacing:-0.035em;line-height:1.1;margin-top:3px}
.tile-foot{display:flex;align-items:center;gap:8px;margin-top:6px;min-height:20px}
.note{color:${C.muted};font-size:10.5px}
.chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 8px;font-size:10.5px;font-weight:700}
.chip-up{background:${C.accentSoft};color:${C.accentInk}}
.chip-down{background:${C.markSoft};color:${C.markDeep}}
.chip-same,.chip-new{background:rgba(11,12,16,0.06);color:${C.ink2}}
.card{background:#fff;border:1px solid ${C.line};border-radius:18px;padding:14px 18px;margin-bottom:12px;break-inside:avoid}
.card.tinted{background:${C.canvas};border-color:transparent}
h3{font-size:14px;font-weight:700;letter-spacing:-0.02em}
.sub{color:${C.muted};font-size:10.5px;margin-top:1px}
.card>*:not(h3):not(.sub){margin-top:12px}
.card h3+.sub+*,.card h3+*{margin-top:12px}
.watch{background:${C.hlSoft};border:1px solid #f2d36b;border-radius:18px;padding:15px 18px;margin-bottom:14px;color:${C.hlInk};break-inside:avoid}
.watch h3{color:${C.hlInk}}
.watch ul{margin-top:8px;padding-left:16px}.watch li{margin:3px 0;font-size:12px}
.hbars{display:grid;gap:7px}
.hb{display:grid;grid-template-columns:minmax(0,38%) 1fr 34px;align-items:center;gap:10px}
.hb-label{font-size:11px;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hb-track{height:9px;background:${C.canvas};border-radius:999px;overflow:hidden}
.hb-fill{height:100%;background:${C.accent};border-radius:999px}
.hb-n{text-align:right;font-size:11px;font-weight:700}
.empty{color:${C.muted};font-size:11px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid2 .card{margin-bottom:0}
table{width:100%;border-collapse:collapse;font-size:11.5px}
th{text-align:left;color:${C.muted};font-weight:400;font-size:10.5px;padding:0 0 7px;border-bottom:1px solid ${C.line}}
td{padding:7px 0;border-bottom:1px solid rgba(11,12,16,0.06)}
tr:last-child td{border-bottom:0}
.r{text-align:right}
.legend{display:flex;gap:14px;color:${C.ink2};font-size:10.5px;margin-top:6px}
.dot{display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:5px;vertical-align:-0.5px}
.kv{display:grid;gap:0}
.kv>div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(11,12,16,0.06)}
.kv>div:last-child{border-bottom:0}
.kv span:first-child{color:${C.ink2}}.kv span:last-child{font-weight:700}
.pb{break-after:page}
`;

function weekRows(d: ReportData): string[][] {
  const s = d.series;
  const rows: string[][] = [];
  for (let i = 0; i < s.labels.length; i += 7) {
    const sl = (a: number[]) => a.slice(i, i + 7).reduce((x, y) => x + y, 0);
    rows.push([`Days ${s.labels[i]} to ${s.labels[Math.min(i + 6, s.labels.length - 1)]}`, num(sl(s.views)), num(sl(s.leadsFull) + sl(s.leadsEmail)), num(sl(s.orders)), num(sl(s.paid))]);
  }
  return rows;
}

export function renderHtml(d: ReportData): string {
  const { cur: c, prev: p, comparable } = d;
  const periodWord = d.period === "day" ? "day" : d.period === "week" ? "week" : "month";
  const pose = c.paid > 0 ? "celebrating" : d.flags.length >= 2 ? "thinking" : "hello";
  const head = (n: string) => `<div class="head"><div class="brand"><img src="${dataUri("logo.svg", "image/svg+xml")}" alt="">UPSCPrepNotes</div><div class="head-r">${esc(d.title)} · ${esc(d.range.label)}${n ? ` · ${n}` : ""}</div></div>`;
  const big = true; // the same three-page layout for the daily, weekly and monthly reports
  const unit = d.period === "day" ? "Visitors by hour (IST)" : d.period === "week" ? "Visitors by day" : "Visitors by day of the month";

  const note = comparable ? "" : `Comparisons start once a full earlier ${periodWord} has been tracked (tracking began ${dayLabel(d.trackedFrom!)}).`;
  const answered = c.leadsFull;
  const leftTotal = Object.values(c.left).reduce((a, b) => a + b, 0);
  const reasonText: Record<string, string> = { expensive: "It felt too expensive", failed: "The payment did not work", unsure: "I am not sure yet" };
  const reasons: Count[] = Object.entries(c.left).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: reasonText[k] ?? k, n }));

  // ---- page 1: the summary
  const p1 = `
  ${head("")}
  <div class="hero">
    <div>
      <h1>${esc(d.title)}</h1>
      <div class="range">${esc(d.range.label)}</div>
      <div class="cmp">Compared with ${esc(d.previous.label)}${note ? ` · ${esc(note)}` : ""}</div>
    </div>
    <img src="${gilu(pose)}" alt="">
  </div>
  <div class="tiles">
    ${tile("Visitors", num(c.visitors), delta(c.visitors, p.visitors, comparable), `${num(c.views)} page views`)}
    ${tile("Visitors from India", num(c.india), delta(c.india, p.india, comparable), c.visitors ? `${Math.round((c.india / c.visitors) * 100)}% of all` : "")}
    ${tile("New leads", num(c.leads), delta(c.leads, p.leads), `${num(answered)} with full answers`)}
    ${tile("Revenue", rupees(c.revenue), delta(c.revenue, p.revenue), `${num(c.paid)} paid · ${num(c.ordersStarted)} started`)}
  </div>
  <section class="watch"><h3>Worth a look</h3>${d.flags.length ? `<ul>${d.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : `<p style="margin-top:6px;font-size:12px">Nothing unusual this ${periodWord}.</p>`}</section>
  ${card(unit, bars(d.series.visitors, d.series.labels, { height: 122, every: d.period === "day" ? 3 : undefined }), d.busiest ? `Busiest: ${d.busiest.day}, ${num(d.busiest.n)} visitors` : "")}
  `;

  // ---- traffic (follows the summary on the first page)
  const p2 = `
  <div class="grid2" style="margin-bottom:14px">
    ${card("Most visited pages", hbars(d.pages, { width: 34 }), "People who viewed each page")}
    ${card("Where they came from", hbars(d.sources, { width: 22 }), "Sessions by source")}
  </div>
  `;

  // ---- page 3: free requests
  const who = d.leads;
  const p3 = `
  ${big ? head("Free requests") : ""}
  <div class="tiles" style="grid-template-columns:repeat(4,1fr)">
    ${tile("New leads", num(c.leads), delta(c.leads, p.leads))}
    ${tile("With full answers", num(answered), "", answered && c.leads ? `${Math.round((answered / c.leads) * 100)}% of leads` : "")}
    ${tile("Answer copies", num(c.copyLeads), delta(c.copyLeads, p.copyLeads))}
    ${tile("Free materials", num(c.materialLeads), delta(c.materialLeads, p.materialLeads))}
  </div>
  ${card("Leads over time", bars(d.series.leadsFull, d.series.labels, { stack: d.series.leadsEmail, height: 150, every: d.period === "day" ? 3 : undefined }) + `<div class="legend"><span><i class="dot" style="background:${C.accent}"></i>With full answers</span><span><i class="dot" style="background:${C.accentLight}"></i>Email only</span></div>`)}
  <div class="grid2" style="margin-bottom:14px">
    ${card("Where are they in their preparation?", hbars(who.stage, { width: 24, empty: "No answered leads in this period." }))}
    ${card("Which attempt?", hbars(who.attempt, { width: 24, empty: "No answered leads in this period." }))}
  </div>
  <div class="grid2" style="margin-bottom:14px">
    ${card("Optional subject", hbars(who.optional, { width: 24, empty: "No answered leads in this period." }))}
    ${card("Where they are (from their connection)", hbars(who.region, { width: 24, empty: "No location recorded in this period." }))}
  </div>
  <div class="grid2">
    ${card("Most requested answer copies", hbars(who.topCopies, { width: 28, empty: "None in this period." }))}
    ${card("Most requested free materials", hbars(who.topMaterials, { width: 28, empty: "None in this period." }))}
  </div>
  ${d.period === "month" ? `<p class="note" style="margin-top:10px">All leads to date: ${num(d.leadsToDate)}</p>` : ""}
  `;

  // ---- page 4: sales and everything else
  const p4 = `
  ${big ? head("Sales and the rest") : ""}
  <div class="grid2" style="margin-bottom:14px">
    ${card("Sales", `<div class="kv">
      <div><span>Checkouts started</span><span>${num(c.ordersStarted)} ${delta(c.ordersStarted, p.ordersStarted)}</span></div>
      <div><span>Paid</span><span>${num(c.paid)} ${delta(c.paid, p.paid)}</span></div>
      <div><span>Revenue</span><span>${rupees(c.revenue)} ${delta(c.revenue, p.revenue)}</span></div>
      <div><span>Left unpaid</span><span>${num(Math.max(0, c.ordersStarted - c.paid))}</span></div>
      <div><span>Reminder emails sent</span><span>${num(c.reminders)}</span></div>
      <div><span>Payment window failures</span><span>${num(c.payFailures)}</span></div>
    </div>`)}
    ${card("Why people left checkout", hbars(reasons, { width: 26, empty: "Nobody has told us yet." }), leftTotal ? `${leftTotal} answered from the reminder email` : "From the one-tap answers in the reminder email")}
  </div>
  ${d.period === "month" ? card("By week", table(["Period", "Page views", "Leads", "Checkouts", "Paid"], weekRows(d))) : ""}
  <div class="grid2" style="margin-bottom:14px">
    ${card("Daily quiz", `<div class="kv"><div><span>Quizzes finished</span><span>${num(c.quizPlays)} ${delta(c.quizPlays, p.quizPlays, comparable)}</span></div><div><span>Different players</span><span>${num(c.quizPlayers)} ${delta(c.quizPlayers, p.quizPlayers, comparable)}</span></div></div>`)}
    ${card("Telegram channel", `<div class="kv">
      ${d.members ? `<div><span>Members</span><span>${num(d.members.now)}${d.members.change ? ` (${d.members.change > 0 ? "+" : ""}${d.members.change} since last report)` : ""}</span></div>` : ""}
      <div><span>Posts sent</span><span>${num(d.bot.sent)}</span></div>
      <div><span>Posts that failed</span><span>${num(d.bot.failed)}</span></div>
      ${d.bot.digest ? `<div><span>Current affairs digest</span><span>${esc(d.bot.digest)}</span></div>` : ""}
    </div>`)}
  </div>
  ${card("Site health", `<div class="kv"><div><span>JavaScript errors recorded</span><span>${num(c.jsErrors)}</span></div><div><span>Checkout errors recorded</span><span>${num(c.checkoutFailed)}</span></div></div>`)}
  `;

  const pages = `${p1}${p2}<div class="pb"></div>${p3}<div class="pb"></div>${p4}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)} ${esc(d.range.label)}</title><style>${CSS}</style></head><body>${pages}</body></html>`;
}
