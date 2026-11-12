import mongoose from "mongoose";
import type { Db, Document } from "mongodb";
import { channelMemberCount } from "./telegram";

/**
 * Collects the numbers for the daily, weekly and monthly reports from the site's own database
 * (its tracker, leads, orders and reminder emails) and from this bot's own records.
 * Rendering is in render-report.ts. Nothing here depends on any hosting provider.
 */

const IST_OFFSET_MS = 330 * 60_000;
const OWN_HOSTS = /(^|\.)upscprepnotes\.in$/;

export type Period = "day" | "week" | "month";
export type Range = { start: Date; end: Date; label: string };
export type Count = { label: string; n: number };

// ---------- dates (all in India time) ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** Midnight IST of a "YYYY-MM-DD" day, as an instant. */
export const istMidnight = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
export const ymdOf = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ist = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS);
export const dayLabel = (d: Date) => `${ist(d).getUTCDate()} ${MONTHS[ist(d).getUTCMonth()]}`;
const dayLong = (d: Date) => `${WEEKDAYS[ist(d).getUTCDay()]} ${dayLabel(d)} ${ist(d).getUTCFullYear()}`;

/** The period that has just finished, and the one before it of the same length. */
export function rangesFor(period: Period, now = new Date()): { current: Range; previous: Range } {
  const today = ymdOf(now);
  const end = istMidnight(today);
  const dayMs = 86_400_000;
  if (period === "day") {
    const start = new Date(end.getTime() - dayMs);
    return {
      current: { start, end, label: dayLong(start) },
      previous: { start: new Date(start.getTime() - dayMs), end: start, label: "the day before" },
    };
  }
  if (period === "week") {
    const start = new Date(end.getTime() - 7 * dayMs);
    const last = new Date(end.getTime() - dayMs);
    return {
      current: { start, end, label: `${dayLabel(start)} to ${dayLabel(last)} ${ist(last).getUTCFullYear()}` },
      previous: { start: new Date(start.getTime() - 7 * dayMs), end: start, label: "the 7 days before" },
    };
  }
  const [y, m] = today.split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const start = istMidnight(`${py}-${pad(pm)}-01`);
  const ppm = pm === 1 ? 12 : pm - 1;
  const ppy = pm === 1 ? py - 1 : py;
  return {
    current: { start, end: istMidnight(`${y}-${pad(m)}-01`), label: `${MONTHS_LONG[pm - 1]} ${py}` },
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

// ---------- the numbers ----------

export type Stats = {
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

async function topPages(db: Db, r: Range, limit: number): Promise<Count[]> {
  const rows = await db.collection("tracking").aggregate([
    { $match: { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) } },
    { $addFields: { p: { $arrayElemAt: [{ $split: ["$path", "?"] }, 0] } } },
    { $group: { _id: { p: "$p", v: "$visitorId" } } },
    { $group: { _id: "$_id.p", n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: limit },
  ]).toArray();
  return rows.map((x) => ({ label: cleanPath(String(x._id)), n: x.n as number }));
}

async function topSources(db: Db, r: Range, limit: number): Promise<Count[]> {
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

export type LeadBreakdown = { stage: Count[]; attempt: Count[]; mode: Count[]; optional: Count[]; region: Count[]; topCopies: Count[]; topMaterials: Count[] };

async function leadBreakdown(db: Db, r: Range): Promise<LeadBreakdown> {
  const both = ["freedownloadleads", "freematerialleads"];
  const tally = async (field: string, limit: number): Promise<Count[]> => {
    const out: Record<string, number> = {};
    for (const c of both) {
      const rows = await db.collection(c).aggregate([{ $match: { ...inRange("createdAt", r), [field]: { $type: "string", $ne: "" } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]).toArray();
      for (const x of rows) out[String(x._id)] = (out[String(x._id)] || 0) + (x.n as number);
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, n]) => ({ label, n }));
  };
  const top = async (coll: string, field: string): Promise<Count[]> => {
    const rows = await db.collection(coll).aggregate([{ $match: { ...inRange("createdAt", r), [field]: { $type: "string" } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }]).toArray();
    return rows.map((x) => ({ label: String(x._id), n: x.n as number }));
  };
  const [stage, attempt, mode, optional, region, topCopies, topMaterials] = await Promise.all([
    tally("profile.stage", 5), tally("profile.attempt", 4), tally("profile.mode", 3), tally("profile.optional", 5), tally("region", 6),
    top("freedownloadleads", "topperName"), top("freematerialleads", "pdfTitle"),
  ]);
  return { stage, attempt, mode, optional, region, topCopies, topMaterials };
}

export type Series = { labels: string[]; visitors: number[]; views: number[]; leadsFull: number[]; leadsEmail: number[]; orders: number[]; paid: number[] };

/** Per-hour (one day) or per-day (week, month) numbers for the charts. */
async function seriesFor(db: Db, period: Period, r: Range): Promise<Series> {
  const hourly = period === "day";
  const fmt = hourly ? "%H" : "%Y-%m-%d";
  const keys: string[] = [];
  const labels: string[] = [];
  if (hourly) {
    for (let h = 0; h < 24; h++) {
      keys.push(pad(h));
      labels.push(pad(h));
    }
  } else {
    for (let t = r.start.getTime(); t < r.end.getTime(); t += 86_400_000) {
      const d = new Date(t);
      keys.push(ymdOf(d));
      labels.push(period === "week" ? `${WEEKDAYS[ist(d).getUTCDay()]} ${ist(d).getUTCDate()}` : String(ist(d).getUTCDate()));
    }
  }
  const idx = new Map(keys.map((k, i) => [k, i]));
  const zero = () => keys.map(() => 0);
  const out: Series = { labels, visitors: zero(), views: zero(), leadsFull: zero(), leadsEmail: zero(), orders: zero(), paid: zero() };
  const bucket = (f: string) => ({ $dateToString: { format: fmt, date: f, timezone: "Asia/Kolkata" } });

  const trackView = { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) };
  const [vis, vw, copy, material, orders] = await Promise.all([
    db.collection("tracking").aggregate([{ $match: trackView }, { $group: { _id: { b: bucket("$ts"), v: "$visitorId" } } }, { $group: { _id: "$_id.b", n: { $sum: 1 } } }]).toArray(),
    db.collection("tracking").aggregate([{ $match: trackView }, { $group: { _id: bucket("$ts"), n: { $sum: 1 } } }]).toArray(),
    db.collection("freedownloadleads").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: bucket("$createdAt"), n: { $sum: 1 }, full: { $sum: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } }]).toArray(),
    db.collection("freematerialleads").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: bucket("$createdAt"), n: { $sum: 1 }, full: { $sum: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } }]).toArray(),
    db.collection("orders").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: bucket("$createdAt"), n: { $sum: 1 }, paid: { $sum: { $cond: [{ $in: ["$status", ["paid", "delivered"]] }, 1, 0] } } } }]).toArray(),
  ]);
  for (const x of vis) if (idx.has(x._id)) out.visitors[idx.get(x._id)!] = x.n;
  for (const x of vw) if (idx.has(x._id)) out.views[idx.get(x._id)!] = x.n;
  for (const x of [...copy, ...material]) {
    const i = idx.get(x._id);
    if (i === undefined) continue;
    out.leadsFull[i] += x.full;
    out.leadsEmail[i] += x.n - x.full;
  }
  for (const x of orders) {
    const i = idx.get(x._id);
    if (i === undefined) continue;
    out.orders[i] += x.n;
    out.paid[i] += x.paid;
  }
  return out;
}

async function memberTrend(): Promise<{ now: number; change: number | null } | null> {
  const n = await channelMemberCount();
  if (n == null) return null;
  const col = mongoose.connection.db!.collection("snapshots");
  const prev = await col.find({ kind: "members" }).sort({ at: -1 }).limit(1).toArray();
  if (process.env.REPORT_PREVIEW !== "1") await col.insertOne({ kind: "members", n, at: new Date() });
  return { now: n, change: prev[0] ? n - (prev[0].n as number) : null };
}

async function botStats(r: Range, period: Period) {
  const col = mongoose.connection.db!.collection("tg_posts");
  const [sent, failed, digest] = await Promise.all([
    col.countDocuments({ status: "sent", sentAt: { $gte: r.start, $lt: r.end } }),
    col.countDocuments({ status: "failed", at: { $gte: r.start, $lt: r.end } }),
    period === "day" ? col.findOne({ _id: `ca-${ymdOf(r.start)}` as never }) : Promise.resolve(null),
  ]);
  return { sent, failed, digest: digest ? `${digest.status}${digest.mode ? ` (${digest.mode})` : ""}` : null };
}

// ---------- the report ----------

export type ReportData = {
  period: Period;
  title: string;
  range: Range;
  previous: Range;
  /** False while our tracker has no complete earlier period to compare with. */
  comparable: boolean;
  trackedFrom: Date | null;
  cur: Stats;
  prev: Stats;
  series: Series;
  pages: Count[];
  sources: Count[];
  leads: LeadBreakdown;
  leadsToDate: number;
  busiest: { day: string; n: number } | null;
  members: { now: number; change: number | null } | null;
  bot: { sent: number; failed: number; digest: string | null };
  flags: string[];
  generatedAt: Date;
};

const REASON_TEXT: Record<string, string> = { expensive: "too expensive", failed: "payment did not work", unsure: "not sure yet" };

function flagsFor(period: Period, c: Stats, p: Stats, comparable: boolean): string[] {
  const out: string[] = [];
  if (comparable && p.views > 0 && c.views < p.views * 0.75) out.push(`Page views are down ${Math.round((1 - c.views / p.views) * 100)}% on the ${period} before.`);
  if (c.leads >= 10 && (c.leads - c.leadsFull) / c.leads > 0.4) out.push(`${c.leads - c.leadsFull} of ${c.leads} new leads are email only, with no answers or WhatsApp number.`);
  if (c.ordersStarted > 0 && c.paid === 0) out.push(`${c.ordersStarted} checkout${c.ordersStarted === 1 ? "" : "s"} started and none paid.`);
  if (c.payFailures > 0) out.push(`${c.payFailures} payment${c.payFailures === 1 ? "" : "s"} failed in the payment window.`);
  if (c.jsErrors > 20) out.push(`${c.jsErrors} JavaScript errors were recorded on the site.`);
  const topLeft = Object.entries(c.left).sort((a, b) => b[1] - a[1])[0];
  if (topLeft) out.push(`Most common reason for leaving checkout: ${REASON_TEXT[topLeft[0]] ?? topLeft[0]} (${topLeft[1]}).`);
  return out.slice(0, 4);
}

export async function collectReport(period: Period, now = new Date()): Promise<ReportData> {
  const db = await siteDb();
  const { current, previous } = rangesFor(period, now);
  const first = await db.collection("tracking").find({}, { projection: { ts: 1 } }).sort({ ts: 1 }).limit(1).toArray();
  const trackedFrom = (first[0]?.ts as Date | undefined) ?? null;
  const comparable = !trackedFrom || trackedFrom <= previous.start;
  const big = period === "month";

  const [cur, prev, series, pages, sources, leads, members, bot, leadsToDate] = await Promise.all([
    statsFor(db, current),
    statsFor(db, previous),
    seriesFor(db, period, current),
    topPages(db, current, big ? 10 : 5),
    topSources(db, current, big ? 7 : 4),
    leadBreakdown(db, current),
    memberTrend(),
    botStats(current, period),
    Promise.all([db.collection("freedownloadleads").countDocuments({}), db.collection("freematerialleads").countDocuments({})]).then((x) => x[0] + x[1]),
  ]);
  const best = series.visitors.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
  const busiest = period === "day" ? null : { day: series.labels[best], n: series.visitors[best] };

  return {
    period,
    title: period === "day" ? "Daily report" : period === "week" ? "Weekly report" : "Monthly report",
    range: current, previous, comparable, trackedFrom,
    cur, prev, series, pages, sources, leads, leadsToDate, busiest, members, bot,
    flags: flagsFor(period, cur, prev, comparable),
    generatedAt: new Date(),
  };
}
