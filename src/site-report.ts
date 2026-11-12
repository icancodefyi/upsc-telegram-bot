import mongoose from "mongoose";
import type { Db, Document } from "mongodb";
import { channelMemberCount } from "./telegram";

/**
 * Weekly and monthly reports on the whole website, read straight from the site's own database
 * (its tracker, leads, orders and reminder emails) and sent to the owner on Telegram.
 * Nothing here depends on any hosting provider.
 */

const IST_OFFSET_MS = 330 * 60_000;
const OWN_HOSTS = /(^|\.)upscprepnotes\.in$/;

export type Period = "week" | "month";
export type Range = { start: Date; end: Date; label: string };

// ---------- dates (all in India time) ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** Midnight IST of a "YYYY-MM-DD" day, as an instant. */
const istMidnight = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const ymdOf = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (d: Date) => {
  const x = new Date(d.getTime() + IST_OFFSET_MS);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
};

/** The period that has just finished, and the one before it of the same length. */
export function rangesFor(period: Period, now = new Date()): { current: Range; previous: Range } {
  const today = ymdOf(now);
  if (period === "week") {
    const end = istMidnight(today);
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const pStart = new Date(start.getTime() - 7 * 86_400_000);
    const last = new Date(end.getTime() - 86_400_000);
    return {
      current: { start, end, label: `${dayLabel(start)} to ${dayLabel(last)} ${new Date(last.getTime() + IST_OFFSET_MS).getUTCFullYear()}` },
      previous: { start: pStart, end: start, label: "the 7 days before" },
    };
  }
  const [y, m] = today.split("-").map(Number);
  const thisMonth = istMidnight(`${y}-${pad(m)}-01`);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const start = istMidnight(`${py}-${pad(pm)}-01`);
  const ppm = pm === 1 ? 12 : pm - 1;
  const ppy = pm === 1 ? py - 1 : py;
  return {
    current: { start, end: thisMonth, label: `${MONTHS_LONG[pm - 1]} ${py}` },
    previous: { start: istMidnight(`${ppy}-${pad(ppm)}-01`), end: start, label: MONTHS_LONG[ppm - 1] },
  };
}

// ---------- the site's database ----------

let siteConn: mongoose.Connection | null = null;
async function siteDb(): Promise<Db> {
  const name = process.env.SITE_DB_NAME;
  if (!name) throw new Error("SITE_DB_NAME is not set");
  if (!siteConn) siteConn = await mongoose.createConnection(process.env.MONGODB_URI!, { dbName: name }).asPromise();
  return siteConn.db!;
}

// ---------- numbers ----------

type Stats = {
  visitors: number;
  india: number;
  views: number;
  quizPlays: number;
  quizPlayers: number;
  leads: number;
  leadsFull: number;
  copyLeads: number;
  materialLeads: number;
  ordersStarted: number;
  paid: number;
  revenue: number;
  left: Record<string, number>;
  payFailures: number;
  reminders: number;
  jsErrors: number;
  checkoutFailed: number;
};

const inRange = (field: string, r: Range) => ({ [field]: { $gte: r.start, $lt: r.end } });
const PAGE_EXCLUDE = { $not: { $regex: "^/(admin|api|get/|download/|unsubscribe|ask)" } };

async function uniq(db: Db, match: Document): Promise<number> {
  const r = await db.collection("tracking").aggregate([{ $match: match }, { $group: { _id: "$visitorId" } }, { $count: "n" }]).toArray();
  return (r[0]?.n as number) ?? 0;
}

async function statsFor(db: Db, r: Range): Promise<Stats> {
  const t = db.collection("tracking");
  const view = { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) };
  const [visitors, india, views, quizPlays, quizPlayers, jsErrors, checkoutFailed] = await Promise.all([
    uniq(db, view),
    uniq(db, { ...view, country: "IN" }),
    t.countDocuments(view),
    t.countDocuments({ event: "quiz_complete", ...inRange("ts", r) }),
    uniq(db, { event: "quiz_complete", ...inRange("ts", r) }),
    t.countDocuments({ event: "js_error", ...inRange("ts", r) }),
    t.countDocuments({ event: "checkout_failed", ...inRange("ts", r) }),
  ]);

  const leadAgg = async (coll: string) => {
    const x = await db.collection(coll).aggregate([
      { $match: inRange("createdAt", r) },
      { $group: { _id: null, n: { $sum: 1 }, full: { $sum: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } },
    ]).toArray();
    return { n: (x[0]?.n as number) ?? 0, full: (x[0]?.full as number) ?? 0 };
  };
  const [copy, material] = await Promise.all([leadAgg("freedownloadleads"), leadAgg("freematerialleads")]);

  const orders = db.collection("orders");
  const [started, paidAgg, leftAgg, failAgg, reminders] = await Promise.all([
    orders.countDocuments(inRange("createdAt", r)),
    orders.aggregate([{ $match: { status: { $in: ["paid", "delivered"] }, ...inRange("createdAt", r) } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: "$total" } } }]).toArray(),
    orders.aggregate([{ $match: { leftReason: { $exists: true }, ...inRange("createdAt", r) } }, { $group: { _id: "$leftReason", n: { $sum: 1 } } }]).toArray(),
    orders.aggregate([{ $unwind: "$payAttempts" }, { $match: { "payAttempts.kind": "failed", "payAttempts.at": { $gte: r.start, $lt: r.end } } }, { $count: "n" }]).toArray(),
    db.collection("recoveryemails").countDocuments(inRange("createdAt", r)),
  ]);

  return {
    visitors, india, views, quizPlays, quizPlayers,
    leads: copy.n + material.n,
    leadsFull: copy.full + material.full,
    copyLeads: copy.n,
    materialLeads: material.n,
    ordersStarted: started,
    paid: (paidAgg[0]?.n as number) ?? 0,
    revenue: (paidAgg[0]?.sum as number) ?? 0,
    left: Object.fromEntries(leftAgg.map((x) => [x._id as string, x.n as number])),
    payFailures: (failAgg[0]?.n as number) ?? 0,
    reminders, jsErrors, checkoutFailed,
  };
}

const cleanPath = (p: string) => p.replace(/\/$/, "") || "/";
const hostOf = (ref: string): string => {
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

async function topPages(db: Db, r: Range, limit: number) {
  const rows = await db.collection("tracking").aggregate([
    { $match: { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) } },
    { $addFields: { p: { $arrayElemAt: [{ $split: ["$path", "?"] }, 0] } } },
    { $group: { _id: { p: "$p", v: "$visitorId" } } },
    { $group: { _id: "$_id.p", n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: limit },
  ]).toArray();
  return rows.map((x) => ({ label: cleanPath(String(x._id)), n: x.n as number }));
}

async function topSources(db: Db, r: Range, limit: number) {
  const rows = await db.collection("tracking").find({ event: "session_start", ...inRange("ts", r) }, { projection: { referrer: 1, utm: 1 } }).limit(20000).toArray();
  const count: Record<string, number> = {};
  for (const x of rows) {
    const utm = (x.utm as Record<string, string> | undefined)?.source;
    let src = utm ? utm.toLowerCase() : hostOf(String(x.referrer ?? ""));
    if (src && OWN_HOSTS.test(src)) continue;
    if (!src) src = "direct";
    count[src] = (count[src] || 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, n]) => ({ label, n }));
}

async function leadBreakdown(db: Db, r: Range) {
  const both = ["freedownloadleads", "freematerialleads"];
  const tally = async (field: string, limit: number) => {
    const out: Record<string, number> = {};
    for (const c of both) {
      const rows = await db.collection(c).aggregate([{ $match: { ...inRange("createdAt", r), [field]: { $type: "string", $ne: "" } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]).toArray();
      for (const x of rows) out[String(x._id)] = (out[String(x._id)] || 0) + (x.n as number);
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, n]) => ({ label, n }));
  };
  const [stage, optional, region] = await Promise.all([tally("profile.stage", 4), tally("profile.optional", 3), tally("region", 4)]);
  const topCopies = await db.collection("freedownloadleads").aggregate([{ $match: { ...inRange("createdAt", r), topperName: { $type: "string" } } }, { $group: { _id: "$topperName", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }]).toArray();
  const topMaterials = await db.collection("freematerialleads").aggregate([{ $match: { ...inRange("createdAt", r), pdfTitle: { $type: "string" } } }, { $group: { _id: "$pdfTitle", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }]).toArray();
  return {
    stage, optional, region,
    topCopies: topCopies.map((x) => ({ label: String(x._id), n: x.n as number })),
    topMaterials: topMaterials.map((x) => ({ label: String(x._id), n: x.n as number })),
  };
}

async function busiestDay(db: Db, r: Range) {
  const rows = await db.collection("tracking").aggregate([
    { $match: { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) } },
    { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$ts", timezone: "Asia/Kolkata" } }, v: "$visitorId" } } },
    { $group: { _id: "$_id.d", n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 1 },
  ]).toArray();
  return rows[0] ? { day: String(rows[0]._id), n: rows[0].n as number } : null;
}

async function memberTrend(): Promise<{ now: number; change: number | null } | null> {
  const n = await channelMemberCount();
  if (n == null) return null;
  const col = mongoose.connection.db!.collection("snapshots");
  const prev = await col.find({ kind: "members" }).sort({ at: -1 }).limit(1).toArray();
  if (process.env.REPORT_PREVIEW !== "1") await col.insertOne({ kind: "members", n, at: new Date() });
  return { now: n, change: prev[0] ? n - (prev[0].n as number) : null };
}

// ---------- formatting ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n: number) => n.toLocaleString("en-IN");
const rupees = (n: number) => `Rs ${num(n)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function delta(cur: number, prev: number): string {
  if (cur === 0 && prev === 0) return "";
  if (prev === 0) return "new";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return "same";
  return `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
}

const W = 17; // label column
const row = (label: string, value: string, d = "") => `${label.padEnd(W)}${value.padStart(8)}${d ? "  " + d : ""}`;
const block = (title: string, lines: string[]) => `<b>${esc(title)}</b>\n<pre>${esc(lines.join("\n"))}</pre>`;
const ranked = (items: { label: string; n: number }[], width = 28) => items.map((x, i) => `${i + 1}. ${clip(x.label, width).padEnd(width)}${String(x.n).padStart(5)}`);

function flags(period: Period, c: Stats, p: Stats, comparable: boolean): string[] {
  const out: string[] = [];
  if (comparable && p.views > 0 && c.views < p.views * 0.75) out.push(`Page views are down ${Math.round((1 - c.views / p.views) * 100)}% on the ${period === "week" ? "week" : "month"} before.`);
  if (c.leads >= 10 && (c.leads - c.leadsFull) / c.leads > 0.4) out.push(`${c.leads - c.leadsFull} of ${c.leads} new leads are email only, with no answers or WhatsApp number.`);
  if (c.ordersStarted > 0 && c.paid === 0) out.push(`${c.ordersStarted} checkouts started and none paid.`);
  if (c.payFailures > 0) out.push(`${c.payFailures} payment${c.payFailures === 1 ? "" : "s"} failed in the payment window.`);
  if (c.jsErrors > 20) out.push(`${c.jsErrors} JavaScript errors were recorded on the site.`);
  const topLeft = Object.entries(c.left).sort((a, b) => b[1] - a[1])[0];
  if (topLeft) out.push(`Most common reason for leaving checkout: ${({ expensive: "too expensive", failed: "payment did not work", unsure: "not sure yet" } as Record<string, string>)[topLeft[0]] ?? topLeft[0]} (${topLeft[1]}).`);
  return out.slice(0, 4);
}

/** Builds the report as one or more Telegram HTML messages (each under the 4096 character limit). */
export async function buildReport(period: Period, now = new Date()): Promise<string[]> {
  const db = await siteDb();
  const { current, previous } = rangesFor(period, now);
  const [c, p, pages, sources, leads, trend, busy, allLeads] = await Promise.all([
    statsFor(db, current),
    statsFor(db, previous),
    topPages(db, current, period === "week" ? 6 : 10),
    topSources(db, current, period === "week" ? 4 : 6),
    leadBreakdown(db, current),
    memberTrend(),
    period === "month" ? busiestDay(db, current) : Promise.resolve(null),
    period === "month"
      ? Promise.all([db.collection("freedownloadleads").countDocuments({}), db.collection("freematerialleads").countDocuments({})]).then((x) => x[0] + x[1])
      : Promise.resolve(0),
  ]);

  // Our tracker has a start date. Until a whole earlier period exists, traffic comparisons would mislead.
  const first = await db.collection("tracking").find({}, { projection: { ts: 1 } }).sort({ ts: 1 }).limit(1).toArray();
  const trackedFrom = first[0]?.ts as Date | undefined;
  const comparable = !trackedFrom || trackedFrom <= previous.start;
  const dT = (a: number, b: number) => (comparable ? delta(a, b) : "");

  const header =
    `<b>${period === "week" ? "Weekly" : "Monthly"} report</b>\n${esc(current.label)}\n<i>Compared with ${esc(previous.label)}</i>` +
    (comparable ? "" : `\n<i>Visitor and quiz comparisons start once there is a full ${period} of tracking before this one (tracking began ${esc(dayLabel(trackedFrom!))}).</i>`);

  const traffic = block("Traffic", [
    row("Visitors", num(c.visitors), dT(c.visitors, p.visitors)),
    row("From India", num(c.india), dT(c.india, p.india)),
    row("Page views", num(c.views), dT(c.views, p.views)),
    ...(busy ? [row("Busiest day", dayLabel(istMidnight(busy.day)), `${num(busy.n)} visitors`)] : []),
  ]);
  const where = sources.length ? block("Where they came from", ranked(sources, 24)) : "";
  const top = pages.length ? block("Most visited pages (visitors)", ranked(pages, 31)) : "";

  const answered = c.leadsFull;
  const requests = block("Free requests", [
    row("New leads", num(c.leads), delta(c.leads, p.leads)),
    row("  with answers", num(answered)),
    row("  email only", num(c.leads - answered)),
    row("Answer copies", num(c.copyLeads), delta(c.copyLeads, p.copyLeads)),
    row("Free materials", num(c.materialLeads), delta(c.materialLeads, p.materialLeads)),
    ...(period === "month" ? [row("Leads to date", num(allLeads))] : []),
  ]);
  const who: string[] = [];
  if (leads.stage.length) who.push("Stage:  " + leads.stage.map((x) => `${x.label} ${x.n}`).join(", "));
  if (leads.optional.length) who.push("Optional: " + leads.optional.map((x) => `${x.label} ${x.n}`).join(", "));
  if (leads.region.length) who.push("Places: " + leads.region.map((x) => `${x.label} ${x.n}`).join(", "));
  const whoBlock = who.length ? `<b>Who is asking</b>\n<pre>${esc(who.join("\n"))}</pre>` : "";
  const asked = [
    ...(leads.topCopies.length ? ["Copies:", ...ranked(leads.topCopies, 28)] : []),
    ...(leads.topMaterials.length ? ["Materials:", ...ranked(leads.topMaterials, 28)] : []),
  ];
  const askedBlock = asked.length ? block("Most requested", asked) : "";

  const leftTotal = Object.values(c.left).reduce((a, b) => a + b, 0);
  const sales = block("Sales", [
    row("Checkouts started", num(c.ordersStarted), delta(c.ordersStarted, p.ordersStarted)),
    row("Paid", num(c.paid), delta(c.paid, p.paid)),
    row("Revenue", rupees(c.revenue), delta(c.revenue, p.revenue)),
    row("Left unpaid", num(Math.max(0, c.ordersStarted - c.paid))),
    row("Reminders sent", num(c.reminders)),
    ...(leftTotal ? [row("Told us why", num(leftTotal))] : []),
    ...(c.payFailures ? [row("Payment failures", num(c.payFailures))] : []),
  ]);

  const quiz = block("Daily quiz", [
    row("Quizzes finished", num(c.quizPlays), dT(c.quizPlays, p.quizPlays)),
    row("Different players", num(c.quizPlayers), dT(c.quizPlayers, p.quizPlayers)),
  ]);

  const tg = trend
    ? block("Telegram channel", [row("Members", num(trend.now), trend.change == null ? "" : trend.change === 0 ? "same" : `${trend.change > 0 ? "▲" : "▼"} ${Math.abs(trend.change)} since last report`)])
    : "";

  const watch = flags(period, c, p, comparable);
  const watchBlock = `<b>Worth a look</b>\n${watch.length ? watch.map((x) => "• " + esc(x)).join("\n") : "Nothing unusual."}`;
  const footer = `<a href="https://upscprepnotes.in/admin/funnel">Open the request-form report</a>`;

  // Pack the sections into as few messages as fit.
  const sections = [traffic, where, top, requests, whoBlock, askedBlock, sales, quiz, tg, watchBlock, footer].filter(Boolean);
  const messages: string[] = [];
  let cur = header;
  for (const s of sections) {
    if ((cur + "\n\n" + s).length > 3800) {
      messages.push(cur);
      cur = s;
    } else cur += "\n\n" + s;
  }
  messages.push(cur);
  return messages;
}
