const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN!;
const CHANNEL = () => process.env.TELEGRAM_CHANNEL_ID!;

/** Posts one HTML message to the channel. Link previews stay on so our pages show their share image. */
export async function sendToChannel(html: string, opts: { preview?: boolean } = {}): Promise<number> {
  if (process.env.DRY_RUN === "1") {
    console.log("[DRY_RUN] would post:\n" + html + "\n");
    return 0;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL(), text: html, parse_mode: "HTML", link_preview_options: { is_disabled: opts.preview === false } }),
  });
  const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
  if (!j.ok) throw new Error(`telegram: ${j.description}`);
  return j.result!.message_id;
}

/** Posts a photo with a caption (captions are limited to 1024 characters). */
export async function sendPhotoToChannel(photoUrl: string, caption: string): Promise<number> {
  if (process.env.DRY_RUN === "1") {
    console.log(`[DRY_RUN] would post photo ${photoUrl}:\n${caption}\n`);
    return 0;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL(), photo: photoUrl, caption, parse_mode: "HTML" }),
  });
  const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
  if (!j.ok) throw new Error(`telegram: ${j.description}`);
  return j.result!.message_id;
}

/** Posts a quiz-mode poll. Telegram limits: question 300 chars, options 100, explanation 200. */
export async function sendQuizPoll(question: string, options: string[], correct: number, explanation?: string): Promise<number> {
  if (process.env.DRY_RUN === "1") {
    console.log(`[DRY_RUN] would post quiz poll:\n${question}\n${options.map((o, i) => `  ${"ABCD"[i]}) ${o}${i === correct ? "   <- correct" : ""}`).join("\n")}\n  explanation: ${explanation ?? "(none)"}\n`);
    return 0;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendPoll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL(), question, options, type: "quiz", correct_option_id: correct, is_anonymous: true, ...(explanation ? { explanation } : {}) }),
  });
  const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
  if (!j.ok) throw new Error(`telegram: ${j.description}`);
  return j.result!.message_id;
}
