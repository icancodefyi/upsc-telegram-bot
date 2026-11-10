import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Collection } from "mongodb";
import { sendQuizPoll, sendToChannel } from "./telegram";

type Q = { id: string; qno: number; subject: string; text: string; options: string[]; answer: number; explain: string };

const bank: Q[] = JSON.parse(readFileSync(join(process.cwd(), "data", "quiz.json"), "utf8"));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A fixed shuffle (so subjects mix and a restart keeps the order), then the bank is walked in a loop. */
function order(): Q[] {
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...bank];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const ORDER = order();

/** Telegram allows 200 characters. Use the first sentences that fit, or none. */
function shortExplanation(s: string): string | undefined {
  const t = s.replace(/[—–]/g, ",").replace(/\s+/g, " ").trim();
  if (t.length <= 200) return t;
  let out = "";
  for (const part of t.split(/(?<=[.!?])\s+/)) {
    if ((out + " " + part).trim().length > 200) break;
    out = (out + " " + part).trim();
  }
  return out.length >= 40 ? out : undefined;
}

export async function postQuiz(state: Collection): Promise<string> {
  const cur = await state.findOneAndUpdate({ _id: "quiz-cursor" as never }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" });
  const n = ((cur?.n as number) ?? 1) - 1;
  const q = ORDER[n % ORDER.length];
  const header = `<b>Prelims question, UPSC 2024 (Q${q.qno}, ${q.subject})</b>`;
  let question = q.text;
  if (question.length > 300) {
    await sendToChannel(`${header}\n\n${esc(q.text)}`, { preview: false });
    question = "Pick the correct answer";
  }
  await sendQuizPoll(question, q.options, q.answer, shortExplanation(q.explain));
  return q.id;
}
