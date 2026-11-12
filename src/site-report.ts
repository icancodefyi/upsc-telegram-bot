import mongoose from "mongoose";
import type { Db, Document } from "mongodb";
import { channelMemberCount } from "./telegram";
import { phEnabled, phQuery, hogTs, SITE_EVENT, PUBLIC_PAGE } from "./posthog";
import { gscEnabled, fetchSearch, searchTotals, type SearchData, type SearchTotals } from "./search-console";

/**
 * Collects the numbers for the reports from the site's own database (its tracker, leads, orders and
 * reminder emails) and from this bot's own records. Rendering is in render-report.ts.
 * Nothing here depends on any hosting provider.
 */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const OWN_HOSTS = /(^|\.)upscprepnotes\.in$/;

export type Range = { start: Date; end: Date; label: string };
export type Count = { label: string; n: number };
export type Bucket = "hour" | "day" | "week";
export type Kind = "day" | "week" | "month" | "today" | "custom" | "all";

/** What a report covers: the range, what to compare it with, and how to draw its charts. */
export type Spec = { kind: Kind; title: string; current: Range; previous: Range | null; bucket: Bucket };

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
const dayYear = (d: Date) => `${dayLabel(d)} ${ist(d).getUTCFullYear()}`;
const dayLong = (d: Date) => `${WEEKDAYS[ist(d).getUTCDay()]} ${dayYear(d)}`;
const bucketFor = (r: Range): Bucket => {
  const days = (r.end.getTime() - r.start.getTime()) / DAY_MS;
  return days <= 1.01 ? "hour" : days <= 62 ? "day" : "week";
};

/** The scheduled reports: the day, the 7 days or the calendar month that has just finished. */
export function scheduledSpec(kind: "day" | "week" | "month", now = new Date()): Spec {
  const today = ymdOf(now);
  const end = istMidnight(today);
  if (kind === "day") {
    const start = new Date(end.getTime() - DAY_MS);
    return { kind, title: "Daily report", bucket: "hour", current: { start, end, label: dayLong(start) }, previous: { start: new Date(start.getTime() - DAY_MS), end: start, label: "the day before" } };
  }
  if (kind === "week") {
    const start = new Date(end.getTime() - 7 * DAY_MS);
    const last = new Date(end.getTime() - DAY_MS);
    return { kind, title: "Weekly report", bucket: "day", current: { start, end, label: `${dayLabel(start)} to ${dayYear(last)}` }, previous: { start: new Date(start.getTime() - 7 * DAY_MS), end: start, label: "the 7 days before" } };
  }
  const [y, m] = today.split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const start = istMidnight(`${py}-${pad(pm)}-01`);
  const ppm = pm === 1 ? 12 : pm - 1;
  const ppy = pm === 1 ? py - 1 : py;
  return {
    kind, title: "Monthly report", bucket: "day",
    current: { start, end: istMidnight(`${y}-${pad(m)}-01`), label: `${MONTHS_LONG[pm - 1]} ${py}` },
    previous: { start: istMidnight(`${ppy}-${pad(ppm)}-01`), end: start, label: MONTHS_LONG[ppm - 1] },
  };
}

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(istMidnight(s).getTime());

/**
 * Reads a request such as "today", "yesterday", "week", "month", "thismonth", "all",
 * "2026-11-05" or "2026-11-01 2026-11-10" (both days included). Throws a readable message if it cannot.
 */
export async function commandSpec(args: string[], now = new Date()): Promise<Spec> {
  const a = args.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const what = a[0] ?? "week";
  const todayStart = istMidnight(ymdOf(now));

  if (what === "day" || what === "week" || what === "month") return scheduledSpec(what, now);
  if (what === "yesterday") return scheduledSpec("day", now);
  if (what === "today") {
    const elapsed = now.getTime() - todayStart.getTime();
    const yStart = new Date(todayStart.getTime() - DAY_MS);
    return {
      kind: "today", title: "Today so far", bucket: "hour",
      current: { start: todayStart, end: now, label: `${dayLong(todayStart)}, until now` },
      previous: { start: yStart, end: new Date(yStart.getTime() + elapsed), label: "yesterday at the same time" },
    };
  }
  if (what === "thismonth") {
    const [y, m] = ymdOf(now).split("-").map(Number);
    const start = istMidnight(`${y}-${pad(m)}-01`);
    return { kind: "custom", title: "Month so far", bucket: "day", current: { start, end: now, label: `${MONTHS_LONG[m - 1]} ${y}, until now` }, previous: null };
  }
  if (what === "all") {
    const db = await siteDb();
    const firsts = await Promise.all([
      db.collection("tracking").find({}, { projection: { ts: 1 } }).sort({ ts: 1 }).limit(1).toArray(),
      db.collection("freedownloadleads").find({}, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
      db.collection("freematerialleads").find({}, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
      db.collection("orders").find({}, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
    ]);
    const times = firsts.flat().map((x) => (x.ts ?? x.createdAt) as Date).filter(Boolean);
    const earliest = times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : todayStart;
    const start = istMidnight(ymdOf(earliest));
    return { kind: "all", title: "Overall report", bucket: "week", current: { start, end: now, label: `${dayYear(start)} to ${dayYear(now)}` }, previous: null };
  }
  if (isYmd(what)) {
    const start = istMidnight(what);
    const lastDay = a[1] && isYmd(a[1]) ? istMidnight(a[1]) : start;
    if (a[1] && !isYmd(a[1])) throw new Error(`I could not read "${a[1]}" as a date. Use YYYY-MM-DD, for example 2026-11-10.`);
    if (lastDay < start) throw new Error("The end date is before the start date.");
    let end = new Date(lastDay.getTime() + DAY_MS);
    if (end > now) end = now;
    if (start >= now) throw new Error("That start date is in the future.");
    const days = (end.getTime() - start.getTime()) / DAY_MS;
    if (days > 400) throw new Error("That range is longer than 400 days. Try a shorter one, or ask for: all");
    const sameDay = ymdOf(start) === ymdOf(new Date(end.getTime() - 1));
    const label = sameDay ? dayLong(start) : `${dayYear(start)} to ${dayYear(new Date(end.getTime() - 1))}`;
    const len = end.getTime() - start.getTime();
    return {
      kind: "custom", title: "Report", bucket: bucketFor({ start, end, label }), current: { start, end, label },
      previous: { start: new Date(start.getTime() - len), end: start, label: "the same length of time before" },
    };
  }
  throw new Error(`I did not understand "${what}".`);
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
  /** Page views PostHog identified as bots or crawlers and left out. */
  botViews: number;
  /** Different people (emails) who asked for something in the period. */
  leads: number;
  /** How many of them answered every question. */
  leadsFull: number;
  /** Different people who asked for an answer copy, and for a free material. */
  copyLeads: number;
  materialLeads: number;
  /** Every request record, so one person asking for three things counts three times. */
  requests: number;
  /** People who asked after the new question form went live, and how many of those answered. */
  formLeads: number;
  formFull: number;
  ordersStarted: number;
  paid: number;
  revenue: number;
  left: Record<string, number>;
  payFailures: number;
  reminders: number;
  jsErrors: number;
  checkoutFailed: number;
};

/** When the form with the preparation questions went live (11 Nov 2026, 9:49pm IST). Before this, nobody was asked. */
export const FORM_LIVE = new Date("2026-11-11T16:19:00Z");

const inRange = (field: string, r: Range) => ({ [field]: { $gte: r.start, $lt: r.end } });
const PAGE_EXCLUDE = { $not: { $regex: "^/(admin|api|get/|download/|unsubscribe|ask)" } };

async function uniq(db: Db, match: Document): Promise<number> {
  const r = await db.collection("tracking").aggregate([{ $match: match }, { $group: { _id: "$visitorId" } }, { $count: "n" }]).toArray();
  return (r[0]?.n as number) ?? 0;
}

type Traffic = { visitors: number; india: number; views: number; quizPlays: number; quizPlayers: number; jsErrors: number; checkoutFailed: number; botViews: number };
type Via = "posthog" | "tracker";
const win = (r: Range) => `timestamp >= ${hogTs(r.start)} AND timestamp < ${hogTs(r.end)}`;
const num0 = (v: unknown) => Number(v ?? 0) || 0;

async function trafficPosthog(r: Range): Promise<Traffic> {
  const w = win(r);
  const [a, q, e, bots] = await Promise.all([
    phQuery(`SELECT countDistinct(person_id), countDistinctIf(person_id, properties.$geoip_country_code = 'IN'), count() FROM events WHERE event = '$pageview' AND ${w} AND ${SITE_EVENT} AND ${PUBLIC_PAGE}`),
    phQuery(`SELECT count(), countDistinct(person_id) FROM events WHERE event = 'quiz_complete' AND ${w} AND ${SITE_EVENT}`),
    phQuery(`SELECT countIf(event = '$exception'), countIf(event = 'checkout_failed') FROM events WHERE event IN ('$exception', 'checkout_failed') AND ${w} AND ${SITE_EVENT}`),
    phQuery(`SELECT count() FROM events WHERE event = '$pageview' AND ${w} AND properties.$host IN ('upscprepnotes.in', 'www.upscprepnotes.in') AND properties.$virt_is_bot = true`),
  ]);
  return { visitors: num0(a[0]?.[0]), india: num0(a[0]?.[1]), views: num0(a[0]?.[2]), quizPlays: num0(q[0]?.[0]), quizPlayers: num0(q[0]?.[1]), jsErrors: num0(e[0]?.[0]), checkoutFailed: num0(e[0]?.[1]), botViews: num0(bots[0]?.[0]) };
}

async function trafficTracker(db: Db, r: Range): Promise<Traffic> {
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
  return { visitors, india, views, quizPlays, quizPlayers, jsErrors, checkoutFailed, botViews: 0 };
}

export async function statsFor(db: Db, r: Range, via: Via = "tracker"): Promise<Stats> {
  const traffic = via === "posthog" ? await trafficPosthog(r) : await trafficTracker(db, r);
  const { visitors, india, views, quizPlays, quizPlayers, jsErrors, checkoutFailed, botViews } = traffic;

  // People, not requests: one person asking for three copies is one lead.
  const peopleIn = async (coll: string, range: Range) =>
    db.collection(coll).aggregate([
      { $match: inRange("createdAt", range) },
      { $group: { _id: { $toLower: "$email" }, requests: { $sum: 1 }, full: { $max: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } },
    ]).toArray();
  const formRange: Range = { start: new Date(Math.max(r.start.getTime(), FORM_LIVE.getTime())), end: r.end, label: "" };
  const [copyPeople, materialPeople, formCopy, formMaterial] = await Promise.all([
    peopleIn("freedownloadleads", r),
    peopleIn("freematerialleads", r),
    formRange.start < r.end ? peopleIn("freedownloadleads", formRange) : Promise.resolve([]),
    formRange.start < r.end ? peopleIn("freematerialleads", formRange) : Promise.resolve([]),
  ]);
  const merge = (...lists: Document[][]) => {
    const m = new Map<string, number>();
    for (const l of lists) for (const x of l) m.set(String(x._id), Math.max(m.get(String(x._id)) ?? 0, x.full as number));
    return m;
  };
  const everyone = merge(copyPeople, materialPeople);
  const afterForm = merge(formCopy, formMaterial);
  const sumRequests = (l: Document[]) => l.reduce((a, x) => a + (x.requests as number), 0);

  const orders = db.collection("orders");
  const [started, paidAgg, leftAgg, failAgg, reminders] = await Promise.all([
    orders.countDocuments(inRange("createdAt", r)),
    orders.aggregate([{ $match: { status: { $in: ["paid", "delivered"] }, ...inRange("createdAt", r) } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: "$total" } } }]).toArray(),
    orders.aggregate([{ $match: { leftReason: { $exists: true }, ...inRange("createdAt", r) } }, { $group: { _id: "$leftReason", n: { $sum: 1 } } }]).toArray(),
    orders.aggregate([{ $unwind: "$payAttempts" }, { $match: { "payAttempts.kind": "failed", "payAttempts.at": { $gte: r.start, $lt: r.end } } }, { $count: "n" }]).toArray(),
    db.collection("recoveryemails").countDocuments(inRange("createdAt", r)),
  ]);

  return {
    visitors, india, views, quizPlays, quizPlayers, botViews,
    leads: everyone.size,
    leadsFull: [...everyone.values()].filter(Boolean).length,
    copyLeads: copyPeople.length,
    materialLeads: materialPeople.length,
    requests: sumRequests(copyPeople) + sumRequests(materialPeople),
    formLeads: afterForm.size,
    formFull: [...afterForm.values()].filter(Boolean).length,
    ordersStarted: started,
    paid: (paidAgg[0]?.n as number) ?? 0,
    revenue: (paidAgg[0]?.sum as number) ?? 0,
    left: Object.fromEntries(leftAgg.map((x) => [x._id as string, x.n as number])),
    payFailures: (failAgg[0]?.n as number) ?? 0,
    reminders, jsErrors, checkoutFailed,
  };
}

/** A quick snapshot of today so far, for the /status command. */
export async function quickStatus(now = new Date()): Promise<{ label: string; s: Stats }> {
  const db = await siteDb();
  const start = istMidnight(ymdOf(now));
  return { label: `${dayLong(start)}, until ${ist(now).toISOString().slice(11, 16)}`, s: await statsFor(db, { start, end: now, label: "" }, phEnabled() ? "posthog" : "tracker") };
}

const cleanPath = (p: string) => p.replace(/\/$/, "") || "/";
const hostOf = (ref: string): string => {
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

async function topPagesTracker(db: Db, r: Range, limit: number): Promise<Count[]> {
  const rows = await db.collection("tracking").aggregate([
    { $match: { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) } },
    { $addFields: { p: { $arrayElemAt: [{ $split: ["$path", "?"] }, 0] } } },
    { $group: { _id: { p: "$p", v: "$visitorId" } } },
    { $group: { _id: "$_id.p", n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: limit },
  ]).toArray();
  return rows.map((x) => ({ label: cleanPath(String(x._id)), n: x.n as number }));
}

async function topSourcesTracker(db: Db, r: Range, limit: number): Promise<Count[]> {
  const rows = await db.collection("tracking").find({ event: "session_start", ...inRange("ts", r) }, { projection: { referrer: 1, utm: 1 } }).limit(50000).toArray();
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

async function topPages(db: Db, r: Range, limit: number, via: Via): Promise<Count[]> {
  if (via === "tracker") return topPagesTracker(db, r, limit);
  const rows = await phQuery(`SELECT properties.$pathname AS p, countDistinct(person_id) AS n FROM events WHERE event = '$pageview' AND ${win(r)} AND ${SITE_EVENT} AND ${PUBLIC_PAGE} GROUP BY p ORDER BY n DESC LIMIT ${limit}`);
  return rows.map((x) => ({ label: cleanPath(String(x[0] ?? "/")), n: num0(x[1]) }));
}

/** Where sessions began: the campaign tag if there is one, otherwise the site that sent the visitor. */
async function topSources(db: Db, r: Range, limit: number, via: Via): Promise<Count[]> {
  if (via === "tracker") return topSourcesTracker(db, r, limit);
  const rows = await phQuery(
    `SELECT u, ref, count() AS n FROM (SELECT properties.$session_id AS sid, argMin(properties.utm_source, timestamp) AS u, argMin(properties.$referring_domain, timestamp) AS ref FROM events WHERE event = '$pageview' AND ${win(r)} AND ${SITE_EVENT} AND ${PUBLIC_PAGE} GROUP BY sid) GROUP BY u, ref ORDER BY n DESC LIMIT 200`,
  );
  const count: Record<string, number> = {};
  for (const x of rows) {
    const utm = String(x[0] ?? "").toLowerCase();
    const ref = String(x[1] ?? "").replace(/^www\./, "").toLowerCase();
    let src = utm || (ref && ref !== "$direct" ? ref : "");
    if (src && OWN_HOSTS.test(src)) continue;
    if (!src) src = "direct";
    count[src] = (count[src] || 0) + num0(x[2]);
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
    const rows = await db.collection(coll).aggregate([
      { $match: { ...inRange("createdAt", r), [field]: { $type: "string" } } },
      { $group: { _id: { f: `$${field}`, e: { $toLower: "$email" } } } }, // one person counts once per item
      { $group: { _id: "$_id.f", n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 5 },
    ]).toArray();
    return rows.map((x) => ({ label: String(x._id), n: x.n as number }));
  };
  const [stage, attempt, mode, optional, region, topCopies, topMaterials] = await Promise.all([
    tally("profile.stage", 5), tally("profile.attempt", 4), tally("profile.mode", 3), tally("profile.optional", 5), tally("region", 6),
    top("freedownloadleads", "topperName"), top("freematerialleads", "pdfTitle"),
  ]);
  return { stage, attempt, mode, optional, region, topCopies, topMaterials };
}

export type Series = { labels: string[]; visitors: number[]; views: number[]; leadsFull: number[]; leadsEmail: number[]; orders: number[]; paid: number[] };

/** Per-hour, per-day or per-week numbers for the charts. */
async function seriesFor(db: Db, bucket: Bucket, r: Range, via: Via): Promise<Series> {
  const keys: string[] = [];
  const labels: string[] = [];
  let keyOf: (f: string) => Document;
  if (bucket === "hour") {
    for (let h = 0; h < 24; h++) {
      keys.push(pad(h));
      labels.push(pad(h));
    }
    keyOf = (f) => ({ $dateToString: { format: "%H", date: f, timezone: "Asia/Kolkata" } });
  } else if (bucket === "day") {
    for (let t = r.start.getTime(); t < r.end.getTime(); t += DAY_MS) {
      const d = new Date(t);
      keys.push(ymdOf(d));
      labels.push(r.end.getTime() - r.start.getTime() <= 9 * DAY_MS ? `${WEEKDAYS[ist(d).getUTCDay()]} ${ist(d).getUTCDate()}` : String(ist(d).getUTCDate()));
    }
    keyOf = (f) => ({ $dateToString: { format: "%Y-%m-%d", date: f, timezone: "Asia/Kolkata" } });
  } else {
    const weeks = Math.ceil((r.end.getTime() - r.start.getTime()) / (7 * DAY_MS));
    for (let i = 0; i < weeks; i++) {
      keys.push(String(i));
      labels.push(dayLabel(new Date(r.start.getTime() + i * 7 * DAY_MS)));
    }
    keyOf = (f) => ({ $toString: { $floor: { $divide: [{ $subtract: [f, r.start] }, 7 * DAY_MS] } } });
  }
  const idx = new Map(keys.map((k, i) => [k, i]));
  const zero = () => keys.map(() => 0);
  const out: Series = { labels, visitors: zero(), views: zero(), leadsFull: zero(), leadsEmail: zero(), orders: zero(), paid: zero() };

  const trackView = { event: "page_view", path: PAGE_EXCLUDE, ...inRange("ts", r) };
  // Visitors and views per bucket: PostHog (real visits only) or, as a fallback, our own tracker.
  const traffic = async (): Promise<{ vis: Document[]; vw: Document[] }> => {
    if (via === "tracker") {
      const [vis, vw] = await Promise.all([
        db.collection("tracking").aggregate([{ $match: trackView }, { $group: { _id: { b: keyOf("$ts"), v: "$visitorId" } } }, { $group: { _id: "$_id.b", n: { $sum: 1 } } }]).toArray(),
        db.collection("tracking").aggregate([{ $match: trackView }, { $group: { _id: keyOf("$ts"), n: { $sum: 1 } } }]).toArray(),
      ]);
      return { vis, vw };
    }
    const expr =
      bucket === "hour" ? `formatDateTime(toTimeZone(timestamp, 'Asia/Kolkata'), '%H')`
      : bucket === "day" ? `formatDateTime(toTimeZone(timestamp, 'Asia/Kolkata'), '%Y-%m-%d')`
      : `toString(intDiv(dateDiff('second', ${hogTs(r.start)}, timestamp), 604800))`;
    const rows = await phQuery(`SELECT ${expr} AS b, countDistinct(person_id), count() FROM events WHERE event = '$pageview' AND ${win(r)} AND ${SITE_EVENT} AND ${PUBLIC_PAGE} GROUP BY b LIMIT 1000`);
    return { vis: rows.map((x) => ({ _id: String(x[0]), n: num0(x[1]) })), vw: rows.map((x) => ({ _id: String(x[0]), n: num0(x[2]) })) };
  };
  const [{ vis, vw }, copy, material, orders] = await Promise.all([
    traffic(),
    db.collection("freedownloadleads").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: keyOf("$createdAt"), n: { $sum: 1 }, full: { $sum: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } }]).toArray(),
    db.collection("freematerialleads").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: keyOf("$createdAt"), n: { $sum: 1 }, full: { $sum: { $cond: [{ $ifNull: ["$profile.stage", false] }, 1, 0] } } } }]).toArray(),
    db.collection("orders").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: keyOf("$createdAt"), n: { $sum: 1 }, paid: { $sum: { $cond: [{ $in: ["$status", ["paid", "delivered"]] }, 1, 0] } } } }]).toArray(),
  ]);
  for (const x of vis) if (idx.has(x._id)) out.visitors[idx.get(x._id)!] += x.n; // a visitor seen in two buckets counts in both
  for (const x of vw) if (idx.has(x._id)) out.views[idx.get(x._id)!] += x.n;
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

export type MonthRow = { month: string; leads: number; checkouts: number; paid: number; revenue: number };

/** Leads and sales, one row per calendar month, for ranges longer than a couple of months. */
async function monthlyRows(db: Db, r: Range): Promise<MonthRow[]> {
  const fmt = (f: string) => ({ $dateToString: { format: "%Y-%m", date: f, timezone: "Asia/Kolkata" } });
  // People per month (an email counts once in a month, across copies and materials).
  const peopleByMonth = async (coll: string) =>
    db.collection(coll).aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: { m: fmt("$createdAt"), e: { $toLower: "$email" } } } }]).toArray();
  const [copy, material, orders] = await Promise.all([
    peopleByMonth("freedownloadleads"),
    peopleByMonth("freematerialleads"),
    db.collection("orders").aggregate([{ $match: inRange("createdAt", r) }, { $group: { _id: fmt("$createdAt"), n: { $sum: 1 }, paid: { $sum: { $cond: [{ $in: ["$status", ["paid", "delivered"]] }, 1, 0] } }, revenue: { $sum: { $cond: [{ $in: ["$status", ["paid", "delivered"]] }, "$total", 0] } } } }]).toArray(),
  ]);
  const map = new Map<string, MonthRow>();
  const row = (k: string) => {
    if (!map.has(k)) map.set(k, { month: `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`, leads: 0, checkouts: 0, paid: 0, revenue: 0 });
    return map.get(k)!;
  };
  const seen = new Set<string>();
  for (const x of [...copy, ...material]) {
    const key = `${x._id.m}|${x._id.e}`;
    if (seen.has(key)) continue;
    seen.add(key);
    row(x._id.m).leads += 1;
  }
  for (const x of orders) {
    const m = row(x._id);
    m.checkouts += x.n;
    m.paid += x.paid;
    m.revenue += x.revenue;
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1]);
}

async function memberTrend(): Promise<{ now: number; change: number | null } | null> {
  const n = await channelMemberCount();
  if (n == null) return null;
  const col = mongoose.connection.db!.collection("snapshots");
  const prev = await col.find({ kind: "members" }).sort({ at: -1 }).limit(1).toArray();
  if (process.env.REPORT_PREVIEW !== "1") await col.insertOne({ kind: "members", n, at: new Date() });
  return { now: n, change: prev[0] ? n - (prev[0].n as number) : null };
}

async function botStats(r: Range, withDigest: boolean) {
  const col = mongoose.connection.db!.collection("tg_posts");
  const [sent, failed, digest] = await Promise.all([
    col.countDocuments({ status: "sent", sentAt: { $gte: r.start, $lt: r.end } }),
    col.countDocuments({ status: "failed", at: { $gte: r.start, $lt: r.end } }),
    withDigest ? col.findOne({ _id: `ca-${ymdOf(r.start)}` as never }) : Promise.resolve(null),
  ]);
  return { sent, failed, digest: digest ? `${digest.status}${digest.mode ? ` (${digest.mode})` : ""}` : null };
}

// ---------- the report ----------

const zeroStats = (): Stats => ({ visitors: 0, india: 0, views: 0, quizPlays: 0, quizPlayers: 0, botViews: 0, leads: 0, leadsFull: 0, copyLeads: 0, materialLeads: 0, requests: 0, formLeads: 0, formFull: 0, ordersStarted: 0, paid: 0, revenue: 0, left: {}, payFailures: 0, reminders: 0, jsErrors: 0, checkoutFailed: 0 });

export type ReportData = {
  kind: Kind;
  bucket: Bucket;
  title: string;
  range: Range;
  previous: Range | null;
  /** Where the visitor numbers come from. PostHog excludes bots and test traffic; the tracker is only a fallback. */
  via: Via;
  /** Known stretches when visitor data is missing, that overlap this report. */
  gaps: string[];
  search: { state: "off" } | { state: "error"; message: string } | { state: "ok"; data: SearchData; prev: SearchTotals | null };
  /** True when there is an earlier period to compare leads, sales and requests with. */
  hasPrevious: boolean;
  /** True when our tracker also covers the earlier period, so visitor comparisons are fair. */
  comparable: boolean;
  trackedFrom: Date | null;
  cur: Stats;
  prev: Stats;
  series: Series;
  pages: Count[];
  sources: Count[];
  leads: LeadBreakdown;
  leadsToDate: number;
  months: MonthRow[];
  busiest: { day: string; n: number } | null;
  members: { now: number; change: number | null } | null;
  bot: { sent: number; failed: number; digest: string | null };
  flags: string[];
  generatedAt: Date;
};

const REASON_TEXT: Record<string, string> = { expensive: "too expensive", failed: "payment did not work", unsure: "not sure yet" };

function flagsFor(spec: Spec, c: Stats, p: Stats, comparable: boolean): string[] {
  const out: string[] = [];
  const unit = spec.kind === "day" || spec.kind === "today" ? "day" : spec.kind === "week" ? "week" : "period";
  if (spec.previous && comparable && p.views > 0 && c.views < p.views * 0.75) out.push(`Page views are down ${Math.round((1 - c.views / p.views) * 100)}% on the ${unit} before.`);
  if (c.formLeads >= 10 && (c.formLeads - c.formFull) / c.formLeads > 0.4) out.push(`${c.formLeads - c.formFull} of ${c.formLeads} people who asked since the new form went live left without answering the questions.`);
  if (c.ordersStarted > 0 && c.paid === 0) out.push(`${c.ordersStarted} checkout${c.ordersStarted === 1 ? "" : "s"} started and none paid.`);
  if (c.payFailures > 0) out.push(`${c.payFailures} payment${c.payFailures === 1 ? "" : "s"} failed in the payment window.`);
  if (c.jsErrors > 20) out.push(`${c.jsErrors} JavaScript errors were recorded on the site.`);
  const topLeft = Object.entries(c.left).sort((a, b) => b[1] - a[1])[0];
  if (topLeft) out.push(`Most common reason for leaving checkout: ${REASON_TEXT[topLeft[0]] ?? topLeft[0]} (${topLeft[1]}).`);
  return out.slice(0, 4);
}

/** Stretches when PostHog recorded little or nothing, so reports can say why a number looks low. */
const DATA_GAPS = [
  { from: new Date("2026-11-03T00:00:00+05:30"), to: new Date("2026-11-06T00:00:00+05:30"), note: "PostHog recorded almost no visits from 3 to 5 Nov, when analytics was switched off for a few days. Visitor numbers for those days are too low." },
];
const overlaps = (r: Range, g: { from: Date; to: Date }) => r.start < g.to && r.end > g.from;

async function firstSeen(db: Db, via: Via): Promise<Date | null> {
  if (via === "posthog") {
    const rows = await phQuery(`SELECT toString(min(timestamp)) FROM events WHERE event = '$pageview' AND properties.$host IN ('upscprepnotes.in', 'www.upscprepnotes.in')`);
    const d = rows[0]?.[0] ? new Date(String(rows[0][0])) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  }
  const first = await db.collection("tracking").find({}, { projection: { ts: 1 } }).sort({ ts: 1 }).limit(1).toArray();
  return (first[0]?.ts as Date | undefined) ?? null;
}

/** Google search numbers for the range. Search Console runs about 2 days behind, so the end is pulled back. */
async function searchFor(spec: Spec, now: Date): Promise<ReportData["search"]> {
  if (!gscEnabled()) return { state: "off" };
  try {
    const latest = ymdOf(new Date(now.getTime() - 2 * DAY_MS));
    const earliest = ymdOf(new Date(now.getTime() - 480 * DAY_MS)); // Search Console keeps about 16 months
    const endFull = ymdOf(new Date(spec.current.end.getTime() - 1));
    const end = endFull < latest ? endFull : latest;
    const startFull = ymdOf(spec.current.start);
    const start = startFull > earliest ? startFull : earliest;
    if (start > end) return { state: "off" };
    const data = await fetchSearch(start, end);
    let prev: SearchTotals | null = null;
    if (spec.previous) {
      const pEnd = ymdOf(new Date(spec.previous.end.getTime() - 1));
      const pStart = ymdOf(spec.previous.start);
      if (pStart >= earliest && pEnd <= latest) prev = await searchTotals(pStart, pEnd);
    }
    return { state: "ok", data, prev };
  } catch (e) {
    return { state: "error", message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export async function collectReport(spec: Spec, now = new Date()): Promise<ReportData> {
  const db = await siteDb();
  const { current, previous } = spec;
  const gather = (via: Via) =>
    Promise.all([
      statsFor(db, current, via),
      previous ? statsFor(db, previous, via) : Promise.resolve(zeroStats()),
      seriesFor(db, spec.bucket, current, via),
      topPages(db, current, 5, via),
      topSources(db, current, 4, via),
      firstSeen(db, via),
    ]);

  // PostHog is the source for visitors (bots and test traffic excluded). If it cannot be reached, fall back to our own tracker and say so.
  let via: Via = phEnabled() ? "posthog" : "tracker";
  let traffic;
  try {
    traffic = await gather(via);
  } catch (e) {
    if (via === "tracker") throw e;
    console.error("PostHog failed, using our own tracker instead:", String(e).slice(0, 200));
    via = "tracker";
    traffic = await gather(via);
  }
  const [cur, prev, series, pages, sources, trackedFrom] = traffic;

  const [leads, members, bot, leadsToDate, months, search] = await Promise.all([
    leadBreakdown(db, current),
    memberTrend(),
    botStats(current, spec.kind === "day"),
    Promise.all([db.collection("freedownloadleads").distinct("email"), db.collection("freematerialleads").distinct("email")]).then((x) => new Set([...x[0], ...x[1]].map((e) => String(e).toLowerCase())).size),
    (current.end.getTime() - current.start.getTime()) / DAY_MS > 62 ? monthlyRows(db, current) : Promise.resolve([] as MonthRow[]),
    searchFor(spec, now),
  ]);

  const gaps = via === "posthog" ? DATA_GAPS.filter((g) => overlaps(current, g) || (previous && overlaps(previous, g))).map((g) => g.note) : [];
  const comparable = !!previous && (!trackedFrom || trackedFrom <= previous.start) && gaps.length === 0;
  const best = series.visitors.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
  const busiest = spec.bucket === "hour" ? null : { day: series.labels[best], n: series.visitors[best] };

  return {
    kind: spec.kind, bucket: spec.bucket, title: spec.title,
    range: current, previous, via, gaps, search, hasPrevious: !!previous, comparable, trackedFrom,
    cur, prev, series, pages, sources, leads, leadsToDate, months, busiest, members, bot,
    flags: flagsFor(spec, cur, prev, comparable),
    generatedAt: new Date(),
  };
}
