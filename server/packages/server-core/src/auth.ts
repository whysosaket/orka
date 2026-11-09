import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Resend } from "resend";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { HttpError } from "./store.js";

export const desktopRedirect = "orka://auth/callback";
// Restrict profile routing to a single validated local name on the fixed callback.
export function safeDesktopRedirect(raw: string | null): string {
  return raw &&
    /^orka:\/\/auth\/callback\?profile=[a-z][a-z0-9-]{0,47}$/.test(raw)
    ? raw
    : desktopRedirect;
}

export function authSettings(env: NodeJS.ProcessEnv = process.env) {
  const mode = z
    .enum(["cloud", "self-hosted"])
    .parse(env.DEPLOYMENT_MODE ?? "self-hosted");
  const password = env.PASSWORD_ENABLED !== "false";
  const github = env.GITHUB_ENABLED === "true";
  const magicLink = env.MAGIC_LINK_ENABLED === "true";
  const emailProvider = z
    .enum(["smtp", "resend"])
    .parse(env.EMAIL_PROVIDER ?? "smtp");
  const publicUrl = env.PUBLIC_URL?.replace(/\/$/, "");
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error(
        "PUBLIC_URL must be an HTTPS origin (localhost HTTP is allowed)",
      );
  }
  if ((github || magicLink) && !publicUrl)
    throw new Error("PUBLIC_URL is required for browser sign-in");
  if (
    emailProvider === "resend" &&
    (!env.RESEND_API_KEY ||
      !env.RESEND_FROM ||
      !env.SEND_EMAIL_HOOK_SECRET ||
      !publicUrl)
  )
    throw new Error(
      "Resend requires RESEND_API_KEY, RESEND_FROM, SEND_EMAIL_HOOK_SECRET and PUBLIC_URL",
    );
  return {
    mode,
    password,
    github,
    magicLink,
    emailProvider,
    publicUrl,
    trustProxy: env.TRUST_PROXY === "true",
  };
}

export type AuthSettings = ReturnType<typeof authSettings>;
export const mcpEmailRedirect = (origin: string) =>
  new URL("/mcp/connect", origin).href;
export function authClientIp(
  req: IncomingMessage,
  settings: AuthSettings,
): string {
  const forwarded = req.headers["x-forwarded-for"];
  const candidate =
    settings.trustProxy && typeof forwarded === "string"
      ? forwarded.split(",").at(-1)!.trim()
      : "";
  return isIP(candidate) ? candidate : (req.socket.remoteAddress ?? "unknown");
}
export type EmailHook = (
  payload: string,
  headers: IncomingMessage["headers"],
) => Promise<void>;

const emailEvent = z.object({
  user: z.object({ email: z.email() }),
  email_data: z.object({
    token: z.string().regex(/^\d{6,10}$/),
    token_hash: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(256),
    email_action_type: z.enum(["signup", "magiclink", "recovery", "invite"]),
    redirect_to: z.string(),
  }),
});

export function createEmailHook(
  settings: AuthSettings,
  env: NodeJS.ProcessEnv = process.env,
  resend = new Resend(env.RESEND_API_KEY, { baseUrl: env.RESEND_API_URL }),
): EmailHook {
  const verifier = new Webhook(env.SEND_EMAIL_HOOK_SECRET!.replace(/^v1,/, ""));
  return async (payload, headers) => {
    const signedHeaders = Object.fromEntries(
      ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => [
        name,
        typeof headers[name] === "string" ? headers[name] : "",
      ]),
    );
    let verified: unknown;
    try {
      verified = verifier.verify(payload, signedHeaders);
    } catch {
      throw new HttpError(401, "Invalid email hook signature");
    }
    const { user, email_data: email } = emailEvent.parse(verified);
    const pluginCode =
      email.redirect_to === mcpEmailRedirect(settings.publicUrl!);
    // The desktop starts every flow with PKCE. Never trust a hook's redirect URL.
    const link = new URL(`${settings.publicUrl}/auth/confirm`);
    link.search = new URLSearchParams({
      token: email.token_hash,
      type: email.email_action_type,
      redirect_to: safeDesktopRedirect(email.redirect_to),
    }).toString();
    const { error } = await resend.emails.send(
      {
        from: env.RESEND_FROM!,
        to: user.email,
        subject: "Sign in to Orka",
        text: pluginCode
          ? `Enter this code on the Orka connection page: ${email.token}\n\nThis code expires in 10 minutes and can be used once. If you did not request it, ignore this email.`
          : `Open this link on the Mac where you requested it:\n${link}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
        html: pluginCode
          ? `<p>Enter this code on the Orka connection page:</p><h1>${email.token}</h1><p>This code expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>`
          : `<p>Open this link on the Mac where you requested it:</p><p><a href="${link.toString().replaceAll("&", "&amp;")}">Sign in to Orka</a></p><p>This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>`,
      },
      {
        signal: AbortSignal.timeout(4000),
        idempotencyKey: `orka-auth-${createHash("sha256").update(payload).digest("hex")}`,
      },
    );
    if (error)
      throw new HttpError(
        503,
        "Sign-in email could not be sent. Try again shortly.",
      );
  };
}

/** Only these public GoTrue routes are reachable; admin and user mutation stay private. */
export async function proxyAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authUrl: string,
  readBody: () => Promise<Buffer>,
  settings: AuthSettings,
  method = req.method,
) {
  const path = url.pathname.slice(5);
  const post =
    ["/otp", "/verify", "/token", "/logout"].includes(path) &&
    method === "POST";
  const get =
    ["/authorize", "/callback", "/verify"].includes(path) && method === "GET";
  if (!post && !get) throw new HttpError(404, "Not found");
  if (["/otp", "/verify"].includes(path) && !settings.magicLink)
    throw new HttpError(404, "Email sign-in is not enabled on this service");
  if (
    path === "/token" &&
    url.searchParams.get("grant_type") === "password" &&
    !settings.password
  )
    throw new HttpError(404, "Password sign-in is not enabled on this service");
  if (path === "/authorize") {
    if (!settings.github)
      throw new HttpError(404, "GitHub sign-in is not enabled on this service");
    if (
      url.searchParams.get("provider") !== "github" ||
      url.searchParams.get("redirect_to") !==
        safeDesktopRedirect(url.searchParams.get("redirect_to")) ||
      url.searchParams.get("code_challenge_method") !== "s256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "")
    )
      throw new HttpError(400, "Invalid sign-in request");
    // Do not forward arbitrary OAuth scopes or redirect overrides.
    for (const key of [...url.searchParams.keys()])
      if (
        ![
          "provider",
          "redirect_to",
          "code_challenge",
          "code_challenge_method",
        ].includes(key)
      )
        url.searchParams.delete(key);
  }
  if (path === "/otp" || (path === "/verify" && get))
    url.searchParams.set(
      "redirect_to",
      safeDesktopRedirect(url.searchParams.get("redirect_to")),
    );
  const clientIp = authClientIp(req, settings);
  const response = await fetch(authUrl.replace(/\/$/, "") + path + url.search, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Orka-Client-IP": clientIp,
      ...(req.headers.authorization
        ? { Authorization: req.headers.authorization }
        : {}),
      ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
    },
    body: post ? (await readBody()).toString() : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = await response.text();
  if (path === "/otp") {
    let body: { error_code?: string } = {};
    try {
      body = JSON.parse(responseBody) as typeof body;
    } catch {
      /* Preserve upstream failures below. */
    }
    if (
      response.ok ||
      ["user_not_found", "signup_disabled", "email_exists"].includes(
        body.error_code ?? "",
      )
    ) {
      res.statusCode = 200;
      res.end("{}");
      return;
    }
  }
  res.statusCode = response.status;
  for (const header of ["location", "content-type", "retry-after"])
    if (response.headers.has(header))
      res.setHeader(header, response.headers.get(header)!);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end(responseBody);
}
