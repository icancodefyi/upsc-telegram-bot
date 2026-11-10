import type { Db } from "mongodb";

const B = "https://upscprepnotes.in";
const utm = (path: string) => `${B}${path}?utm_source=telegram&utm_medium=channel&utm_campaign=data_fact`;

type T = { firstName?: string; lastName?: string; rank?: number; year?: number; optionalSubject?: string; marks?: Record<string, number | undefined> };

const PAPERS: { key: string; name: string; max: number }[] = [
  { key: "essay", name: "the Essay paper", max: 250 },
  { key: "gs1", name: "GS Paper I", max: 250 },
  { key: "gs2", name: "GS Paper II", max: 250 },
  { key: "gs3", name: "GS Paper III", max: 250 },
  { key: "gs4", name: "GS Paper IV (Ethics)", max: 250 },
  { key: "interview", name: "the Personality Test", max: 275 },
];
const YEARS = [2022, 2023, 2024, 2025];

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const name = (t: T) => `${t.firstName ?? ""} ${t.lastName ?? ""}`.trim().replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase());
const subject = (s?: string) => (s && /political science/i.test(s) ? "PSIR" : s && /hindi/i.test(s) ? "Hindi Literature" : (s ?? "").trim());

/**
 * Facts computed from the toppers database, so there is always a new, accurate one to post.
 * Each is a template filled with numbers read from the data. Only marksheets with plausible values count.
 */
export async function buildFacts(site: Db): Promise<string[]> {
  const rows = (await site.collection("toppers").find({ year: { $in: YEARS } }, { projection: { firstName: 1, lastName: 1, rank: 1, year: 1, optionalSubject: 1, marks: 1 } }).toArray()) as unknown as T[];
  const facts: string[] = [];

  for (const year of YEARS) {
    for (const p of PAPERS) {
      const pool = rows.filter((t) => t.year === year && (t.rank ?? 999) <= 100 && (t.marks?.[p.key] ?? 0) > 0 && (t.marks?.[p.key] ?? 0) <= p.max);
      if (pool.length >= 20) {
        const med = median(pool.map((t) => t.marks![p.key]!));
        facts.push(`<b>What top rankers scored in ${p.name}</b>\n\nIn CSE ${year}, the median mark in ${p.name} among the top 100 ranks with a complete marksheet in our database (${pool.length} of 100) was ${med} out of ${p.max}.\n\nPaper by paper, every year: ${utm("/toppers/highest-marks-in-upsc")}`);
      }
      const all = rows.filter((t) => t.year === year && (t.marks?.[p.key] ?? 0) > 0 && (t.marks?.[p.key] ?? 0) <= p.max);
      if (all.length >= 30) {
        const best = all.reduce((a, b) => (b.marks![p.key]! > a.marks![p.key]! ? b : a));
        facts.push(`<b>Highest mark in ${p.name}, CSE ${year}</b>\n\n${name(best)} (AIR ${best.rank}) scored ${best.marks![p.key]} out of ${p.max}, the highest among ${all.length} marksheets from that year in our database.\n\nEvery paper's record, with names: ${utm("/toppers/highest-marks-in-upsc")}`);
      }
    }
  }

  const bySubject = new Map<string, number[]>();
  for (const t of rows) {
    const a = t.marks?.optional1 ?? 0, b = t.marks?.optional2 ?? 0;
    if (!t.optionalSubject || !(a >= 40 && a <= 250 && b >= 40 && b <= 250)) continue;
    const k = subject(t.optionalSubject);
    bySubject.set(k, [...(bySubject.get(k) ?? []), a + b]);
  }
  for (const [s, v] of bySubject) {
    if (v.length < 8) continue;
    facts.push(`<b>${s} as an optional</b>\n\n${v.length} toppers in our database (CSE 2022 to 2025) took ${s}. Their median optional marks, Paper I plus Paper II, were ${median(v)} out of 500.\n\nToppers only, so this is not a success rate. Full table and how to decide: ${utm("/content/choose-upsc-optional-subject-marks-data")}`);
  }
  return facts;
}
