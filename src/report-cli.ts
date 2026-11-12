import "dotenv/config";
import mongoose from "mongoose";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildReportPdf } from "./report-pdf";
import { sendDocumentToAdmin } from "./telegram";
import type { Period } from "./site-report";

/**
 * Build a report PDF by hand.
 *   npm run report -- day|week|month           writes the PDF into ./reports (nothing is sent)
 *   npm run report -- day|week|month --send    also sends it to ADMIN_CHAT_ID on Telegram
 */
(async () => {
  const arg = process.argv[2];
  const period = (arg === "month" ? "month" : arg === "day" ? "day" : "week") as Period;
  const send = process.argv.includes("--send");
  if (!send) process.env.REPORT_PREVIEW = "1";
  await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB });
  const { pdf, filename, caption } = await buildReportPdf(period);
  mkdirSync("reports", { recursive: true });
  writeFileSync(`reports/${filename}`, pdf);
  console.log(`Wrote reports/${filename} (${Math.round(pdf.length / 1024)} KB)`);
  if (send) {
    await sendDocumentToAdmin(pdf, filename, caption);
    console.log("Sent to the admin chat.");
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
