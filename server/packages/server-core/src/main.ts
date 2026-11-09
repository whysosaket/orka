import { getProfile, putProfile, remoteKey } from "./profiles.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import {
  change,
  resolution,
  sessionCopy,
  uuid,
  digest,
} from "@portable/protocol";
import { bytesHash } from "./blobs.js";
import { Store, HttpError } from "./store.js";
import {
  authSettings,
  proxyAuth,
  mcpEmailRedirect,
  type AuthSettings,
  type EmailHook,
} from "./auth.js";
import { confirmEmail } from "./email-confirmation.js";
import { showProjectInvite } from "./project-invite.js";
import { envAction } from "./env.js";
import { listProjects, mutateProject } from "./projects.js";
import { addSources } from "./sources.js";
import { appendManagementLog } from "./management-log.js";
import { governanceAction, pullAuthorized } from "./governance.js";
import { createMcpApp, isMcpPath } from "./mcp/server.js";
import { shareSelected } from "./selected-sharing.js";
async function bytes(req: IncomingMessage, limit = 8_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request exceeds size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await bytes(req)).toString());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON");
  }
}
export type Authenticate = (token: string) => Promise<string>;
export function createApi(
  store: Store,
  authenticate: Authenticate,
  authUrl?: string,
  settings: AuthSettings = authSettings({}),
  emailHook?: EmailHook,
  mcpEnabled = false,
) {
  const mcp = mcpEnabled
    ? createMcpApp(store, authenticate, settings, authUrl)
    : undefined;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url ?? "/", "http://localhost"),
        path = url.pathname;
      if (mcp && isMcpPath(path)) {
        mcp(req, res);
        return;
      }
      if (path === "/v2/instance" && req.method === "GET") {
        res.end(
          JSON.stringify({
            version: 1,
            onboarding: 1,
            profile: {
              version: 2,
              jobRole: true,
              avatarUpload: true,
              conditionalSave: 1,
            },
            mode: settings.mode,
            auth: {
              password: settings.password,
              github: settings.github,
              magicLink: settings.magicLink,
              profileRedirect: true,
            },
          }),
        );
        return;
      }
      if (
        path === "/auth/hooks/send-email" &&
        req.method === "POST" &&
        emailHook
      ) {
        await emailHook((await bytes(req, 64_000)).toString(), req.headers);
        res.end("{}");
        return;
      }
      if (path === "/email-template" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const desktopEmail =
          '<p>Open this link on the Mac where you requested it:</p><p><a href="{{ .ConfirmationURL }}">Sign in to Orka</a></p><p>This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>';
        res.end(
          `<html><body>${mcpEnabled && settings.publicUrl ? `{{ if eq .RedirectTo "${mcpEmailRedirect(settings.publicUrl)}" }}<p>Enter this code on the Orka connection page:</p><h1>{{ .Token }}</h1><p>This code expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>{{ else }}${desktopEmail}{{ end }}` : desktopEmail}</body></html>`,
        );
        return;
      }
      if (path === "/health") {
        await store.pool.query("select 1");
        res.end(JSON.stringify({ ok: true, version: 2 }));
        return;
      }
      if (path.startsWith("/join/") && settings.publicUrl) {
        await showProjectInvite(req, res, url, store, settings.publicUrl);
        return;
      }
      if (path === "/auth/confirm" && authUrl) {
        await confirmEmail(
          req,
          res,
          url,
          () => bytes(req, 4096),
          authUrl,
          settings,
        );
        return;
      }
      if (path.startsWith("/auth/") && authUrl) {
        await proxyAuth(
          req,
          res,
          url,
          authUrl,
          () => bytes(req, 64_000),
          settings,
        );
        return;
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) throw new HttpError(401, "Sign in required");
      const user = uuid.parse(await authenticate(token));
      let parsed: unknown;
      const json = async () => (parsed ??= await body(req));
      const scoped = [
        "/v2/sync/push",
        "/v2/sharing/selected",
        "/v2/sessions/resolve",
        "/v2/sessions/copy",
        "/v2/presence",
        "/v2/env/action",
        "/v2/governance/action",
        "/v2/projects/action",
        "/v2/projects/sources",
        "/v2/invites",
      ];
      let projectId =
        url.searchParams.get("projectId") ??
        (path.startsWith("/v2/blobs/") ? path.split("/")[3] : undefined);
      if (req.method === "POST" && scoped.includes(path)) {
        const value = (await json()) as {
          projectId?: string;
          input?: { projectId?: string };
          call?: {
            input?: {
              projectId?: string;
              version?: { manifest?: { projectId?: string } };
            };
          };
        };
        projectId =
          value.projectId ??
          value.input?.projectId ??
          value.call?.input?.projectId ??
          value.call?.input?.version?.manifest?.projectId;
      }
      if (
        projectId &&
        req.headers["x-orka-governance"] !== "1" &&
        (
          await store.pool.query(
            "select 1 from orka.projects p join orka.members m on m.project_id=p.id where p.id=$1 and m.user_id=$2 and p.governed",
            [uuid.parse(projectId), user],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "Update Orka to use this project's resource permissions",
        );
      let result: unknown;
      if (path === "/v2/env/capabilities" && req.method === "GET")
        result = { format: 1, maxPlaintextBytes: 1_000_000 };
      else if (path === "/v2/env/action" && req.method === "POST")
        result = await envAction(store, user, await json());
      else if (path === "/v2/profile" && req.method === "GET")
        result = await getProfile(store, user);
      else if (path === "/v2/profile" && req.method === "PUT")
        result = await putProfile(store, user, await json());
      else if (path === "/v2/projects/capabilities" && req.method === "GET")
        result = {
          lifecycle: 1,
          governance: 1,
          sources: 1,
          rename: 1,
          rolePolicies: 1,
          policyOperations: 1,
          deviceHardware: 1,
          selectedSharing: 1,
        };
      else if (path === "/v2/sharing/selected" && req.method === "POST")
        result = await shareSelected(store, user, await json());
      else if (path === "/v2/projects/sources" && req.method === "POST")
        result = await addSources(store, user, await json());
      else if (path === "/v2/governance/action" && req.method === "POST")
        result = await governanceAction(store, user, await json());
      else if (path === "/v2/projects/action" && req.method === "POST")
        result = await mutateProject(store, user, await json());
      else if (path === "/v2/projects" && req.method === "GET")
        result = await listProjects(
          store,
          user,
          url.searchParams.get("includeArchived") === "true",
        );
      else if (path === "/v2/projects" && req.method === "POST") {
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            governance: z.literal(1).optional(),
            remoteKey: remoteKey.optional(),
            requestId: uuid.optional(),
            rolePolicies: z.literal(1).optional(),
          })
          .strict()
          .parse(await json());
        result = {
          id: await store.createProject(
            user,
            input.name,
            input.governance === 1,
            input.remoteKey,
            input.requestId,
            true,
          ),
        };
      } else if (path === "/v2/invites" && req.method === "POST") {
        const { projectId } = z
          .object({ projectId: uuid })
          .strict()
          .parse(await json());
        result = await store.transaction(async (db) => {
          await db.query("select id from orka.projects where id=$1 for share", [
            projectId,
          ]);
          await store.member(user, projectId, db);
          if (
            !(
              await db.query(
                "select 1 from orka.members m join orka.projects p on p.id=m.project_id where m.project_id=$1 and m.user_id=$2 and (m.role='owner' or (m.role='admin' and p.role_policies is not null))",
                [projectId, user],
              )
            ).rowCount
          )
            throw new HttpError(403, "Only project owners can invite members");
          const token = randomBytes(24).toString("hex");
          await db.query(
            "insert into orka.invites values($1,$2,now()+interval '1 day')",
            [createHash("sha256").update(token).digest("hex"), projectId],
          );
          await appendManagementLog(
            db,
            projectId,
            { action: "invite.created", actor: user },
            true,
          );
          return {
            token,
            ...(settings.publicUrl
              ? { url: `${settings.publicUrl}/join/${token}` }
              : {}),
          };
        });
      } else if (path === "/v2/join" && req.method === "POST") {
        const { token } = z
          .object({ token: z.string().regex(/^[a-f0-9]{48}$/) })
          .strict()
          .parse(await json());
        result = await store.transaction(async (db) => {
          const tokenHash = createHash("sha256").update(token).digest("hex");
          const candidate = (
            await db.query(
              "select project_id from orka.invites where token_hash=$1",
              [tokenHash],
            )
          ).rows[0];
          if (!candidate)
            throw new HttpError(400, "Invite expired or already used");
          const project = await db.query(
            "select id,governed from orka.projects where id=$1 and archived_at is null for update",
            [candidate.project_id],
          );
          if (!project.rowCount)
            throw new HttpError(403, "Project access denied");
          if (
            project.rows[0].governed &&
            req.headers["x-orka-governance"] !== "1"
          )
            throw new HttpError(
              409,
              "Update Orka to join a project with resource permissions",
            );
          const invite = await db.query(
            "delete from orka.invites where token_hash=$1 and expires_at>now() returning project_id",
            [tokenHash],
          );
          if (!invite.rowCount)
            throw new HttpError(400, "Invite expired or already used");
          const added = await db.query(
            "insert into orka.members values($1,$2,'member') on conflict do nothing returning user_id",
            [invite.rows[0].project_id, user],
          );
          if (added.rowCount) {
            await appendManagementLog(
              db,
              invite.rows[0].project_id,
              { action: "member.joined", actor: user, subject: user },
              true,
            );
            await db.query(
              "update orka.projects set policy_revision=policy_revision+1 where id=$1 and governed",
              [invite.rows[0].project_id],
            );
          }
          return { id: invite.rows[0].project_id };
        });
      } else if (path === "/v2/devices" && req.method === "POST") {
        const { id, name, hardwareFamily } = z
          .object({
            id: uuid,
            name: z.string().min(1).max(100),
            hardwareFamily: z
              .enum([
                "laptop",
                "all-in-one",
                "mac-mini",
                "mac-studio",
                "mac-pro",
                "generic",
              ])
              .optional(),
          })
          .strict()
          .parse(await json());
        await store.device(user, id, name, hardwareFamily);
        result = { ok: true };
      } else if (path === "/v2/devices" && req.method === "GET")
        result = (
          await store.pool.query(
            'select id,name,last_seen as seen_at,hardware_family as "hardwareFamily" from orka.devices where owner=$1 order by name',
            [user],
          )
        ).rows;
      else if (path === "/v2/sync/push" && req.method === "POST")
        result = await store.mutate(user, change.parse(await json()));
      else if (path === "/v2/sessions/resolve" && req.method === "POST")
        result = await store.resolve(user, resolution.parse(await json()));
      else if (path === "/v2/sessions/copy" && req.method === "POST")
        result = await store.copy(user, sessionCopy.parse(await json()));
      else if (path === "/v2/sync/pull" && req.method === "GET") {
        const projectId = uuid.parse(url.searchParams.get("projectId")),
          cursor = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(url.searchParams.get("cursor") ?? 0);
        result = await pullAuthorized(
          store,
          user,
          projectId,
          cursor,
          Number(url.searchParams.get("policyRevision") ?? -1),
          url.searchParams.get("governance") === "1",
        );
        await store.pool.query(
          "update orka.projects set last_sync_at=now() where id=$1",
          [projectId],
        );
      } else if (path === "/v2/presence" && req.method === "POST") {
        const input = z
          .object({
            projectId: uuid,
            deviceId: uuid,
            sessions: z.array(uuid).max(100),
          })
          .strict()
          .parse(await json());
        await store.member(user, input.projectId);
        await store.transaction(async (db) => {
          await db.query("select id from orka.projects where id=$1 for share", [
            input.projectId,
          ]);
          await store.member(user, input.projectId, db);
          await store.checkDevice(db, user, input.deviceId);
          await db.query(
            "delete from orka.presence where project_id=$1 and device_id=$2",
            [input.projectId, input.deviceId],
          );
          for (const id of input.sessions) {
            if (
              (await store.permissions.project(db, input.projectId, user))
                .governed &&
              !(await store.permissions.canRead(user, input.projectId, id, db))
            )
              throw new HttpError(403, "Session access denied");
            await db.query(
              "insert into orka.presence values($1,$2,$3,$4,now())",
              [input.projectId, id, input.deviceId, user],
            );
          }
        });
        result = { ok: true };
      } else if (path.match(/^\/v2\/blobs\/[^/]+\/[^/]+$/)) {
        const [, , , rawProject, rawHash] = path.split("/"),
          projectId = uuid.parse(rawProject),
          hash = digest.parse(rawHash);
        await store.member(user, projectId);
        if (req.method === "PUT") {
          const content = await bytes(req, 128 * 1024 * 1024);
          if (bytesHash(content) !== hash)
            throw new HttpError(400, "Blob hash mismatch");
          await store.transaction(async (db) => {
            await db.query(
              "select id from orka.projects where id=$1 for share",
              [projectId],
            );
            await store.member(user, projectId, db);
            await store.blobs.put(projectId, content);
            await db.query(
              "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
              [projectId, hash, user],
            );
            await db.query(
              "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
              [projectId, hash, content.length],
            );
          });
          result = { hash };
        } else if (req.method === "GET") {
          const content = await store.transaction(async (db) => {
            await db.query(
              "select id from orka.projects where id=$1 for share",
              [projectId],
            );
            await store.member(user, projectId, db);
            if (
              !(
                await db.query(
                  "select 1 from orka.blobs where project_id=$1 and hash=$2",
                  [projectId, hash],
                )
              ).rowCount
            )
              throw new HttpError(404, "Blob not found");
            if (!(await store.permissions.blob(user, projectId, hash, db)))
              throw new HttpError(404, "Blob not found");
            return store.blobs.read(projectId, hash);
          });
          res.setHeader("Content-Type", "application/octet-stream");
          res.end(content);
          return;
        } else throw new HttpError(404, "Not found");
      } else throw new HttpError(404, "Not found");
      res.end(JSON.stringify(result));
    } catch (e) {
      const status =
        e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500;
      res.statusCode = status;
      res.end(
        JSON.stringify({
          error:
            status === 500
              ? "Service unavailable"
              : e instanceof z.ZodError
                ? "Invalid request"
                : (e as Error).message,
        }),
      );
      if (status === 500)
        console.error("request_failed", { method: req.method, status });
    }
  };
  return createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      console.error("request_aborted", { method: req.method });
      res.destroy();
    });
  });
}
