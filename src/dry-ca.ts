import "dotenv/config";
import { buildDailyCA } from "./daily-ca";
import { fetchCandidates } from "./sources";

(async () => {
  const c = await fetchCandidates();
  const by: Record<string, number> = {};
  c.forEach((x) => (by[x.source] = (by[x.source] ?? 0) + 1));
  console.log("candidates", c.length, by);
  console.log((await buildDailyCA(new Date())).html);
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
