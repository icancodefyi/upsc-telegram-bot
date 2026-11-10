import Groq from "groq-sdk";

/** Models to try in order. If one is rate-limited or down, the next one answers. */
const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(e: unknown): number {
  const err = e as { status?: number; headers?: Record<string, string> | Headers; message?: string };
  if (err?.status !== 429) return 0;
  const h = err.headers as { get?: (k: string) => string | null } | undefined;
  const v = Number(h?.get?.("retry-after") ?? NaN);
  if (Number.isFinite(v)) return Math.min(v, 45) * 1000;
  const m = /try again in ([\d.]+)s/i.exec(err.message ?? "");
  return Math.min(m ? Number(m[1]) + 1 : 15, 45) * 1000;
}

/** Asks for a JSON answer. Tries every model, waits out rate limits, and gives up after three rounds. */
export async function askJson(prompt: string): Promise<unknown> {
  if (process.env.TEST_FAIL === "llm") throw new Error("simulated LLM failure");
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 45000, maxRetries: 0 });
  let last: unknown;
  for (let round = 0; round < 3; round++) {
    let wait = 0;
    for (const model of MODELS) {
      try {
        const r = await groq.chat.completions.create({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] });
        const text = r.choices[0].message.content ?? "";
        return JSON.parse(text);
      } catch (e) {
        last = e;
        wait = Math.max(wait, retryAfterMs(e));
      }
    }
    if (wait === 0 && round > 0) break;
    await sleep(wait || 5000);
  }
  throw last;
}
