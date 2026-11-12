import "dotenv/config";
import mongoose from "mongoose";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendToChannel, sendPhotoToChannel, alertAdmin } from "./telegram";
import { buildDigest, type Item } from "./daily-ca";
import { postQuiz } from "./quiz";
import { postRecap } from "./recap";
import { runSlots, emergencyMorning } from "./slots";
import { claim, markFailed } from "./claim";
import { buildReportPdf } from "./report-pdf";
import { scheduledSpec } from "./site-report";
import { startCommandLoop } from "./commands";
import { sendDocumentToAdmin } from "./telegram";

/**
 * Runs on the VPS. Every minute it posts whatever is due. Every job has a fallback, retries and a record in
 * MongoDB (tg_posts), so a failure never leaves a silent gap and a restart never double-posts.
 *
 *  - Calendar posts in content/*.json: an id, an IST time and the text.
 *  - Daily current-affairs digest: built from 05:30, posted at 07:00.
 *  - Quiz, tip, concept, promo and data-fact slots (see slots.ts), and a Sunday recap.
 */
type Planned = { id: string; at: string; text: string; preview?: boolean; photo?: string };

const IST = "Asia/Kolkata";
const BUILD_FROM = "05:30";
const SEND_AT = "07:00";
const EMERGENCY_AT = "08:30";
const QUIZ_TIMES = (process.env.QUIZ_TIMES ?? "10:00").split(",").map((t) => t.trim()).filter(Boolean);
const RECAP_TIME = process.env.RECAP_TIME || "18:00";
const SITE_REPORT_TIME = process.env.SITE_REPORT_TIME || "08:00"; // every morning; weekly on Sunday; monthly on the 1st

const istParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}`, dow: g("weekday") };
};
const addHours = (hm: string, h: number) => `${String(Math.min(23, Number(hm.slice(0, 2)) + h)).padStart(2, "0")}:${hm.slice(3)}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function loadPlan(): Planned[] {
  const dir = join(process.cwd(), "content");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Planned[]);
}

async function tick() {
  const db = mongoose.connection.db!;
  const col = db.collection("tg_posts");
  const now = new Date();
  const p = istParts(now);
  const date = p.date;
  const dry = process.env.DRY_RUN === "1";
  const hm = dry && process.env.TEST_HM ? process.env.TEST_HM : p.hm;
  const force = dry && process.env.FORCE_CA === "1";

  // 1. One-off posts written in advance.
  for (const post of loadPlan()) {
    const due = new Date(post.at.replace(" ", "T") + ":00+05:30");
    if (due > now || now.getTime() - due.getTime() > 6 * 3600_000) continue;
    if (!(await claim(col, post.id, now))) continue;
    try {
      const mid = post.photo ? await sendPhotoToChannel(post.photo, post.text) : await sendToChannel(post.text, { preview: post.preview });
      await col.updateOne({ _id: post.id as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
      log("sent", post.id, mid);
    } catch (e) {
      await markFailed(col, post.id, e, log);
    }
  }

  // 2. Quiz polls.
  for (const t of QUIZ_TIMES) {
    if (hm < t || hm >= addHours(t, 2)) continue;
    const id = `quiz-${date}-${t}`;
    if (!(await claim(col, id, now))) continue;
    try {
      const qid = await postQuiz(db.collection("quiz_state"));
      await col.updateOne({ _id: id as never }, { $set: { status: "sent", question: qid, sentAt: new Date() } });
      log("sent", id, qid);
    } catch (e) {
      await markFailed(col, id, e, log);
    }
  }

  // 3. Tip, concept, promo and data-fact slots.
  await runSlots(date, hm, now, log);

  // 4. Sunday recap.
  if ((p.dow === "Sun" || (dry && process.env.FORCE_RECAP === "1")) && hm >= RECAP_TIME && hm < addHours(RECAP_TIME, 2)) {
    const id = `recap-${date}`;
    if (await claim(col, id, now)) {
      try {
        const posted = await postRecap(db.collection("ca_daily"), date);
        await col.updateOne({ _id: id as never }, { $set: { status: posted ? "sent" : "skipped", sentAt: new Date() } });
        log(posted ? "sent" : "skipped (too few digests)", id);
      } catch (e) {
        await markFailed(col, id, e, log);
      }
    }
  }

  // 5. Daily digest: build from 05:30, send at 07:00.
  const caId = `ca-${date}`;
  if (force || (hm >= BUILD_FROM && hm < "10:00")) {
    if (!(await col.findOne({ _id: caId as never, status: { $in: ["ready", "sending", "sent"] } }))) {
      if (await claim(col, `${caId}-build`, now)) {
        try {
          const recent = await db.collection("ca_daily").find({ date: { $lt: date } }).sort({ date: -1 }).limit(4).toArray();
          const seen = new Set<string>(recent.flatMap((d) => (d.items as Item[]).map((i) => i.url)));
          const { html, items, mode } = await buildDigest(now, seen, recent.flatMap((d) => d.items as Item[]));
          await col.updateOne({ _id: caId as never }, { $set: { status: "ready", html, mode, sendAttempts: 0 } }, { upsert: true });
          if (items.length) await db.collection("ca_daily").updateOne({ _id: date as never }, { $set: { date, items, mode, createdAt: now } }, { upsert: true });
          await col.updateOne({ _id: `${caId}-build` as never }, { $set: { status: "sent", mode } });
          log("built", caId, mode);
          if (mode !== "ai") await alertAdmin(`Today's digest used the "${mode}" fallback (AI or feeds were unavailable). It will still post at ${SEND_AT}.`);
        } catch (e) {
          await markFailed(col, `${caId}-build`, e, log);
        }
      }
    }
    const lock = await col.findOneAndUpdate({ _id: caId as never, status: "ready" }, { $set: { status: "sending" } });
    if (lock && (force || hm >= SEND_AT)) {
      try {
        const mid = await sendToChannel(lock.html as string, { preview: false });
        await col.updateOne({ _id: caId as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
        log("sent", caId, mid);
      } catch (e) {
        const attempts = ((lock.sendAttempts as number) ?? 0) + 1;
        await col.updateOne({ _id: caId as never }, { $set: { status: attempts >= 3 ? "failed" : "ready", sendAttempts: attempts, error: String(e).slice(0, 300) } });
        log("digest send failed", attempts, String(e));
        if (attempts >= 3) await alertAdmin(`The 7 AM digest could not be sent after 3 tries.\n${String(e).slice(0, 300)}`);
      }
    } else if (lock) {
      await col.updateOne({ _id: caId as never }, { $set: { status: "ready" } }); // not 07:00 yet
    }
    // Last resort: if there is still no digest at 08:30, post a tip so the morning is never empty.
    if (hm >= EMERGENCY_AT && !(await col.findOne({ _id: caId as never, status: { $in: ["ready", "sending", "sent"] } })) && (await claim(col, `${caId}-emergency`, now))) {
      try {
        const mid = await sendToChannel(await emergencyMorning());
        await col.updateOne({ _id: `${caId}-emergency` as never }, { $set: { status: "sent", messageId: mid, sentAt: new Date() } });
        log("sent emergency morning post", mid);
        await alertAdmin("No digest could be built today, so a tip was posted instead.");
      } catch (e) {
        await markFailed(col, `${caId}-emergency`, e, log);
      }
    }
  }

  // 6. Branded PDF reports to the owner on Telegram: every morning (yesterday), Sunday (last 7 days) and the 1st (last month).
  if (process.env.ADMIN_CHAT_ID && process.env.SITE_DB_NAME && hm >= SITE_REPORT_TIME && hm < addHours(SITE_REPORT_TIME, 2)) {
    const due: { id: string; period: "day" | "week" | "month" }[] = [{ id: `site-daily-${date}`, period: "day" }];
    if (p.dow === "Sun") due.push({ id: `site-weekly-${date}`, period: "week" });
    if (date.endsWith("-01")) due.push({ id: `site-monthly-${date.slice(0, 7)}`, period: "month" });
    for (const job of due) {
      if (!(await claim(col, job.id, now))) continue;
      try {
        const { pdf, filename, caption } = await buildReportPdf(scheduledSpec(job.period, now));
        await sendDocumentToAdmin(pdf, filename, caption);
        await col.updateOne({ _id: job.id as never }, { $set: { status: "sent", sentAt: new Date(), bytes: pdf.length } });
        log("sent", job.id, filename);
      } catch (e) {
        await markFailed(col, job.id, e, log);
      }
    }
  }

  await db.collection("health").updateOne({ _id: "heartbeat" as never }, { $set: { at: now, hm } }, { upsert: true });
}

let lastOk = Date.now();
let running = false;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB || "upscprepnotes", serverSelectionTimeoutMS: 15000 });
  log("worker started");
  startCommandLoop(log); // the owner can ask for reports and status on Telegram
  const loop = async () => {
    if (running) return; // never run two ticks at once
    running = true;
    try {
      await tick();
      lastOk = Date.now();
    } catch (e) {
      log("tick error", String(e).slice(0, 300));
    } finally {
      running = false;
    }
  };
  await loop();
  setInterval(loop, 60_000);
  // If no tick has finished for ten minutes (a hung connection, say), exit so systemd restarts us.
  setInterval(() => {
    if (Date.now() - lastOk > 10 * 60_000) {
      log("watchdog: no successful tick for 10 minutes, restarting");
      process.exit(1);
    }
  }, 60_000);
})().catch((e) => {
  log("fatal at startup", String(e).slice(0, 300));
  process.exit(1);
});
