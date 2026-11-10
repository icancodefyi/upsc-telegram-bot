import Groq from "groq-sdk";
import { fetchCandidates, fetchText, type Candidate } from "./sources";

const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

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

type Item = { title: string; note: string; paper: string; url: string; source: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (s: string) => s.replace(/[\u2014\u2013]/g, ",").replace(/[\u2010\u2011\u2012\u2015\u2212]/g, "-").replace(/\s+/g, " ").trim();
/** At most two sentences and about 60 words, so the post stays quick to read. */
function tighten(s: string): string {
  const sentences = clean(s).split(/(?<=[.!?])\s+(?=[A-Z"\u2018\u201c])/);
  let out = sentences.slice(0, 2).join(" ").trim();
  if (out.split(" ").length > 60) out = sentences[0].trim();
  return out;
}

/** Picks the three most exam-relevant stories, writes a grounded note for each, and returns the Telegram post. */
export async function buildDailyCA(date: Date, seen: Set<string> = new Set()): Promise<{ html: string; items: Item[] }> {
  // Skip stories already posted on recent days.
  const cands = (await fetchCandidates()).filter((c) => !seen.has(c.url));
  if (cands.length < 8) throw new Error(`only ${cands.length} candidates fetched`);

  // Keep the prompt small: free-tier models cap tokens per minute. Newest first.
  const pool = [...cands].sort((a, b) => (b.published?.getTime() ?? Date.now()) - (a.published?.getTime() ?? Date.now())).slice(0, 60);
  const list = pool.map((c) => `${c.id}. [${c.source}] ${c.title}${c.description ? " :: " + c.description.slice(0, 100) : ""}`).join("\n");
  const pick = (await ask(
    `You help a UPSC Civil Services aspirant. From the news list below choose the 3 stories most useful for UPSC (policy, governance, economy, environment, international relations, science and technology, polity). Prefer different topics. Skip crime, sport, entertainment and routine politics.\nReturn JSON: {"ids":[n,n,n]}.\n\n${list}`,
  )) as { ids?: number[] };
  const ids = [...new Set(pick.ids ?? [])].slice(0, 3);
  if (ids.length < 3) throw new Error("selection returned fewer than 3 ids");

  const items: Item[] = [];
  for (const id of ids) {
    const c = pool.find((x) => x.id === id) as Candidate | undefined;
    if (!c) continue;
    const body = (await fetchText(c.url)) || c.description;
    const r = (await ask(
      `Write a short UPSC current-affairs note using ONLY the source text below. Do not add any fact, number, name or date that is not in the text. If the text is too thin to say something solid, return {"skip":true}.\nStyle: plain, human, no em-dashes, no hype, no "In a significant move".\nReturn JSON: {"title": up to 12 words, "note": 2 sentences of at most 45 words each (what happened, then why it matters for UPSC), "paper": one of "GS1","GS2","GS3","GS4","Prelims"}.\n\nHeadline: ${c.title}\nSource text: ${body}`,
    )) as { skip?: boolean; title?: string; note?: string; paper?: string };
    if (r.skip || !r.title || !r.note) continue;
    items.push({ title: clean(r.title), note: tighten(r.note), paper: r.paper ?? "GS2", url: c.url, source: c.source });
  }
  if (items.length < 3) throw new Error(`only ${items.length} usable items`);

  const day = date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const html =
    `<b>Current affairs, ${day}</b>\n\n` +
    items.map((it, i) => `${i + 1}. <b>${esc(it.title)}</b> (${it.paper})\n${esc(it.note)}\n<a href="${esc(it.url)}">Read at ${it.source}</a>`).join("\n\n") +
    `\n\nMore like this: https://upscprepnotes.in/current-affairs?utm_source=telegram&utm_medium=channel&utm_campaign=daily_ca`;
  if (/[—]/.test(html)) throw new Error("em-dash in output");
  return { html, items };
}
