import mongoose from "mongoose";
import { getUpdates, replyToAdmin, sendDocumentToAdmin } from "./telegram";
import { commandSpec, quickStatus } from "./site-report";
import { buildReportPdf } from "./report-pdf";

/**
 * Lets the owner ask for things on Telegram. Only messages from ADMIN_CHAT_ID are answered; every
 * other chat is ignored. Requests run one at a time, and the position in the message stream is saved,
 * so a restart never repeats an old request.
 *
 *   /report today|yesterday|week|month|thismonth|all   a branded PDF
 *   /report 2026-11-01 2026-11-10                      a range of days (both included)
 *   /status                                            today so far, in a few lines
 *   /help                                              this list
 */

const HELP = `<b>What I can do</b>

/report today
/report yesterday
/report week  (the last 7 days)
/report month  (last calendar month)
/report thismonth
/report all  (everything to date)
/report 2026-11-01 2026-11-10  (a range, both days included)
/status  (today so far, a few lines)

I send the report as a PDF. It takes about 20 seconds.`;

const num = (n: number) => n.toLocaleString("en-IN");
let queue: Promise<void> = Promise.resolve();

async function handle(text: string): Promise<void> {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  try {
    if (cmd === "/start" || cmd === "/help") return void (await replyToAdmin(HELP));
    if (cmd === "/status") {
      const { label, s } = await quickStatus();
      return void (await replyToAdmin(
        `<b>Today so far</b>\n${label}\n\n<pre>${[
          `Visitors         ${String(num(s.visitors)).padStart(7)}`,
          `From India       ${String(num(s.india)).padStart(7)}`,
          `Page views       ${String(num(s.views)).padStart(7)}`,
          `New leads        ${String(num(s.leads)).padStart(7)}`,
          `  with answers   ${String(num(s.leadsFull)).padStart(7)}`,
          `Checkouts        ${String(num(s.ordersStarted)).padStart(7)}`,
          `Paid             ${String(num(s.paid)).padStart(7)}`,
          `Revenue          ${("Rs " + num(s.revenue)).padStart(7)}`,
          `Quizzes finished ${String(num(s.quizPlays)).padStart(7)}`,
        ].join("\n")}</pre>`,
      ));
    }
    if (cmd === "/report") {
      const spec = await commandSpec(args.length ? args : ["week"]);
      await replyToAdmin(`Building your report for <b>${spec.current.label}</b>. About 20 seconds.`);
      process.env.REPORT_PREVIEW = "1"; // a report you ask for must not move the "members since last report" baseline
      const { pdf, filename, caption } = await buildReportPdf(spec);
      await sendDocumentToAdmin(pdf, filename, caption);
      return;
    }
    await replyToAdmin(`I do not know that one. Send /help to see what I can do.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("command failed:", text, msg);
    await replyToAdmin(`That did not work: ${msg.replace(/[<>&]/g, "").slice(0, 300)}\n\nSend /help to see what I can do.`);
  }
}

/** Starts listening. Safe to call once at start-up; it keeps running and recovers from network errors. */
export function startCommandLoop(log: (...a: unknown[]) => void): void {
  const admin = process.env.ADMIN_CHAT_ID;
  if (!admin || process.env.DRY_RUN === "1") return;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    const col = () => mongoose.connection.db!.collection("health");
    let offset = ((await col().findOne({ _id: "tg-updates-offset" as never }))?.offset as number | undefined) ?? 0;
    let wait = 2000;
    log("listening for commands from the admin chat");
    for (;;) {
      try {
        const updates = await getUpdates(offset);
        wait = 2000;
        for (const u of updates) {
          offset = u.update_id + 1;
          await col().updateOne({ _id: "tg-updates-offset" as never }, { $set: { offset } }, { upsert: true });
          const text = u.message?.text;
          if (!text?.startsWith("/") || String(u.message?.chat.id) !== String(admin)) continue; // ignore everyone else
          queue = queue.then(() => handle(text)).catch(() => {});
        }
      } catch (e) {
        log("command polling error:", String(e).slice(0, 160));
        await sleep(wait);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  })();
}
