import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Store } from "./store.js";
import {
  authSettings,
  type AuthSettings,
  type EmailHook,
} from "../reference/auth.js";
import type { Authenticate } from "../reference/main.js";

export function createApi(
  store: Store,
  authenticate: Authenticate,
  authUrl?: string,
  settings: AuthSettings = authSettings({}),
  _emailHook?: EmailHook,
  mcpEnabled = false,
) {
  store.authenticate = authenticate;
  const configured = store.invoke("configure", {
    settings,
    authUrl,
    environment: process.env,
    mcpEnabled,
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
