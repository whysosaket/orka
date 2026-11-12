import { createHash } from "node:crypto";
import type { Resource } from "@portable/protocol";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthSettings } from "./auth.js";
import { orkaTools as definitions } from "../../packages/protocol/src/mcp.js";
import type { Store } from "./store.js";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class OrkaOAuth {
  readonly resource: URL;
  constructor(
    private store: Store,
    private origin: string,
    _authenticate: (token: string) => Promise<string>,
    _settings: AuthSettings,
  ) {
    void _authenticate;
    void _settings;
    this.resource = new URL("/mcp", origin);
  }
  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ) {
    return this.store.invoke<OAuthTokens>("oauth", {
      operation: "refresh",
      origin: this.origin,
      client,
      token,
      scope: scopes?.join(" "),
      resource: resource?.href,
    });
  }
  verifyAccessToken(token: string) {
    return this.store.invoke<AuthInfo>("oauth", {
      operation: "verify",
      origin: this.origin,
      token,
    });
  }
  revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    return this.store.invoke<void>("oauth", {
      operation: "revoke",
      origin: this.origin,
      client,
      token: request.token,
    });
  }
}
export class OrkaReader {
  constructor(
    private store: Store,
    private user: string,
    private origin: string,
  ) {}
  sessions(projectId: string, filter: unknown) {
    return this.run("list_sessions", {
      projectId,
      ...(filter as object),
    }) as Promise<{
      sessions: { id: string }[];
      nextCursor: number | { revision: number; resourceId: string } | null;
    }>;
  }
  run(name: string, input: unknown) {
    return this.store.invoke("reader", {
      name,
      input,
      user: this.user,
      origin: this.origin,
    });
  }
}
export const orkaTools = definitions.map((t) => ({
  ...t,
  run: (input: unknown, reader: OrkaReader) =>
    reader.run(t.name, t.schema.parse(input)),
}));
export const readSession = (store: Store, resource: Resource) =>
  store.invoke("readSession", { resource });
