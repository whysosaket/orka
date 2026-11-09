import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
  InvalidClientMetadataError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
import { Store, HttpError } from "../store.js";
import type { Authenticate } from "../main.js";
import { authClientIp, mcpEmailRedirect, type AuthSettings } from "../auth.js";

export const MCP_SCOPE = "orka.read";
const secret = () => randomBytes(32).toString("base64url");
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
type Pending = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
};
type Code = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  resource: string;
};
const cookieName = (tx: string) => `orka_mcp_${tx.slice(0, 16)}`;

export class OrkaOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: URL;
  constructor(
    private store: Store,
    readonly origin: string,
    private authenticate: Authenticate,
    private settings: AuthSettings,
    private authUrl?: string,
  ) {
    this.resource = new URL("/mcp", origin);
    this.clientsStore = {
      getClient: async (id) =>
        (
          await store.pool.query<{ metadata: OAuthClientInformationFull }>(
            "select metadata from orka.mcp_clients where id=$1",
            [id],
          )
        ).rows[0]?.metadata,
      registerClient: async (client) => {
        if (
          !client.redirect_uris.length ||
          client.redirect_uris.length > 10 ||
          client.redirect_uris.some((raw) => {
            const u = new URL(raw);
            return Boolean(
              u.username ||
              u.password ||
              u.hash ||
              /[\s;'"<>]/.test(u.origin) ||
              (u.protocol !== "https:" &&
                !(
                  u.protocol === "http:" &&
                  ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
                )),
            );
          }) ||
          !["none", "client_secret_post"].includes(
            client.token_endpoint_auth_method ?? "client_secret_post",
          )
        )
          throw new InvalidClientMetadataError(
            "Use HTTPS or a native loopback redirect and a supported token authentication method",
          );
        if (client.scope && client.scope !== MCP_SCOPE)
          throw new InvalidClientMetadataError("Only orka.read is supported");
        const registered = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          scope: MCP_SCOPE,
        };
        await store.pool.query("insert into orka.mcp_clients values($1,$2)", [
          registered.client_id,
          registered,
        ]);
        return registered;
      },
    };
  }

  private checkResource(resource?: URL) {
    if (resource?.href !== this.resource.href)
      throw new InvalidRequestError(
        "The resource parameter must identify this Orka MCP server",
      );
  }
  private scopes(scopes?: string[]) {
    if (scopes?.length && (scopes.length !== 1 || scopes[0] !== MCP_SCOPE))
      throw new InvalidScopeError("Only orka.read is supported");
  }
  private cookie(tx: string, value: string, expired = false) {
    return `${cookieName(tx)}=${value}; HttpOnly; SameSite=Lax; Path=/mcp/connect; Max-Age=${expired ? 0 : 600}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    this.checkResource(params.resource);
    this.scopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("A valid S256 PKCE challenge is required");
    const tx = secret(),
      cookie = secret();
    await this.store.pool.query(
      "delete from orka.mcp_pending where expires_at<now()",
    );
    await this.store.pool.query(
      "delete from orka.mcp_codes where expires_at<now()",
    );
    await this.store.pool.query(
      "delete from orka.mcp_tokens where refresh_expires_at<now()",
    );
    await this.store.pool.query(
      "insert into orka.mcp_pending values($1,$2,$3,now()+interval '10 minutes')",
      [
        tokenHash(tx),
        tokenHash(cookie),
        {
          client: {
            client_id: client.client_id,
            client_name: client.client_name,
            redirect_uris: client.redirect_uris,
          },
          params: { ...params, resource: params.resource!.href },
        },
      ],
    );
    res.setHeader("Set-Cookie", this.cookie(tx, cookie));
    this.page(
      res,
      tx,
      client.client_name ?? "Connected assistant",
      "",
      "",
      200,
      params.redirectUri,
    );
  }

  private page(
    res: Response,
    tx: string,
    clientName: string,
    notice = "",
    email = "",
    status = 200,
    redirectUri?: string,
  ) {
    res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
    // no-referrer can serialize a browser form POST's Origin as null. Keep
    // same-origin provenance for CSRF validation while stripping cross-site refs.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectUri ? " " + new URL(redirectUri).origin : ""}; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    const emailSignIn = this.settings.magicLink
      ? '<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}"><button name="action" value="send-code" formnovalidate>Send email code</button>'
      : "";
    const passwordSignIn = this.settings.password
      ? '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">'
      : "";
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Orka</title><style>body{margin:0;background:#0a0a0a;color:#ededed;font:16px/1.5 system-ui;min-height:100vh;display:grid;place-items:center}main{box-sizing:border-box;width:min(480px,calc(100% - 32px));padding:28px;border:1px solid #303030;border-radius:12px;background:#141414}h1{font-size:24px}p{color:#b9b9b9;overflow-wrap:anywhere}label{display:block;margin-top:14px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:10px;border-radius:6px;border:1px solid #555;margin-top:6px}input{background:#202020;color:#fff}button{cursor:pointer;background:#eee;color:#111;margin-top:16px}button[value=cancel]{background:transparent;color:#ccc}input:focus-visible,button:focus-visible{outline:2px solid white;outline-offset:3px}.notice{color:#fff}</style></head><body><main><h1>Connect Orka</h1><p>Allow <strong>${escape(clientName)}</strong> to read the project knowledge and shared sessions your Orka account can access, and prepare handoffs for Claude Code.</p><p>This connection can read shared data. It cannot change project content, permissions, or ENV sets.</p>${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""}<form method="post" action="/mcp/connect"><input type="hidden" name="transaction" value="${escape(tx)}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" value="${escape(email)}" required>${emailSignIn}${passwordSignIn}<button name="action" value="connect">Connect Orka</button><button name="action" value="cancel" formnovalidate>Cancel</button></form><p>Connected service: ${escape(this.origin)}</p></main></body></html>`,
    );
  }

  async connect(req: Request, res: Response) {
    if (req.headers.origin !== this.origin)
      throw new HttpError(403, "Open the original connection page to continue");
    const form = z
      .object({
        transaction: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        action: z.enum(["connect", "send-code", "cancel"]),
        email: z.string().max(320).optional(),
        password: z.string().max(1024).optional(),
        code: z.string().max(10).optional(),
      })
      .strict()
      .parse(req.body);
    const row = (
      await this.store.pool.query<{ cookie_hash: string; payload: Pending }>(
        "select cookie_hash,payload from orka.mcp_pending where hash=$1 and expires_at>now()",
        [tokenHash(form.transaction)],
      )
    ).rows[0];
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName(form.transaction) + "="))
      ?.split("=")[1];
    if (!row || !cookie || tokenHash(cookie) !== row.cookie_hash)
      throw new HttpError(
        403,
        "Connection expired. Start again from your assistant.",
      );
    const pending = row.payload;
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined)
      redirect.searchParams.set("state", pending.params.state);
    redirect.searchParams.set("iss", this.origin + "/");
    if (form.action === "cancel") {
      await this.store.pool.query(
        "delete from orka.mcp_pending where hash=$1",
        [tokenHash(form.transaction)],
      );
      res.setHeader("Set-Cookie", this.cookie(form.transaction, "", true));
      redirect.searchParams.set("error", "access_denied");
      res.redirect(303, redirect.href);
      return;
    }
    const email = z.email().parse(form.email);
    if (!this.authUrl) throw new HttpError(503, "Orka sign-in is unavailable");
    const password = Boolean(form.password);
    if (
      (form.action === "send-code" && !this.settings.magicLink) ||
      (form.action === "connect" && password && !this.settings.password) ||
      (form.action === "connect" && !password && !this.settings.magicLink)
    )
      throw new HttpError(400, "This sign-in method is unavailable");
    if (
      form.action === "connect" &&
      !password &&
      !/^\d{6,10}$/.test(form.code ?? "")
    ) {
      this.page(
        res,
        form.transaction,
        pending.client.client_name ?? "Connected assistant",
        "Enter your email code or password.",
        email,
        400,
        pending.params.redirectUri,
      );
      return;
    }
    const path =
      form.action === "send-code"
        ? "/otp?" +
          new URLSearchParams({ redirect_to: mcpEmailRedirect(this.origin) })
        : password
          ? "/token?grant_type=password"
          : "/verify";
    const body =
      form.action === "send-code"
        ? { email, create_user: false }
        : password
          ? { email, password: form.password }
          : { email, token: form.code, type: "email" };
    const response = await fetch(this.authUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orka-Client-IP": authClientIp(req, this.settings),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (form.action === "send-code") {
      this.page(
        res,
        form.transaction,
        pending.client.client_name ?? "Connected assistant",
        response.ok
          ? "Check your email and enter the sign-in code here."
          : "Could not send a code. Try again shortly.",
        email,
        response.ok ? 200 : 400,
        pending.params.redirectUri,
      );
      return;
    }
    if (!response.ok) {
      this.page(
        res,
        form.transaction,
        pending.client.client_name ?? "Connected assistant",
        "Could not sign in. Check your credentials or request a fresh email code.",
        email,
        400,
        pending.params.redirectUri,
      );
      return;
    }
    const session = (await response.json()) as { access_token?: string };
    if (!session.access_token)
      throw new HttpError(502, "Orka sign-in did not return a session");
    const user = z.uuid().parse(await this.authenticate(session.access_token));
    const code = secret();
    await this.store.transaction(async (db) => {
      const consumed = await db.query(
        "delete from orka.mcp_pending where hash=$1 and expires_at>now() returning hash",
        [tokenHash(form.transaction)],
      );
      if (!consumed.rowCount)
        throw new HttpError(409, "This connection was already completed");
      await db.query(
        "insert into orka.mcp_codes values($1,$2,now()+interval '5 minutes')",
        [
          tokenHash(code),
          {
            clientId: pending.client.client_id,
            redirectUri: pending.params.redirectUri,
            codeChallenge: pending.params.codeChallenge,
            userId: user,
            resource: this.resource.href,
          } satisfies Code,
        ],
      );
    });
    res.setHeader("Set-Cookie", this.cookie(form.transaction, "", true));
    redirect.searchParams.set("code", code);
    res.redirect(303, redirect.href);
  }

  private async code(
    client: OAuthClientInformationFull,
    raw: string,
    db = this.store.pool,
  ): Promise<Code> {
    const code = (
      await db.query<{ payload: Code }>(
        "select payload from orka.mcp_codes where hash=$1 and expires_at>now()",
        [tokenHash(raw)],
      )
    ).rows[0]?.payload;
    if (!code || code.clientId !== client.client_id)
      throw new InvalidGrantError("Authorization code unavailable");
    return code;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return (await this.code(client, code)).codeChallenge;
  }

  private async issue(
    db: PoolClient,
    clientId: string,
    user: string,
    family: string = randomUUID(),
  ): Promise<OAuthTokens> {
    const access = secret(),
      refresh = secret();
    await db.query(
      "insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '30 days')",
      [
        tokenHash(access),
        tokenHash(refresh),
        family,
        clientId,
        user,
        this.resource.href,
      ],
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: MCP_SCOPE,
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    raw: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    return this.store.transaction(async (db) => {
      const result = await db.query<{ payload: Code }>(
        "delete from orka.mcp_codes where hash=$1 and expires_at>now() returning payload",
        [tokenHash(raw)],
      );
      const code = result.rows[0]?.payload;
      if (
        !code ||
        code.clientId !== client.client_id ||
        code.redirectUri !== redirectUri ||
        code.resource !== resource!.href
      )
        throw new InvalidGrantError("Authorization code binding changed");
      return this.issue(db, client.client_id, code.userId);
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    raw: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.checkResource(resource);
    this.scopes(scopes);
    const result = await this.store.transaction(async (db) => {
      if (!(await this.lockTokenFamily(db, client.client_id, raw))) return null;
      const row = (
        await db.query<{
          family: string;
          user_id: string;
          revoked: boolean;
          resource: string;
        }>(
          "select family,user_id,revoked,resource from orka.mcp_tokens where refresh_hash=$1 and client_id=$2 and refresh_expires_at>now() for update",
          [tokenHash(raw), client.client_id],
        )
      ).rows[0];
      if (!row || row.resource !== this.resource.href) return null;
      if (row.revoked) {
        await db.query(
          "update orka.mcp_tokens set revoked=true where family=$1",
          [row.family],
        );
        return null;
      }
      await db.query(
        "update orka.mcp_tokens set revoked=true where refresh_hash=$1",
        [tokenHash(raw)],
      );
      return this.issue(db, client.client_id, row.user_id, row.family);
    });
    if (!result)
      throw new InvalidGrantError(
        "Refresh token unavailable; connect Orka again",
      );
    return result;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = (
      await this.store.pool.query<{
        client_id: string;
        user_id: string;
        resource: string;
        expires: number;
      }>(
        "select client_id,user_id,resource,extract(epoch from access_expires_at)::bigint as expires from orka.mcp_tokens where access_hash=$1 and not revoked and access_expires_at>now()",
        [tokenHash(token)],
      )
    ).rows[0];
    if (!row || row.resource !== this.resource.href)
      throw new InvalidTokenError("Orka connection expired or was revoked");
    return {
      token,
      clientId: row.client_id,
      scopes: [MCP_SCOPE],
      expiresAt: Number(row.expires),
      resource: this.resource,
      extra: { userId: row.user_id },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    await this.store.transaction(async (db) => {
      const family = await this.lockTokenFamily(
        db,
        client.client_id,
        request.token,
      );
      if (family)
        await db.query(
          "update orka.mcp_tokens set revoked=true where family=$1",
          [family],
        );
    });
  }

  private async lockTokenFamily(
    db: PoolClient,
    clientId: string,
    token: string,
  ) {
    const family = (
      await db.query<{ family: string }>(
        "select family from orka.mcp_tokens where client_id=$1 and (access_hash=$2 or refresh_hash=$2)",
        [clientId, tokenHash(token)],
      )
    ).rows[0]?.family;
    if (family)
      // Take the family lock before row locks, then read/update in a fresh statement
      // so concurrent refreshes cannot issue tokens outside a revocation snapshot.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `mcp-token-family:${family}`,
      ]);
    return family;
  }
}
