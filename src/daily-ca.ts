import Groq from "groq-sdk";
import { fetchCandidates, fetchText, type Candidate } from "./sources";

const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const MAX_NOTE_WORDS = 40;
const MAX_PIB = 2;

async function ask(prompt: string): Promise<unknown> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  let last: unknown;
  for (const model of MODELS) {
    try {
      const r = await groq.chat.completions.create({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] });
      return JSON.parse(r.choices[0].message.content ?? "{}");
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export type Item = { title: string; note: string; paper: string; url: string; source: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (s: string) => s.replace(/[—–]/g, ",").replace(/[‐‑‒―−]/g, "-").replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** Filler that says nothing: a note should state the fact and why it matters, not talk about exam prep. */
const FILLER = /\b(for upsc|upsc (exam|aspirant|preparation)|exam preparation|aspirants?|it is important to note|in a significant move|game[- ]changer)\b/i;
const PAPERS = ["GS1", "GS2", "GS3", "GS4", "Prelims"];

const ABBR = /\b(Dr|Mr|Mrs|Ms|Prof|Shri|Smt|St|No|vs|Rs|Lt|Gen|Col|Hon|Sr|Jr)\.$/;
/** Splits into sentences without breaking after abbreviations such as "Dr." or "Rs.". */
function sentences(s: string): string[] {
  const out: string[] = [];
  for (const part of clean(s).split(/(?<=[.!?])\s+(?=[A-Z"‘“])/)) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += " " + part;
    else out.push(part);
  }
  return out;
}
const digitsOf = (s: string) => (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));
/** Every number in a note must appear in the source text, so the model cannot invent a figure. */
function grounded(note: string, body: string): boolean {
  const src = body.replace(/,/g, "");
  return digitsOf(note).every((n) => src.includes(n));
}
/** At most two sentences. Returns null if it is still too long or contains filler, so the caller can retry. */
function acceptable(note: string, body: string): string | null {
  const parts = sentences(note);
  if (parts.length < 2) return null; // a note needs the fact and why it matters
  const out = parts.slice(0, 2).join(" ").trim();
  if (!out || words(out) > MAX_NOTE_WORDS + 8 || FILLER.test(out) || !grounded(out, body)) return null;
  return out;
}

async function writeNote(c: Candidate, body: string): Promise<Item | null> {
  const base = `Write a short UPSC current-affairs note using ONLY the source text below. Do not add any fact, number, name or date that is not in the text. If the text is too thin to say something solid, return {"skip":true}.
Rules: exactly two short sentences, at most ${MAX_NOTE_WORDS} words in total. Sentence one: what happened, with the one or two numbers or names that matter. Sentence two: why it matters for policy or governance. Do not list officials. Use GS3 for economy, environment, science and internal security, GS2 for polity, governance and international relations, GS1 for history, society and geography. GS4 only for ethics cases. Do not mention UPSC, exams, aspirants or preparation. Plain, human wording, no em-dashes.
Return JSON: {"title": up to 10 words, "note": "...", "paper": one of GS1, GS2, GS3, GS4, Prelims}.

Headline: ${c.title}
Source text: ${body}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = (await ask(attempt === 0 ? base : base + "\n\nYour last answer was too long or used filler. Make it shorter and plainer.")) as { skip?: boolean; title?: string; note?: string; paper?: string };
    if (r.skip || !r.title || !r.note) return null;
    const note = acceptable(r.note, body);
    if (note) return { title: clean(r.title), note, paper: PAPERS.includes(r.paper ?? "") ? r.paper! : "GS2", url: c.url, source: c.source };
  }
  return null;
}

/** Picks exam-relevant stories from a mix of sources, writes a grounded note for each, and returns the Telegram post. */
export async function buildDailyCA(date: Date, seen: Set<string> = new Set()): Promise<{ html: string; items: Item[] }> {
  const all = (await fetchCandidates()).filter((c) => !seen.has(c.url));
  if (all.length < 8) throw new Error(`only ${all.length} candidates fetched`);

  // Balance the pool so one source cannot crowd out the rest. Newest first within each source.
  const byNew = (a: Candidate, b: Candidate) => (b.published?.getTime() ?? Date.now()) - (a.published?.getTime() ?? Date.now());
  const pool = [
    ...all.filter((c) => c.source === "PIB").sort(byNew).slice(0, 12),
    ...all.filter((c) => c.source === "The Hindu").sort(byNew).slice(0, 36),
    ...all.filter((c) => c.source === "Indian Express").sort(byNew).slice(0, 8),
  ].map((c, i) => ({ ...c, id: i + 1 }));
  const list = pool.map((c) => `${c.id}. [${c.source}] ${c.title}${c.description ? " :: " + c.description.slice(0, 100) : ""}`).join("\n");

  const pick = (await ask(
    `You help a UPSC Civil Services aspirant. From the news list choose the 6 stories most useful for the exam: policy, governance, economy, environment, international relations, science and technology, polity. Prefer different topics. Skip crime, sport, entertainment, routine party politics and ceremonial events. Rank them best first.\nReturn JSON: {"ids":[n,n,n,n,n,n]}.\n\n${list}`,
  )) as { ids?: number[] };
  const ids = [...new Set(pick.ids ?? [])].slice(0, 6);

  // Write notes in ranked order; keep at most MAX_PIB press releases so the digest stays varied.
  const items: Item[] = [];
  let pib = 0;
  for (const id of ids) {
    if (items.length === 3) break;
    const c = pool.find((x) => x.id === id);
    if (!c || (c.source === "PIB" && pib >= MAX_PIB)) continue;
    const item = await writeNote(c, (await fetchText(c.url)) || c.description);
    if (!item) continue;
    if (c.source === "PIB") pib++;
    items.push(item);
  }
  if (items.length < 3) throw new Error(`only ${items.length} usable items`);

  const day = date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const html =
    `<b>Current affairs, ${day}</b>\n\n` +
    items.map((it, i) => `${i + 1}. <b>${esc(it.title)}</b> (${it.paper})\n${esc(it.note)}\n<a href="${esc(it.url)}">Read at ${it.source}</a>`).join("\n\n") +
    `\n\nMore: https://upscprepnotes.in/current-affairs?utm_source=telegram&utm_medium=channel&utm_campaign=daily_ca`;
  if (/[—–]/.test(html)) throw new Error("dash character in output");
  return { html, items };
}
