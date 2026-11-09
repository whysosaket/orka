import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  githubRepository,
  githubRepositoryId,
  type GitHubRepository,
} from "@portable/protocol";
import { Store, HttpError } from "./store.js";

export interface GitHubSettings {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  appSlug: string;
  encryptionKey: Buffer;
  webhookSecret: string;
}
export function githubSettings(env: NodeJS.ProcessEnv): GitHubSettings {
  const enabled = env.GITHUB_REPOS_ENABLED === "true";
  const settings = {
    enabled,
    clientId: env.GITHUB_REPOS_CLIENT_ID || env.GITHUB_CLIENT_ID || "",
    clientSecret:
      env.GITHUB_REPOS_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET || "",
    appSlug: env.GITHUB_REPOS_APP_SLUG ?? "",
    encryptionKey: Buffer.from(env.GITHUB_REPOS_TOKEN_KEY ?? "", "hex"),
    webhookSecret: env.GITHUB_REPOS_WEBHOOK_SECRET ?? "",
  };
  if (
    enabled &&
    (!/^Iv[A-Za-z0-9]+$/.test(settings.clientId) ||
      !settings.clientSecret ||
      !/^[a-z0-9-]+$/.test(settings.appSlug) ||
      !/^[a-f0-9]{64}$/i.test(env.GITHUB_REPOS_TOKEN_KEY ?? "") ||
      settings.webhookSecret.length < 32)
  )
    throw new Error(
      "GitHub repositories require GitHub App GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (or migration overrides), GITHUB_REPOS_APP_SLUG, a 64-hex GITHUB_REPOS_TOKEN_KEY and GITHUB_REPOS_WEBHOOK_SECRET (at least 32 characters)",
    );
  return settings;
}

const credentials = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
const providerRepository = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string(),
  default_branch: z.string().nullable(),
  private: z.boolean(),
});
const sourceInput = z.object({ projectId: z.uuid(), sourceId: z.uuid() });
const activeStatuses = ["requested", "waiting_on_github", "invitation_pending"];

export class GitHubRepositories {
  constructor(
    private store: Store,
    readonly settings: GitHubSettings,
    private fetcher: typeof fetch = fetch,
  ) {}
  get installationUrl() {
    return `https://github.com/apps/${this.settings.appSlug}/installations/new`;
  }
  private requireEnabled() {
    if (!this.settings.enabled)
      throw new HttpError(
        404,
        "GitHub repositories are not enabled on this service",
      );
  }
  private seal(value: unknown, context: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.settings.encryptionKey, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  private unseal(value: string, context: string): unknown {
    try {
      const bytes = Buffer.from(value, "base64"),
        cipher = createDecipheriv(
          "aes-256-gcm",
          this.settings.encryptionKey,
          bytes.subarray(0, 12),
        );
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          cipher.update(bytes.subarray(28)),
          cipher.final(),
        ]).toString(),
      );
    } catch {
      throw new HttpError(
        503,
        "GitHub credentials could not be opened; check the service token key",
      );
    }
  }
  private async call(
    path: string,
    token?: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    basic = false,
  ) {
    const oauth = path.startsWith("/login/");
    let response: Response;
    try {
      response = await this.fetcher(
        `${oauth ? "https://github.com" : "https://api.github.com"}${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token
              ? { Authorization: `${basic ? "Basic" : "Bearer"} ${token}` }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    } catch {
      throw new HttpError(503, "GitHub is unavailable; try again shortly");
    }
    if (!response.ok) {
      const status = response.status;
      throw new HttpError(
        status >= 500
          ? 503
          : status === 401
            ? 401
            : status === 429 ||
                response.headers.get("x-ratelimit-remaining") === "0"
              ? 429
              : 403,
        status >= 500
          ? "GitHub is unavailable; try again shortly"
          : status === 401
            ? "Reconnect GitHub to continue"
            : status === 429 ||
                response.headers.get("x-ratelimit-remaining") === "0"
              ? "GitHub rate limit reached; try again later"
              : "Repository access unavailable. Check GitHub membership, app selection and organization SSO.",
      );
    }
    if (response.status === 204) return {};
    return response.json() as Promise<unknown>;
  }
  private async token(user: string) {
    return this.store.transaction(async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `github:${user}`,
      ]);
      const row = (
        await db.query(
          "select * from orka.github_connections where user_id=$1 for update",
          [user],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, "Connect GitHub to continue");
      let value = credentials.parse(this.unseal(row.credentials, user));
      if (new Date(row.expires_at).getTime() < Date.now() + 60_000) {
        const result = await this.call("/login/oauth/access_token", undefined, {
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          grant_type: "refresh_token",
          refresh_token: value.refresh_token,
        });
        const refreshed = credentials.safeParse(result);
        if (!refreshed.success)
          throw new HttpError(
            409,
            "GitHub authorization expired; connect GitHub again",
          );
        value = refreshed.data;
        await db.query(
          "update orka.github_connections set credentials=$2,expires_at=now()+$3*interval '1 second' where user_id=$1",
          [user, this.seal(value, user), value.expires_in],
        );
      }
      return {
        accessToken: value.access_token,
        githubId: row.github_id as string,
        login: row.login as string,
      };
    });
  }
  private normalize(raw: unknown): GitHubRepository {
    const repo = providerRepository.parse(raw);
    const fullName = githubRepository.shape.fullName.parse(repo.full_name);
    return githubRepository.parse({
      id: String(repo.id),
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      defaultBranch: repo.default_branch,
      private: repo.private,
    });
  }
  private async repository(user: string, repositoryId: string) {
    const auth = await this.token(user);
    const repository = this.normalize(
      await this.call(
        `/repositories/${githubRepositoryId.parse(repositoryId)}`,
        auth.accessToken,
      ),
    );
    if (repository.id !== repositoryId)
      throw new HttpError(
        409,
        "Repository identity changed; refresh and try again",
      );
    return { repository, auth };
  }
  private async source(user: string, raw: unknown, owner = false) {
    const input = sourceInput.parse(raw);
    await this.store.member(user, input.projectId);
    const row = (
      await this.store.pool.query(
        "select s.id,r.repository,r.revision,m.role from orka.project_sources s join orka.members m on m.project_id=s.project_id and m.user_id=$3 left join orka.source_repositories r on r.project_id=s.project_id and r.source_id=s.id where s.project_id=$1 and s.id=$2",
        [input.projectId, input.sourceId, user],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(404, "Source no longer belongs to this project");
    if (owner && row.role !== "owner")
      throw new HttpError(403, "Only project owners can link repositories");
    return { ...input, row };
  }
  private async expireRequests(projectId: string) {
    await this.store.pool.query(
      "update orka.repository_access_requests set status='expired',revision=revision+1,updated_at=now() where project_id=$1 and status=any($2::text[]) and created_at<now()-interval '30 days'",
      [projectId, activeStatuses],
    );
  }
  async webhook(
    raw: Buffer,
    signature: string,
    delivery: string,
    event: string,
  ) {
    this.requireEnabled();
    const expected = `sha256=${createHmac("sha256", this.settings.webhookSecret).update(raw).digest("hex")}`;
    if (
      !/^sha256=[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new HttpError(401, "Invalid GitHub webhook signature");
    z.uuid().parse(delivery);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      throw new HttpError(400, "Invalid webhook JSON");
    }
    await this.store.transaction(async (db) => {
      if (
        !(
          await db.query(
            "insert into orka.github_webhook_deliveries(id) values($1) on conflict do nothing returning id",
            [delivery],
          )
        ).rowCount
      )
        return;
      if (
        event === "github_app_authorization" &&
        payload.action === "revoked"
      ) {
        const sender = z
          .object({ id: z.number().int().positive().safe() })
          .parse(payload.sender);
        await db.query(
          "delete from orka.github_authorizations where user_id in (select user_id from orka.github_connections where github_id=$1)",
          [String(sender.id)],
        );
        await db.query(
          "delete from orka.github_connections where github_id=$1",
          [String(sender.id)],
        );
      }
      await db.query(
        "delete from orka.github_webhook_deliveries where created_at<now()-interval '30 days'",
      );
    });
    return { ok: true };
  }
  async action(user: string, raw: unknown): Promise<unknown> {
    this.requireEnabled();
    const input = z
      .object({ action: z.string(), input: z.unknown().optional() })
      .strict()
      .parse(raw);
    if (input.action === "status") {
      const connection = (
        await this.store.pool.query(
          "select github_id as id,login from orka.github_connections where user_id=$1",
          [user],
        )
      ).rows[0];
      return {
        connected: Boolean(connection),
        identity: connection ?? null,
        installationUrl: this.installationUrl,
      };
    }
    if (input.action === "begin") {
      const device = z
        .object({
          device_code: z.string(),
          user_code: z.string(),
          verification_uri: z.literal("https://github.com/login/device"),
          expires_in: z.number().int().min(1).max(1800),
          interval: z.number().int().min(1).max(60),
        })
        .parse(
          await this.call("/login/device/code", undefined, {
            client_id: this.settings.clientId,
            scope: "offline_access",
          }),
        );
      const id = randomUUID(),
        interval = Math.max(5, device.interval);
      await this.store.transaction(async (db) => {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `github:${user}`,
        ]);
        await db.query(
          "delete from orka.github_authorizations where user_id=$1 or expires_at<now()",
          [user],
        );
        await db.query(
          "insert into orka.github_authorizations values($1,$2,$3,now()+$4*interval '1 second',now()+$5*interval '1 second',$5)",
          [
            id,
            user,
            this.seal(device.device_code, `${user}:${id}`),
            device.expires_in,
            interval,
          ],
        );
      });
      return {
        id,
        userCode: device.user_code,
        verificationUrl: device.verification_uri,
        interval,
        expiresIn: device.expires_in,
      };
    }
    if (input.action === "poll") {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input.input);
      return this.store.transaction(async (db) => {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `github:${user}`,
        ]);
        const row = (
          await db.query(
            "select * from orka.github_authorizations where id=$1 and user_id=$2 for update",
            [id, user],
          )
        ).rows[0];
        if (!row || new Date(row.expires_at).getTime() <= Date.now())
          throw new HttpError(410, "GitHub authorization expired; start again");
        if (new Date(row.next_poll_at).getTime() > Date.now())
          return { pending: true, interval: row.poll_interval };
        const result = await this.call("/login/oauth/access_token", undefined, {
          client_id: this.settings.clientId,
          device_code: this.unseal(row.device_code, `${user}:${id}`),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        const pending = z.object({ error: z.string() }).safeParse(result);
        if (pending.success) {
          if (
            !["authorization_pending", "slow_down"].includes(pending.data.error)
          ) {
            await db.query(
              "delete from orka.github_authorizations where id=$1",
              [id],
            );
            return {
              pending: false,
              error: "GitHub authorization declined or expired; start again",
            };
          }
          const interval = Math.min(
            120,
            Number(row.poll_interval) +
              (pending.data.error === "slow_down" ? 5 : 0),
          );
          await db.query(
            "update orka.github_authorizations set next_poll_at=now()+$2*interval '1 second',poll_interval=$2 where id=$1",
            [id, interval],
          );
          return { pending: true, interval };
        }
        const value = credentials.parse(result);
        const identity = z
          .object({
            id: z.number().int().positive().safe(),
            login: z.string().min(1).max(100),
          })
          .parse(await this.call("/user", value.access_token));
        await db.query(
          "insert into orka.github_connections values($1,$2,$3,$4,now()+$5*interval '1 second') on conflict(user_id) do update set github_id=excluded.github_id,login=excluded.login,credentials=excluded.credentials,expires_at=excluded.expires_at",
          [
            user,
            String(identity.id),
            identity.login,
            this.seal(value, user),
            value.expires_in,
          ],
        );
        await db.query(
          "update orka.repository_access_requests set status='canceled',revision=revision+1,updated_at=now(),note='Connected GitHub identity changed' where requester=$1 and github_id<>$2 and status=any($3::text[])",
          [user, String(identity.id), activeStatuses],
        );
        await db.query("delete from orka.github_authorizations where id=$1", [
          id,
        ]);
        return {
          connected: true,
          identity: { id: String(identity.id), login: identity.login },
        };
      });
    }
    if (input.action === "cancel-authorization") {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input.input);
      await this.store.pool.query(
        "delete from orka.github_authorizations where user_id=$1 and id=$2",
        [user, id],
      );
      return { ok: true };
    }
    if (input.action === "disconnect") {
      // Keep the local connection until GitHub acknowledges revocation, so a failed
      // provider request can be retried instead of orphaning a live credential.
      await this.store.transaction(async (db) => {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `github:${user}`,
        ]);
        const row = (
          await db.query(
            "select credentials from orka.github_connections where user_id=$1 for update",
            [user],
          )
        ).rows[0];
        if (row) {
          const value = credentials.parse(this.unseal(row.credentials, user));
          await this.call(
            `/applications/${this.settings.clientId}/token`,
            Buffer.from(
              `${this.settings.clientId}:${this.settings.clientSecret}`,
            ).toString("base64"),
            { access_token: value.access_token },
            "DELETE",
            true,
          );
        }
        await db.query(
          "delete from orka.github_authorizations where user_id=$1",
          [user],
        );
        await db.query("delete from orka.github_connections where user_id=$1", [
          user,
        ]);
      });
      return { connected: false };
    }
    if (input.action === "installations" || input.action === "repositories") {
      const page = z
        .object({
          page: z.number().int().min(1).max(10000).default(1),
          installationId: githubRepositoryId.optional(),
        })
        .strict()
        .parse(input.input ?? {});
      const auth = await this.token(user);
      const path =
        input.action === "installations"
          ? "/user/installations"
          : `/user/installations/${githubRepositoryId.parse(page.installationId)}/repositories`;
      const value = z
        .object({
          total_count: z.number().int().nonnegative(),
          installations: z.array(z.unknown()).optional(),
          repositories: z.array(z.unknown()).optional(),
        })
        .parse(
          await this.call(
            `${path}?per_page=50&page=${page.page}`,
            auth.accessToken,
          ),
        );
      const items =
        input.action === "repositories"
          ? (value.repositories ?? []).map((repo) => this.normalize(repo))
          : (value.installations ?? []).map((raw) => {
              const installation = z
                .object({
                  id: z.number().int().positive().safe(),
                  account: z.object({ login: z.string() }),
                })
                .parse(raw);
              return {
                id: String(installation.id),
                name: installation.account.login,
              };
            });
      return {
        items,
        nextPage: page.page * 50 < value.total_count ? page.page + 1 : null,
      };
    }
    if (input.action === "repository") {
      const { repositoryId } = z
        .object({ repositoryId: githubRepositoryId })
        .strict()
        .parse(input.input);
      return (await this.repository(user, repositoryId)).repository;
    }
    if (input.action === "add-source") {
      const value = z
        .object({ projectId: z.uuid(), repositoryId: githubRepositoryId })
        .strict()
        .parse(input.input);
      await this.store.member(user, value.projectId);
      const repository = (await this.repository(user, value.repositoryId))
        .repository;
      return this.store.transaction(async (db) => {
        const project = (
          await db.query(
            "select source_model from orka.projects where id=$1 for update",
            [value.projectId],
          )
        ).rows[0];
        await this.store.member(user, value.projectId, db);
        if (project?.source_model !== 1)
          throw new HttpError(
            409,
            "Upgrade this project to add repository sources",
          );
        if (
          !(
            await db.query(
              "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
              [value.projectId, user],
            )
          ).rowCount
        )
          throw new HttpError(403, "Only project owners can add repositories");
        if (
          (
            await db.query(
              "select 1 from orka.source_repositories where project_id=$1 and repository->>'id'=$2",
              [value.projectId, value.repositoryId],
            )
          ).rowCount
        )
          throw new HttpError(
            409,
            "This repository is already linked to a source in this project",
          );
        if (
          Number(
            (
              await db.query(
                "select count(*) as count from orka.project_sources where project_id=$1",
                [value.projectId],
              )
            ).rows[0].count,
          ) >= 100
        )
          throw new HttpError(400, "A project can contain at most 100 sources");
        const sourceId = randomUUID();
        await db.query("insert into orka.project_sources values($1,$2,$3)", [
          value.projectId,
          sourceId,
          repository.fullName.split("/")[1],
        ]);
        await db.query(
          "insert into orka.source_repositories values($1,$2,$3,1)",
          [value.projectId, sourceId, repository],
        );
        await db.query(
          "insert into orka.repository_events(project_id,source_id,actor,action,details) values($1,$2,$3,'add-source',$4)",
          [value.projectId, sourceId, user, { repositoryId: repository.id }],
        );
        return { sourceId, repository, revision: 1 };
      });
    }
    if (input.action === "bind" || input.action === "unlink") {
      const value = sourceInput
        .extend({
          repositoryId: githubRepositoryId.optional(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(input.input);
      await this.source(user, value, true);
      const repository =
        input.action === "bind"
          ? (
              await this.repository(
                user,
                githubRepositoryId.parse(value.repositoryId),
              )
            ).repository
          : null;
      return this.store.transaction(async (db) => {
        await db.query("select id from orka.projects where id=$1 for update", [
          value.projectId,
        ]);
        await this.store.member(user, value.projectId, db);
        if (
          !(
            await db.query(
              "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
              [value.projectId, user],
            )
          ).rowCount
        )
          throw new HttpError(403, "Only project owners can link repositories");
        const current = (
          await db.query(
            "select revision from orka.source_repositories where project_id=$1 and source_id=$2 for update",
            [value.projectId, value.sourceId],
          )
        ).rows[0];
        if (Number(current?.revision ?? 0) !== value.expectedRevision)
          throw new HttpError(
            409,
            "Repository link changed; refresh before trying again",
          );
        const revision = value.expectedRevision + 1;
        // Keep a revisioned tombstone on unlink so stale previews cannot rebind.
        await db.query(
          "insert into orka.source_repositories values($1,$2,$3,$4) on conflict(project_id,source_id) do update set repository=excluded.repository,revision=excluded.revision",
          [value.projectId, value.sourceId, repository ?? {}, revision],
        );
        await db.query(
          "update orka.repository_access_requests set status='canceled',revision=revision+1,updated_at=now(),note='Repository link changed' where project_id=$1 and source_id=$2 and status=any($3::text[])",
          [value.projectId, value.sourceId, activeStatuses],
        );
        await db.query(
          "insert into orka.repository_events(project_id,source_id,actor,action,details) values($1,$2,$3,$4,$5)",
          [
            value.projectId,
            value.sourceId,
            user,
            input.action,
            { repositoryId: repository?.id ?? null, revision },
          ],
        );
        return { repository, revision };
      });
    }
    if (input.action === "access" || input.action === "clone-credentials") {
      const source = await this.source(user, input.input);
      if (!source.row.repository?.id)
        throw new HttpError(
          409,
          "Link a GitHub repository to this source first",
        );
      const connection = (
        await this.store.pool.query(
          "select github_id from orka.github_connections where user_id=$1",
          [user],
        )
      ).rows[0];
      if (!connection)
        return {
          state: "not_connected",
          installationUrl: this.installationUrl,
        };
      try {
        const value = await this.repository(user, source.row.repository.id);
        const latest = await this.source(user, source);
        if (
          latest.row.revision !== source.row.revision ||
          latest.row.repository?.id !== source.row.repository.id
        )
          throw new HttpError(
            412,
            "Repository link changed; refresh before continuing",
          );
        if (value.repository.cloneUrl !== source.row.repository.cloneUrl) {
          const previousCloneUrls = [
            ...new Set([
              source.row.repository.cloneUrl,
              ...(source.row.repository.previousCloneUrls ?? []),
            ]),
          ]
            .filter((url) => url !== value.repository.cloneUrl)
            .slice(0, 10);
          await this.store.pool.query(
            "update orka.source_repositories set repository=$4 where project_id=$1 and source_id=$2 and revision=$3 and repository->>'id'=$5",
            [
              source.projectId,
              source.sourceId,
              source.row.revision,
              { ...value.repository, previousCloneUrls },
              value.repository.id,
            ],
          );
        }
        // A user-filtered repository response cannot lend the installation's rights.
        if (input.action === "clone-credentials")
          return {
            token: value.auth.accessToken,
            repository: value.repository,
            bindingRevision: Number(source.row.revision),
          };
        await this.store.pool.query(
          "with verified as (update orka.repository_access_requests set status='verified',revision=revision+1,updated_at=now() where project_id=$1 and source_id=$2 and requester=$3 and github_id=$4 and repository_id=$5 and status=any($6::text[]) returning id) insert into orka.repository_events(project_id,source_id,actor,action,details) select $1,$2,$3,'access-verified',jsonb_build_object('requestId',id,'repositoryId',$5::text) from verified",
          [
            source.projectId,
            source.sourceId,
            user,
            value.auth.githubId,
            value.repository.id,
            activeStatuses,
          ],
        );
        return {
          state: "ready",
          repository: value.repository,
          bindingRevision: Number(source.row.revision),
        };
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          ![401, 403, 409].includes(error.status)
        )
          throw error;
        if (input.action === "clone-credentials") throw error;
        return {
          state:
            error.status === 401 || error.status === 409
              ? "reconnect"
              : "access_unavailable",
          installationUrl: this.installationUrl,
        };
      }
    }
    if (input.action === "request-access") {
      const value = sourceInput
        .extend({ reason: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(input.input);
      const source = await this.source(user, value);
      if (!source.row.repository?.id)
        throw new HttpError(409, "Link a GitHub repository first");
      const auth = await this.token(user);
      await this.expireRequests(value.projectId);
      return this.store.transaction(async (db) => {
        await db.query("select id from orka.projects where id=$1 for update", [
          value.projectId,
        ]);
        await this.store.member(user, value.projectId, db);
        const binding = (
          await db.query(
            "select repository from orka.source_repositories where project_id=$1 and source_id=$2",
            [value.projectId, value.sourceId],
          )
        ).rows[0];
        if (binding?.repository?.id !== source.row.repository.id)
          throw new HttpError(
            409,
            "Repository link changed; refresh and try again",
          );
        const prior = (
          await db.query(
            "select id from orka.repository_access_requests where project_id=$1 and source_id=$2 and requester=$3 and status=any($4::text[])",
            [value.projectId, value.sourceId, user, activeStatuses],
          )
        ).rows[0];
        if (prior) return { id: prior.id };
        const id = randomUUID();
        await db.query(
          "insert into orka.repository_access_requests(id,project_id,source_id,requester,github_id,github_login,repository_id,full_name,reason,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested')",
          [
            id,
            value.projectId,
            value.sourceId,
            user,
            auth.githubId,
            auth.login,
            binding.repository.id,
            binding.repository.fullName,
            value.reason,
          ],
        );
        await db.query(
          "insert into orka.repository_events(project_id,source_id,actor,action,details) values($1,$2,$3,'request-access',$4)",
          [
            value.projectId,
            value.sourceId,
            user,
            { requestId: id, githubId: auth.githubId },
          ],
        );
        return { id };
      });
    }
    if (input.action === "requests") {
      const value = z
        .object({
          projectId: z.uuid(),
          offset: z.number().int().min(0).max(100000).default(0),
        })
        .strict()
        .parse(input.input);
      await this.store.member(user, value.projectId);
      await this.expireRequests(value.projectId);
      const owner = Boolean(
        (
          await this.store.pool.query(
            "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
            [value.projectId, user],
          )
        ).rowCount,
      );
      const result = await this.store.pool.query(
        `select id,project_id as "projectId",source_id as "sourceId",requester,github_id as "githubId",github_login as "githubLogin",repository_id as "repositoryId",full_name as "fullName",reason,status,revision,note,created_at as "createdAt",updated_at as "updatedAt" from orka.repository_access_requests where project_id=$1 and ($2 or requester=$3) order by created_at desc,id limit 51 offset $4`,
        [value.projectId, owner, user, value.offset],
      );
      return {
        items: result.rows.slice(0, 50).map((row) => ({
          ...row,
          revision: Number(row.revision),
          canReview: owner,
        })),
        nextOffset: result.rows.length > 50 ? value.offset + 50 : null,
      };
    }
    if (input.action === "review") {
      const value = z
        .object({
          projectId: z.uuid(),
          id: z.uuid(),
          expectedRevision: z.number().int().positive(),
          status: z.enum([
            "waiting_on_github",
            "invitation_pending",
            "rejected",
            "canceled",
          ]),
          note: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(input.input);
      return this.store.transaction(async (db) => {
        await db.query("select id from orka.projects where id=$1 for update", [
          value.projectId,
        ]);
        await this.store.member(user, value.projectId, db);
        const owner = Boolean(
          (
            await db.query(
              "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
              [value.projectId, user],
            )
          ).rowCount,
        );
        const row = (
          await db.query(
            "select * from orka.repository_access_requests where project_id=$1 and id=$2 for update",
            [value.projectId, value.id],
          )
        ).rows[0];
        if (
          !row ||
          (!owner && !(row.requester === user && value.status === "canceled"))
        )
          throw new HttpError(
            403,
            "Only project owners can review repository requests; requesters can cancel their own",
          );
        if (
          !activeStatuses.includes(row.status) ||
          Number(row.revision) !== value.expectedRevision
        )
          throw new HttpError(409, "Request changed; refresh before reviewing");
        await db.query(
          "update orka.repository_access_requests set status=$2,note=$3,revision=revision+1,updated_at=now() where id=$1",
          [value.id, value.status, value.note],
        );
        await db.query(
          "insert into orka.repository_events(project_id,source_id,actor,action,details) values($1,$2,$3,'review',$4)",
          [
            value.projectId,
            row.source_id,
            user,
            { requestId: value.id, status: value.status, note: value.note },
          ],
        );
        return { ok: true };
      });
    }
    throw new HttpError(404, "Unknown GitHub repository action");
  }
}
