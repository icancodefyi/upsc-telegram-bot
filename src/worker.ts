import "dotenv/config";
import mongoose from "mongoose";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendToChannel } from "./telegram";
import { buildDailyCA } from "./daily-ca";

/**
 * Runs on the VPS. Every minute it posts whatever is due:
 *  - bot/content/*.json: posts written in advance, each with an id, an IST time and the text.
 *  - the daily current-affairs post: built at 05:30 IST and sent at 07:00 IST.
 * State lives in MongoDB (tg_posts) so a restart never double-posts.
 */
type Planned = { id: string; at: string; text: string; preview?: boolean };

const IST = "Asia/Kolkata";
const istParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}` };
};
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function loadPlan(): Planned[] {
  const dir = join(process.cwd(), "content");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Planned[]);
}

async function tick() {
  const col = mongoose.connection.db!.collection("tg_posts");
  const now = new Date();
  const { date, hm } = istParts(now);

  // 1. Posts written in advance.
  for (const p of loadPlan()) {
    const due = new Date(p.at.replace(" ", "T") + ":00+05:30");
    if (due > now || now.getTime() - due.getTime() > 6 * 3600_000) continue; // not yet, or too stale to send
    const claim = await col.updateOne({ _id: p.id as never }, { $setOnInsert: { status: "sending", at: now } }, { upsert: true });
    if (claim.upsertedCount === 0) continue; // already sent or being sent
    try {
      const mid = await sendToChannel(p.text, { preview: p.preview });
      await col.updateOne({ _id: p.id as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
      log("sent", p.id, mid);
    } catch (e) {
      await col.updateOne({ _id: p.id as never }, { $set: { status: "failed", error: String(e).slice(0, 300) } });
      log("FAILED", p.id, String(e));
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
          const { html, items } = await buildDailyCA(now);
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
