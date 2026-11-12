import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Store } from "./store.js";
import { authSettings, type AuthSettings } from "./auth.js";
import type { GitHubRepositories } from "./github.js";

export function createApi(
  store: Store,
  authenticate: (token: string) => Promise<string>,
  authUrl?: string,
  settings: AuthSettings = authSettings({}),
  mcpEnabled = false,
  repositories?: GitHubRepositories,
) {
  store.authenticate = authenticate;
  if (repositories) store.githubFetcher = repositories.fetcher;
  const configured = store.invoke("configure", {
    settings,
    authUrl,
    environment: process.env,
    mcpEnabled,
    github: repositories
      ? {
          ...repositories.settings,
          encryptionKey: repositories.settings.encryptionKey.toString("base64"),
        }
      : undefined,
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await configured;
      const origin = await store.ready;
      const upstream = request(
        new URL(req.url ?? "/", origin),
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 500, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      });
      req.pipe(upstream);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  };
  return createServer((req, res) => {
    void handle(req, res);
  });
}
