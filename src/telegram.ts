const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN!;
const CHANNEL = () => process.env.TELEGRAM_CHANNEL_ID!;
const dry = () => process.env.DRY_RUN === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TgError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

/** One Telegram call with a timeout, retries on network errors, 5xx and rate limits (honouring retry_after). */
async function call<T>(method: string, body: Record<string, unknown>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const j = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      if (j.ok) return j.result as T;
      const code = j.error_code ?? res.status;
      if (code === 429) {
        await sleep(Math.min((j.parameters?.retry_after ?? 5) + 1, 60) * 1000);
        last = new TgError(j.description ?? "rate limited", code);
        continue;
      }
      if (code >= 500) {
        last = new TgError(j.description ?? "server error", code);
        await sleep(2000 * 2 ** i);
        continue;
      }
      throw new TgError(j.description ?? "telegram error", code); // 4xx: retrying will not help
    } catch (e) {
      if (e instanceof TgError && e.code < 500 && e.code !== 429) throw e;
      last = e;
      await sleep(2000 * 2 ** i);
    }
  }
  throw last;
}

const toPlain = (html: string) =>
  html.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "$2 ($1)").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** Telegram allows 4096 characters. Cut at a paragraph break rather than mid-sentence. */
function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"), 200)).trimEnd();
}

/** Posts one HTML message. If Telegram rejects the markup, it is sent again as plain text. */
export async function sendToChannel(html: string, opts: { preview?: boolean } = {}): Promise<number> {
  if (dry()) {
    console.log("[DRY_RUN] would post:\n" + html + "\n");
    return 0;
  }
  const base = { chat_id: CHANNEL(), link_preview_options: { is_disabled: opts.preview === false } };
  try {
    return (await call<{ message_id: number }>("sendMessage", { ...base, text: fit(html, 4096), parse_mode: "HTML" })).message_id;
  } catch (e) {
    if (e instanceof TgError && /parse entities|unsupported start tag|can't find end/i.test(e.message)) {
      return (await call<{ message_id: number }>("sendMessage", { ...base, text: fit(toPlain(html), 4096) })).message_id;
    }
    throw e;
  }
}

/** Posts a photo with a caption. If the photo cannot be sent, the caption goes out as a text post. */
export async function sendPhotoToChannel(photoUrl: string, caption: string): Promise<number> {
  if (dry()) {
    console.log(`[DRY_RUN] would post photo ${photoUrl}:\n${caption}\n`);
    return 0;
  }
  try {
    return (await call<{ message_id: number }>("sendPhoto", { chat_id: CHANNEL(), photo: photoUrl, caption: fit(caption, 1024), parse_mode: "HTML" })).message_id;
  } catch {
    return sendToChannel(caption);
  }
}

/** Posts a quiz-mode poll. Telegram limits: question 300 chars, options 100, explanation 200. */
export async function sendQuizPoll(question: string, options: string[], correct: number, explanation?: string): Promise<number> {
  if (dry()) {
    console.log(`[DRY_RUN] would post quiz poll:\n${question}\n${options.map((o, i) => `  ${"ABCD"[i]}) ${o}${i === correct ? "   <- correct" : ""}`).join("\n")}\n  explanation: ${explanation ?? "(none)"}\n`);
    return 0;
  }
  return (await call<{ message_id: number }>("sendPoll", { chat_id: CHANNEL(), question, options, type: "quiz", correct_option_id: correct, is_anonymous: true, ...(explanation ? { explanation } : {}) })).message_id;
}

/** Number of people in the channel, or null if it cannot be read. */
export async function channelMemberCount(): Promise<number | null> {
  if (dry()) return null;
  try {
    return await call<number>("getChatMemberCount", { chat_id: CHANNEL() }, 2);
  } catch {
    return null;
  }
}

/**
 * A private HTML message to the owner (reports). Unlike alertAdmin this throws on failure, so the
 * caller can retry. If Telegram rejects the markup it is sent again as plain text.
 */
export async function sendToAdmin(html: string): Promise<void> {
  const chat = process.env.ADMIN_CHAT_ID;
  if (!chat) throw new Error("ADMIN_CHAT_ID is not set");
  if (dry()) {
    console.log("[DRY_RUN] would send to admin:\n" + html + "\n");
    return;
  }
  try {
    await call("sendMessage", { chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) {
    if (e instanceof TgError && e.code === 400) {
      await call("sendMessage", { chat_id: chat, text: toPlain(html), disable_web_page_preview: true });
      return;
    }
    throw e;
  }
}

export type TgMessage = { update_id: number; message?: { text?: string; chat: { id: number }; message_id: number } };

/** Long-polls for new messages. The wait is kept under the 20 second call timeout. */
export async function getUpdates(offset: number): Promise<TgMessage[]> {
  return call<TgMessage[]>("getUpdates", { offset, timeout: 15, allowed_updates: ["message"] }, 1);
}

/** A plain-text or HTML reply to the owner. Never throws. */
export async function replyToAdmin(html: string): Promise<void> {
  const chat = process.env.ADMIN_CHAT_ID;
  if (!chat || dry()) return;
  try {
    await call("sendMessage", { chat_id: chat, text: html.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }, 2);
  } catch {
    /* nothing more we can do */
  }
}

/** Sends a file (a report PDF) to the owner's private chat. Throws on failure so the caller can retry. */
export async function sendDocumentToAdmin(file: Buffer, filename: string, caption: string): Promise<void> {
  const chat = process.env.ADMIN_CHAT_ID;
  if (!chat) throw new Error("ADMIN_CHAT_ID is not set");
  if (dry()) {
    console.log(`[DRY_RUN] would send ${filename} (${file.length} bytes) to admin. Caption: ${caption}`);
    return;
  }
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const form = new FormData();
      form.set("chat_id", chat);
      form.set("caption", caption);
      form.set("parse_mode", "HTML");
      form.set("document", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
      const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
      const j = (await res.json()) as { ok: boolean; description?: string; error_code?: number };
      if (j.ok) return;
      last = new TgError(j.description ?? "telegram error", j.error_code ?? res.status);
      if ((j.error_code ?? res.status) < 500 && (j.error_code ?? res.status) !== 429) throw last;
    } catch (e) {
      if (e instanceof TgError && e.code < 500 && e.code !== 429) throw e;
      last = e;
    }
    await sleep(3000 * (i + 1));
  }
  throw last;
}

/** A private message to the owner when something needs attention. Never throws. Needs ADMIN_CHAT_ID. */
export async function alertAdmin(text: string): Promise<void> {
  console.error("ALERT:", text);
  const chat = process.env.ADMIN_CHAT_ID;
  if (!chat || dry()) return;
  try {
    await call("sendMessage", { chat_id: chat, text: `Telegram bot alert\n\n${text}`.slice(0, 4000) }, 2);
  } catch {
    /* nothing more we can do */
  }
}
