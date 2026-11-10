import "dotenv/config";
import mongoose from "mongoose";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendToChannel, sendPhotoToChannel } from "./telegram";
import { buildDailyCA } from "./daily-ca";
import { postQuiz } from "./quiz";
import { postRecap } from "./recap";
import { runSlots } from "./slots";

/**
 * Runs on the VPS. Every minute it posts whatever is due:
 *  - bot/content/*.json: posts written in advance, each with an id, an IST time and the text.
 *  - the daily current-affairs post: built at 05:30 IST and sent at 07:00 IST.
 * State lives in MongoDB (tg_posts) so a restart never double-posts.
 */
type Planned = { id: string; at: string; text: string; preview?: boolean; photo?: string };

const IST = "Asia/Kolkata";
const istParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}` };
};
/** "10:00" plus three hours is "13:00". Slots stay open for a short window so a restart still catches them. */
const addHours = (hm: string, h: number) => `${String(Math.min(23, Number(hm.slice(0, 2)) + h)).padStart(2, "0")}:${hm.slice(3)}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function loadPlan(): Planned[] {
  const dir = join(process.cwd(), "content");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Planned[]);
}

const QUIZ_TIMES = (process.env.QUIZ_TIMES ?? "10:00").split(",").map((t) => t.trim()).filter(Boolean);
const RECAP_TIME = process.env.RECAP_TIME || "18:00";

async function tick() {
  const col = mongoose.connection.db!.collection("tg_posts");
  const now = new Date();
  const parts = istParts(now);
  const date = parts.date;
  const hm = process.env.DRY_RUN === "1" && process.env.TEST_HM ? process.env.TEST_HM : parts.hm; // TEST_HM only applies in dry runs

  // 1. Posts written in advance.
  for (const p of loadPlan()) {
    const due = new Date(p.at.replace(" ", "T") + ":00+05:30");
    if (due > now || now.getTime() - due.getTime() > 6 * 3600_000) continue; // not yet, or too stale to send
    const claim = await col.updateOne({ _id: p.id as never }, { $setOnInsert: { status: "sending", at: now } }, { upsert: true });
    if (claim.upsertedCount === 0) continue; // already sent or being sent
    try {
      const mid = p.photo ? await sendPhotoToChannel(p.photo, p.text) : await sendToChannel(p.text, { preview: p.preview });
      await col.updateOne({ _id: p.id as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
      log("sent", p.id, mid);
    } catch (e) {
      await col.updateOne({ _id: p.id as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
      log("FAILED", p.id, String(e));
    }
  }

  // 1b. Quiz polls, a few times a day. Each slot is claimed once per day.
  for (const t of QUIZ_TIMES) {
    if (hm < t || hm >= addHours(t, 3)) continue;
    const id = `quiz-${date}-${t}`;
    const claim = await col.updateOne({ _id: id as never }, { $setOnInsert: { status: "sending", at: now } }, { upsert: true });
    if (claim.upsertedCount === 0) continue;
    try {
      const qid = await postQuiz(mongoose.connection.db!.collection("quiz_state"));
      await col.updateOne({ _id: id as never }, { $set: { status: "sent", question: qid, sentAt: new Date() } });
      log("sent", id, qid);
    } catch (e) {
      await col.updateOne({ _id: id as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
      log("FAILED", id, String(e));
    }
  }

  // 1b2. Tip, concept, promo and data-fact slots.
  await runSlots(date, hm, now, log);

  // 1c. Sunday recap of the week's digests.
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(now);
  if ((dow === "Sun" || process.env.FORCE_RECAP === "1") && hm >= RECAP_TIME && hm < addHours(RECAP_TIME, 3)) {
    const id = `recap-${date}`;
    const claim = await col.updateOne({ _id: id as never }, { $setOnInsert: { status: "sending", at: now } }, { upsert: true });
    if (claim.upsertedCount === 1) {
      try {
        const posted = await postRecap(mongoose.connection.db!.collection("ca_daily"), date);
        await col.updateOne({ _id: id as never }, { $set: { status: posted ? "sent" : "skipped", sentAt: new Date() } });
        log(posted ? "sent" : "skipped (too few digests)", id);
      } catch (e) {
        await col.updateOne({ _id: id as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
        log("FAILED", id, String(e));
      }
    }
  }

  // 2. Build tomorrow-morning's current affairs at 05:30, then send at 07:00.
  const caId = `ca-${date}`;
  const force = process.env.FORCE_CA === "1";
  if (force || (hm >= "05:30" && hm < "09:00")) {
    const doc = await col.findOne({ _id: caId as never });
    if (!doc) {
      const claim = await col.updateOne({ _id: caId as never }, { $setOnInsert: { status: "building", at: now } }, { upsert: true });
      if (claim.upsertedCount === 1) {
        try {
          const recent = await mongoose.connection.db!.collection("ca_daily").find({ date: { $lt: date } }).sort({ date: -1 }).limit(4).toArray();
          const seen = new Set<string>(recent.flatMap((d) => (d.items as { url: string }[]).map((i) => i.url)));
          const { html, items } = await buildDailyCA(now, seen);
          await col.updateOne({ _id: caId as never }, { $set: { status: "ready", html } });
          // Kept for the website: a weekly roundup is built from these.
          await mongoose.connection.db!.collection("ca_daily").updateOne({ _id: date as never }, { $set: { date, items, createdAt: now } }, { upsert: true });
          log("built", caId);
        } catch (e) {
          await col.updateOne({ _id: caId as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
          log("CA build failed", String(e));
        }
      }
    }
    const ready = await col.findOne({ _id: caId as never, status: "ready" });
    if (ready && (force || hm >= "07:00")) {
      const lock = await col.updateOne({ _id: caId as never, status: "ready" }, { $set: { status: "sending" } });
      if (lock.modifiedCount === 1) {
        try {
          const mid = await sendToChannel(ready.html as string, { preview: false });
          await col.updateOne({ _id: caId as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
          log("sent", caId, mid);
        } catch (e) {
          await col.updateOne({ _id: caId as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
          log("CA send failed", String(e));
        }
      }
    }
  }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB || "upscprepnotes" });
  log("worker started");
  const loop = async () => {
    try { await tick(); } catch (e) { log("tick error", String(e)); }
  };
  await loop();
  setInterval(loop, 60_000);
})();
