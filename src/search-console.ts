/**
 * Google search performance from Search Console: clicks, impressions, click rate, average position,
 * and the queries and pages that bring people in. Needs a one-time sign-in (npm run google-auth) that
 * gives GOOGLE_REFRESH_TOKEN, plus GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GSC_SITE (for example
 * "sc-domain:upscprepnotes.in" or "https://upscprepnotes.in/"). Google's numbers run about 2 days behind
 * and its days follow US Pacific time.
 */

export type SearchRow = { label: string; clicks: number; impressions: number };
export type SearchData = {
  clicks: number;
  impressions: number;
  /** 0 to 1. */
  ctr: number;
  position: number;
  queries: SearchRow[];
  pages: SearchRow[];
  /** One entry per day with data. */
  series: { date: string; clicks: number; impressions: number }[];
  /** The last day included, as YYYY-MM-DD. */
  through: string;
};
export type SearchTotals = { clicks: number; impressions: number; ctr: number; position: number };

export const gscEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN && process.env.GSC_SITE);

let cached: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
  cached = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return cached.token;
}

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
async function query(body: Record<string, unknown>): Promise<Row[]> {
  const site = encodeURIComponent(process.env.GSC_SITE!);
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Search Console ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { rows?: Row[] }).rows ?? [];
}

const cleanPage = (u: string) => u.replace(/^https?:\/\/(www\.)?upscprepnotes\.in/, "").replace(/\/$/, "") || "/";

/** Totals for a range of days (both ends included), for comparing with the main period. */
export async function searchTotals(start: string, end: string): Promise<SearchTotals> {
  const r = (await query({ startDate: start, endDate: end, dataState: "final" }))[0];
  return { clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, ctr: r?.ctr ?? 0, position: r?.position ?? 0 };
}

export async function fetchSearch(start: string, end: string): Promise<SearchData> {
  const [totals, queries, pages, days] = await Promise.all([
    searchTotals(start, end),
    query({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: 8, dataState: "final" }),
    query({ startDate: start, endDate: end, dimensions: ["page"], rowLimit: 6, dataState: "final" }),
    query({ startDate: start, endDate: end, dimensions: ["date"], rowLimit: 600, dataState: "final" }),
  ]);
  return {
    ...totals,
    queries: queries.map((x) => ({ label: x.keys?.[0] ?? "", clicks: x.clicks, impressions: x.impressions })),
    pages: pages.map((x) => ({ label: cleanPage(x.keys?.[0] ?? ""), clicks: x.clicks, impressions: x.impressions })),
    series: days.map((x) => ({ date: x.keys?.[0] ?? "", clicks: x.clicks, impressions: x.impressions })).sort((a, b) => a.date.localeCompare(b.date)),
    through: end,
  };
}
