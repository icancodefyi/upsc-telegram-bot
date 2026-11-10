import type { Collection } from "mongodb";
import { alertAdmin } from "./telegram";

const RETRY_AFTER_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Takes a job so only one run does it. A new job is claimed at once. A job that failed, or was left
 * "sending" by a crash, can be taken again after ten minutes, up to three attempts in all.
 */
export async function claim(col: Collection, id: string, now: Date): Promise<boolean> {
  const ins = await col.updateOne({ _id: id as never }, { $setOnInsert: { status: "sending", at: now, attempts: 1 } }, { upsert: true });
  if (ins.upsertedCount === 1) return true;
  const retry = await col.updateOne(
    { _id: id as never, status: { $in: ["failed", "sending"] }, at: { $lt: new Date(now.getTime() - RETRY_AFTER_MS) }, $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] },
    { $set: { status: "sending", at: now }, $inc: { attempts: 1 } },
  );
  return retry.modifiedCount === 1;
}

/** Records a failure. After the last attempt the owner is told once. */
export async function markFailed(col: Collection, id: string, err: unknown, log: (...a: unknown[]) => void): Promise<void> {
  const msg = String(err).slice(0, 300);
  await col.updateOne({ _id: id as never }, { $set: { status: "failed", error: msg } });
  log("FAILED", id, msg);
  const doc = await col.findOne({ _id: id as never });
  if (doc && (doc.attempts as number) >= MAX_ATTEMPTS && !doc.alerted) {
    await col.updateOne({ _id: id as never }, { $set: { alerted: true } });
    await alertAdmin(`${id} failed after ${MAX_ATTEMPTS} attempts.\n${msg}`);
  }
}
