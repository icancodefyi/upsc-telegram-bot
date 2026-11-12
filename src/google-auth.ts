import "dotenv/config";
import { createServer } from "node:http";
import { writeFileSync, chmodSync } from "node:fs";

/**
 * One-time sign-in so the bot can read Search Console. Run it on your own computer, where you can open a browser:
 *
 *   DOTENV_CONFIG_PATH=../upscprepnotes.in/.env.local npm run google-auth
 *
 * It uses the site's Google client (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET, or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 * That client must list http://localhost:53682/callback as an authorised redirect URI, and the Search Console API
 * must be enabled in the same Google Cloud project. Sign in with the Google account that owns the property.
 * The token is saved to ./.gsc-token (owner-only, never committed). Nothing secret is printed.
 */

const id = process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/callback`;
if (!id || !secret) {
  console.error("No Google client found. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET).");
  process.exit(1);
}

const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: "code", scope: "https://www.googleapis.com/auth/webmasters.readonly", access_type: "offline", prompt: "consent" });

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", REDIRECT);
  if (u.pathname !== "/callback") return void res.writeHead(404).end();
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code. You can close this tab and try again.");
    console.error("Google returned no code:", u.searchParams.get("error") ?? "unknown");
    return void process.exit(1);
  }
  try {
    const t = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
    });
    const tok = (await t.json()) as { refresh_token?: string; access_token?: string; error_description?: string; error?: string };
    if (!tok.refresh_token || !tok.access_token) throw new Error(tok.error_description ?? tok.error ?? "no refresh token returned");
    writeFileSync(".gsc-token", JSON.stringify({ refresh_token: tok.refresh_token }), { mode: 0o600 });
    chmodSync(".gsc-token", 0o600);
    const sites = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const list = (await sites.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[]; error?: { message: string } };
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Done. You can close this tab and go back to the terminal.");
    console.log("Signed in. Saved the token to ./.gsc-token");
    if (list.error) console.log("Could not list your properties:", list.error.message, "(is the Search Console API enabled in the Google Cloud project?)");
    else console.log("Search Console properties you can read:\n" + (list.siteEntry ?? []).map((s) => `  ${s.siteUrl}  (${s.permissionLevel})`).join("\n"));
  } catch (e) {
    res.writeHead(500).end("Something went wrong. See the terminal.");
    console.error("Sign-in failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
  server.close();
});
server.listen(PORT, "127.0.0.1", () => console.log("Open this link in your browser and sign in:\n\n" + url + "\n"));
