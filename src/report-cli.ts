import "dotenv/config";
import mongoose from "mongoose";
import { buildReport, type Period } from "./site-report";
import { sendToAdmin } from "./telegram";

/**
 * Preview or send a report by hand.
 *   npm run report -- week            prints the weekly report
 *   npm run report -- month           prints the monthly report
 *   npm run report -- week --send     also sends it to ADMIN_CHAT_ID
 */
(async () => {
  const period = (process.argv[2] === "month" ? "month" : "week") as Period;
  const send = process.argv.includes("--send");
  if (!send) process.env.REPORT_PREVIEW = "1";
  await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB });
  const messages = await buildReport(period);
  for (const m of messages) {
    console.log(m.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") + "\n----------------");
    if (send) await sendToAdmin(m);
  }
  console.log(send ? `Sent ${messages.length} message(s) to the admin chat.` : `Preview only (${messages.length} message(s)). Add --send to deliver it.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
