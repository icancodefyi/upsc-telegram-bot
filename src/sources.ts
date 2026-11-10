export type Candidate = { id: number; source: string; title: string; description: string; url: string; published?: Date };

const FEEDS: { source: string; url: string }[] = [
  { source: "PIB", url: "https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3&reg=3" },
  { source: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
  { source: "The Hindu", url: "https://www.thehindu.com/news/international/feeder/default.rss" },
  { source: "The Hindu", url: "https://www.thehindu.com/business/Economy/feeder/default.rss" },
  { source: "The Hindu", url: "https://www.thehindu.com/sci-tech/feeder/default.rss" },
  { source: "The Hindu", url: "https://www.thehindu.com/opinion/editorial/feeder/default.rss" },
  { source: "Indian Express", url: "https://indianexpress.com/section/explained/feed/" },
  { source: "Indian Express", url: "https://indianexpress.com/section/india/feed/" },
  { source: "The Hindu", url: "https://www.thehindu.com/opinion/lead/feeder/default.rss" },
];

const UA = { "user-agent": "Mozilla/5.0" };

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const tag = (item: string, name: string) => decode(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

export async function fetchCandidates(maxAgeHours = 30): Promise<Candidate[]> {
  if (process.env.TEST_FAIL === "feeds") return [];
  const out: Candidate[] = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(20000) });
        if (!res.ok) return;
        const xml = await res.text();
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const title = tag(m[1], "title");
          const link = tag(m[1], "link") || tag(m[1], "guid");
          const pub = tag(m[1], "pubDate");
          const published = pub ? new Date(pub) : undefined;
          if (!title || !link.startsWith("http")) continue;
          // PIB items carry no date; the feed only holds the latest few, so keep them.
          if (published && Date.now() - published.getTime() > maxAgeHours * 3600_000) continue;
          out.push({ id: 0, source: f.source, title, description: tag(m[1], "description").slice(0, 400), url: link, published });
        }
      } catch {
        /* one feed being down must not stop the run */
      }
    }),
  );
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).map((c, i) => ({ ...c, id: i + 1 }));
}

/** Best-effort article text, used only to ground the summary. Paywalled pages may return little. */
export async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!res.ok) return "";
    const html = await res.text();
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1])).filter((p) => p.length > 60);
    return paras.join(" ").slice(0, 2500);
  } catch {
    return "";
  }
}
