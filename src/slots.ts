import { readFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";
import { sendToChannel } from "./telegram";
import { claim, markFailed } from "./claim";
import { conceptPost } from "./concepts";
import { buildFacts } from "./facts";

type Pool = { title: string; body: string; link?: string }[];
const load = (f: string): Pool => JSON.parse(readFileSync(join(process.cwd(), "content/pools", f), "utf8"));
const tips = load("tips.json");
const promos = load("promos.json");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fill = (s: string, campaign: string) => s.replace(/\{\{([^}]+)\}\}/g, (_, p) => `https://upscprepnotes.in${p}?utm_source=telegram&utm_medium=channel&utm_campaign=${campaign}`);

/** "12:30" plus two hours is "14:30". A slot stays open that long, so a restart still catches it. */
const addHours = (hm: string, h: number) => `${String(Math.min(23, Number(hm.slice(0, 2)) + h)).padStart(2, "0")}:${hm.slice(3)}`;

/** Each daily slot takes the next item of its pool, forever. The cursor lives in MongoDB. */
async function next(name: string): Promise<number> {
  const r = await mongoose.connection.db!.collection("cursors").findOneAndUpdate({ _id: name as never }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" });
  return ((r?.n as number) ?? 1) - 1;
}

type Slot = { id: string; time: string; build: () => Promise<{ html: string; preview?: boolean } | null> };

const SLOTS: Slot[] = [
  {
    id: "tip",
    time: "12:30",
    build: async () => {
      const t = tips[(await next("tip")) % tips.length];
      return { html: `<b>${esc(t.title)}</b>\n\n${esc(t.body)}${t.link ? `\n\n${fill(t.link, "tip")}` : ""}` };
    },
  },
  {
    id: "concept",
    time: "15:00",
    build: async () => {
      for (let i = 0; i < 4; i++) {
        const html = await conceptPost(await next("concept")).catch(() => null);
        if (html) return { html, preview: false };
      }
      return null;
    },
  },
  {
    id: "promo",
    time: "17:30",
    build: async () => {
      const p = promos[(await next("promo")) % promos.length];
      return { html: `<b>${esc(p.title)}</b>\n\n${esc(p.body)}\n\n${fill(`{{${p.link}}}`, "promo")}` };
    },
  },
  {
    id: "fact",
    time: "20:30",
    build: async () => {
      const facts = await buildFacts(mongoose.connection.useDb(process.env.SITE_DB || "upscprepnotes", { useCache: true }).db!);
      if (!facts.length) return null;
      return { html: facts[(await next("fact")) % facts.length] };
    },
  },
];

/** A tip from the pool, used when a slot's own content cannot be built. It cannot fail: it is a local file. */
async function fallbackTip(): Promise<{ html: string }> {
  const t = tips[(await next("tipextra")) % tips.length];
  return { html: `<b>${esc(t.title)}</b>\n\n${esc(t.body)}${t.link ? `\n\n${fill(t.link, "tip")}` : ""}` };
}

/** The 7 AM post when the digest could not be built at all. */
export async function emergencyMorning(): Promise<string> {
  return (await fallbackTip()).html;
}

export async function runSlots(date: string, hm: string, now: Date, log: (...a: unknown[]) => void): Promise<void> {
  const col = mongoose.connection.db!.collection("tg_posts");
  for (const s of SLOTS) {
    if (hm < s.time || hm >= addHours(s.time, 2)) continue;
    const id = `${s.id}-${date}`;
    if (!(await claim(col, id, now))) continue;
    try {
      // If the slot's own content cannot be built, post a tip instead of leaving a gap.
      let post = await s.build().catch((e) => {
        log("build failed, using a tip instead:", s.id, String(e).slice(0, 160));
        return null;
      });
      let fallback = false;
      if (!post) {
        post = await fallbackTip();
        fallback = true;
      }
      const mid = await sendToChannel(post.html, { preview: post.preview });
      await col.updateOne({ _id: id as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date(), ...(fallback ? { fallback: true } : {}) } });
      log("sent", id, mid, fallback ? "(fallback tip)" : "");
    } catch (e) {
      await markFailed(col, id, e, log);
    }
  }
}
