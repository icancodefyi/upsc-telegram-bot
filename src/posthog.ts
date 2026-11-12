/**
 * Reads visitor data from PostHog with HogQL. Needs POSTHOG_PERSONAL_API_KEY (query read access).
 * POSTHOG_PROJECT_ID and POSTHOG_API_HOST default to this project's values.
 */

const HOST = () => (process.env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
const PROJECT = () => process.env.POSTHOG_PROJECT_ID || "480014";

export const phEnabled = () => !!process.env.POSTHOG_PERSONAL_API_KEY;

/** A HogQL timestamp for an instant. */
export const hogTs = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace("T", " ")}', 'UTC')`;

/**
 * Only real visits to the live site: the site's own hostnames (no localhost or previews), not bots or
 * crawlers (PostHog's own bot detection), and not private pages.
 */
export const SITE_EVENT = `properties.$host IN ('upscprepnotes.in', 'www.upscprepnotes.in') AND (properties.$virt_is_bot IS NULL OR properties.$virt_is_bot = false)`;
export const PUBLIC_PAGE = `NOT match(properties.$pathname, '^/(admin|api|get/|download/|unsubscribe|ask)')`;

export async function phQuery(sql: string): Promise<unknown[][]> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY is not set");
  const res = await fetch(`${HOST()}/api/projects/${PROJECT()}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql }, refresh: "blocking" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { results?: unknown[][] };
  return j.results ?? [];
}
