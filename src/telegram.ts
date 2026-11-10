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
