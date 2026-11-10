import Groq from "groq-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Hand = { id: string; text: string };
const hand: Hand[] = JSON.parse(readFileSync(join(process.cwd(), "content/pools/concepts-handwritten.json"), "utf8"));
const topics: { title: string }[] = JSON.parse(readFileSync(join(process.cwd(), "content/pools/concept-topics.json"), "utf8"));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (s: string) => s.replace(/[—–]/g, ",").replace(/[‐‑‒―−]/g, "-").replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const digits = (s: string) => (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));
const FILLER = /\b(for upsc|upsc (exam|aspirant)|exam preparation|aspirants?|game[- ]changer|it is important to note)\b/i;

async function wiki(title: string): Promise<{ extract: string; url: string; title: string } | null> {
  const res = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title.replace(/ /g, "_")), {
    headers: { "user-agent": "upsc-telegram-bot/1.0 (https://github.com/icancodefyi/upsc-telegram-bot)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { extract?: string; title?: string; content_urls?: { desktop?: { page?: string } }; type?: string };
  if (!j.extract || j.extract.length < 150 || j.type === "disambiguation") return null;
  return { extract: j.extract, url: j.content_urls?.desktop?.page ?? "", title: j.title ?? title };
}

async function write(topic: string, extract: string): Promise<{ what: string; why: string; remember: string } | null> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const prompt = `Write a short UPSC study note on "${topic}" using ONLY the source text below. Do not add any fact, number, name or date that is not in the text.
Return JSON: {"what": one or two sentences saying what it is, "why": one sentence on why it matters for governance, the economy, the environment or history (a general point, no new facts), "remember": one sentence with the single most useful fact from the text}.
Each field at most 40 words. Plain, human wording. No em-dashes. Do not mention UPSC, exams or aspirants.

Source text: ${extract.slice(0, 1800)}`;
  for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]) {
    try {
      const r = await groq.chat.completions.create({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] });
      const j = JSON.parse(r.choices[0].message.content ?? "{}") as { what?: string; why?: string; remember?: string };
      if (!j.what || !j.why || !j.remember) continue;
      const out = { what: clean(j.what), why: clean(j.why), remember: clean(j.remember) };
      const all = `${out.what} ${out.why} ${out.remember}`;
      const src = extract.replace(/,/g, "");
      if (Object.values(out).some((v) => words(v) > 48) || FILLER.test(all) || !digits(all).every((d) => src.includes(d))) continue;
      return out;
    } catch {
      /* try the next model */
    }
  }
  return null;
}

/**
 * The n-th concept post. The first ones are hand-written; after that each is written from a Wikipedia
 * summary of a listed topic. Returns null if the topic could not be turned into a clean note.
 */
export async function conceptPost(n: number): Promise<string | null> {
  if (n < hand.length) return hand[n].text;
  const t = topics[(n - hand.length) % topics.length];
  const w = await wiki(t.title);
  if (!w) return null;
  const note = await write(w.title, w.extract);
  if (!note) return null;
  return `<b>Concept in 60 seconds: ${esc(w.title)}</b>\n\n${esc(note.what)}\n\n<b>Why it matters.</b> ${esc(note.why)}\n\n<b>Remember.</b> ${esc(note.remember)}\n\n<a href="${esc(w.url)}">Source: Wikipedia</a>`;
}
