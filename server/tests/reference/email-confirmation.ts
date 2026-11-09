import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError } from "./store.js";
import { proxyAuth, safeDesktopRedirect, type AuthSettings } from "./auth.js";

const confirmation = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  type: z.enum(["signup", "magiclink", "recovery", "invite"]),
  redirect_to: z.string().max(256),
});
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** GET only renders the confirmation; the email token is consumed after a click. */
export async function confirmEmail(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  readBody: () => Promise<Buffer>,
  authUrl: string,
  settings: AuthSettings,
) {
  if (!settings.magicLink || !["GET", "POST"].includes(req.method ?? ""))
    throw new HttpError(404, "Not found");
  if (
    req.method === "POST" &&
    (req.headers.origin !== settings.publicUrl ||
      req.headers["content-type"]?.split(";")[0] !==
        "application/x-www-form-urlencoded")
  )
    throw new HttpError(400, "Open the original link from your sign-in email");
  const params =
    req.method === "GET"
      ? url.searchParams
      : new URLSearchParams((await readBody()).toString());
  for (const key of ["token", "type", "redirect_to"])
    if (params.getAll(key).length !== 1)
      throw new HttpError(400, "Invalid sign-in link");
  const input = confirmation.parse(Object.fromEntries(params));
  input.redirect_to = safeDesktopRedirect(input.redirect_to);
  if (req.method === "POST") {
    const verify = new URL("/auth/verify", settings.publicUrl);
    verify.search = new URLSearchParams(input).toString();
    await proxyAuth(req, res, verify, authUrl, readBody, settings, "GET");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Sign in to Orka</title><style>body{margin:0;background:#0a0a0a;color:#ededed;font:16px/1.5 system-ui,sans-serif;min-height:100dvh;display:grid;place-items:center}main{box-sizing:border-box;width:min(440px,calc(100% - 48px));padding:28px;background:#121212;border:1px solid #292929;border-radius:16px}h1{font-size:24px;margin:0 0 12px}p{color:#b3b3b3}button{width:100%;min-height:44px;border:0;border-radius:9px;background:#f5f5f5;color:#121212;font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #fff;outline-offset:4px}.hint{font-size:14px;margin-bottom:0}</style></head><body><main><h1>Finish signing in</h1><p>Continue on the Mac where you requested this email.</p><form method="post" action="/auth/confirm">${Object.entries(
      input,
    )
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${key}" value="${escape(value)}">`,
      )
      .join(
        "",
      )}<button type="submit">Open Orka</button></form><p class="hint">You can also return to Orka and enter the code from your email.</p></main></body></html>`,
  );
}
