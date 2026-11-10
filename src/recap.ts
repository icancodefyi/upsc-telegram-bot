import type { Collection } from "mongodb";
import { sendToChannel } from "./telegram";

type Item = { title: string; paper: string; url: string; source: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Sunday recap: the last seven days of digests, grouped by GS paper. Returns false when there is too little to post. */
export async function postRecap(daily: Collection, today: string): Promise<boolean> {
  const docs = await daily.find({ date: { $lte: today } }).sort({ date: -1 }).limit(7).toArray();
  if (docs.length < 3) return false;
  const groups = new Map<string, Item[]>();
  for (const d of docs.reverse()) for (const it of d.items as Item[]) groups.set(it.paper, [...(groups.get(it.paper) ?? []), it]);
  const order = ["GS1", "GS2", "GS3", "GS4", "Prelims", "Other"].filter((p) => groups.has(p));
  const fmt = (d: string) => new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const html =
    `<b>This week in current affairs (${fmt(docs[0].date)} to ${fmt(docs[docs.length - 1].date)})</b>\n\n` +
    order.map((p) => `<b>${p}</b>\n` + groups.get(p)!.map((it) => `• <a href="${esc(it.url)}">${esc(it.title)}</a>`).join("\n")).join("\n\n") +
    `\n\nRevise these before Monday. More: https://upscprepnotes.in/current-affairs?utm_source=telegram&utm_medium=channel&utm_campaign=weekly_recap`;
  await sendToChannel(html.slice(0, 4000), { preview: false });
  return true;
}
