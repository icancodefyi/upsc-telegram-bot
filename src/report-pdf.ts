import { chromium } from "playwright";
import { collectReport, ymdOf, type Period } from "./site-report";
import { renderHtml } from "./render-report";

const FOOTER = `<div style="width:100%;padding:0 14mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#858a96"><span>UPSCPrepNotes · upscprepnotes.in</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

/** Builds one report and renders it to a branded A4 PDF. */
export async function buildReportPdf(period: Period, now = new Date()): Promise<{ pdf: Buffer; filename: string; caption: string }> {
  const data = await collectReport(period, now);
  const html = renderHtml(data);
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: FOOTER,
      margin: { top: "14mm", right: "14mm", bottom: "16mm", left: "14mm" },
    });
    const c = data.cur;
    const tag = data.period === "day" ? "daily" : data.period === "week" ? "weekly" : "monthly";
    const stamp = ymdOf(data.range.start); // the report's own date in India time
    const caption = `<b>${data.title}</b>\n${data.range.label}\n${c.visitors.toLocaleString("en-IN")} visitors · ${c.leads.toLocaleString("en-IN")} new leads · ₹${c.revenue.toLocaleString("en-IN")} revenue`;
    return { pdf: Buffer.from(pdf), filename: `upscprepnotes-${tag}-report-${stamp}.pdf`, caption };
  } finally {
    await browser.close();
  }
}
