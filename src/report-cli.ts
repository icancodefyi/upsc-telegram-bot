import "dotenv/config";
import mongoose from "mongoose";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildReportPdf } from "./report-pdf";
import { sendDocumentToAdmin } from "./telegram";
import { commandSpec } from "./site-report";

/**
 * Build a report PDF by hand. The words are the same as the Telegram /report command.
 *   npm run report -- day|week|month|today|thismonth|all     writes the PDF into ./reports (nothing is sent)
 *   npm run report -- 2026-11-01 2026-11-10                  a range of days, both included
 *   add --send to also deliver it to ADMIN_CHAT_ID on Telegram
 */
(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const send = process.argv.includes("--send");
  if (!send) process.env.REPORT_PREVIEW = "1";
  await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB });
  const spec = await commandSpec(args.length ? args : ["week"]);
  const { pdf, filename, caption } = await buildReportPdf(spec);
  mkdirSync("reports", { recursive: true });
  writeFileSync(`reports/${filename}`, pdf);
  console.log(`Wrote reports/${filename} (${Math.round(pdf.length / 1024)} KB)`);
  if (send) {
    await sendDocumentToAdmin(pdf, filename, caption);
    console.log("Sent to the admin chat.");
  }
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
