import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type P = { id: string; at: string; text: string; photo?: string };
const dir = join(process.cwd(), "content");
const posts = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as P[]);
const errs: string[] = [];
const ids = new Set<string>();
const net = process.argv.includes("--links");

(async () => {
  for (const p of posts) {
    if (ids.has(p.id)) errs.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.at) || Number.isNaN(Date.parse(p.at.replace(" ", "T") + ":00+05:30"))) errs.push(`${p.id}: bad time ${p.at}`);
    if (/[—–]/.test(p.text)) errs.push(`${p.id}: contains a dash character`);
    if (p.text.length > 4000) errs.push(`${p.id}: ${p.text.length} chars`);
    for (const t of ["b", "i", "a"]) if ((p.text.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length !== (p.text.match(new RegExp(`</${t}>`, "g")) ?? []).length) errs.push(`${p.id}: unbalanced <${t}>`);
    if (p.photo && p.text.length > 1000) errs.push(`${p.id}: caption over 1000 chars`);
    if (net) for (const u of [...(p.photo ? [p.photo] : []), ...(p.text.match(/https:\/\/[^\s<"]+/g) ?? [])]) {
      const r = await fetch(u, { redirect: "follow" }).catch(() => null);
      if (!r || r.status !== 200) errs.push(`${p.id}: ${u} -> ${r?.status}`);
    }
  }
  const slots = posts.map((p) => p.at).sort();
  console.log(`${posts.length} posts, ${slots[0]} to ${slots[slots.length - 1]}`);
  if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
  console.log("content ok");
})();
