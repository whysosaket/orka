import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  GitHubRepository,
  RepositoryAccessRequest,
} from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { TextField } from "./text-field.js";
import { connectProject } from "./use-project-setup.js";

interface GitHubStatus {
  connected: boolean;
  identity: { id: string; login: string } | null;
  installationUrl: string;
}
interface Authorization {
  id: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}
interface CloneJob {
  id: string;
  projectId: string;
  sourceId: string;
  state: string;
  message: string;
  destination: string;
  folderIdentity?: string;
}
interface Access {
  state: "ready" | "not_connected" | "reconnect" | "access_unavailable";
}
export function useRepositoryCommand(state: Snapshot) {
  const user = state.user,
    service = state.config?.apiUrl;
  return useCallback(
    <T,>(action: string, input: unknown = {}) =>
      invoke<T>("repository_command", {
        action,
        input,
        context: { user, service },
      }),
    [user, service],
  );
}

export function RepositoryConnections({
  project,
  state,
  refresh,
}: {
  project: Project;
  state: Snapshot;
  refresh: () => Promise<unknown>;
}) {
  const call = useRepositoryCommand(state);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [jobs, setJobs] = useState<CloneJob[]>([]);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [installations, setInstallations] = useState<
    { id: string; name: string }[]
  >([]);
  const [installationPage, setInstallationPage] = useState<number | null>(null);
  const [installation, setInstallation] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState("");
  const [cloneSource, setCloneSource] = useState("");
  const [folderName, setFolderName] = useState("");
  const [requestSource, setRequestSource] = useState("");
  const [reason, setReason] = useState("");
  const active = useRef(true);
  const jobsRef = useRef<CloneJob[]>([]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (active.current) setError(String(e));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  useEffect(() => {
    let canceled = false;
    void call<{ enabled: boolean }>("capabilities")
      .then(async (caps) => {
        if (!caps.enabled || canceled) return;
        const value = await call<GitHubStatus>("status");
        if (!canceled) {
          setEnabled(true);
          setStatus(value);
        }
      })
      .catch(() => {
        /* Older servers retain local-folder connection. */
      });
    return () => {
      canceled = true;
    };
  }, [call]);
  useEffect(() => {
    if (!authorization) return;
    let canceled = false,
      timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + authorization.expiresIn * 1000;
    const poll = async () => {
      try {
        if (Date.now() >= expires)
          throw new Error("GitHub authorization expired. Connect again.");
        const result = await call<{
          connected?: boolean;
          pending?: boolean;
          interval?: number;
          error?: string;
        }>("poll", { id: authorization.id });
        if (canceled) return;
        if (result.error) throw new Error(result.error);
        if (result.connected) {
          setAuthorization(null);
          setStatus(await call<GitHubStatus>("status"));
          setNotice(
            "GitHub connected. Review the account and select repository access.",
          );
        } else
          timer = setTimeout(
            () => void poll(),
            Math.max(5, result.interval ?? authorization.interval) * 1000,
          );
      } catch (e) {
        if (!canceled) {
          setError(String(e));
          setAuthorization(null);
        }
      }
    };
    timer = setTimeout(() => void poll(), authorization.interval * 1000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [authorization, call]);
  useEffect(() => {
    if (!enabled) return;
    let canceled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const values = await call<CloneJob[]>("jobs");
        if (canceled) return;
        const own = values.filter((job) => job.projectId === project.id);
        if (
          own.some(
            (job) =>
              job.state === "connected" &&
              jobsRef.current.some(
                (previous) =>
                  previous.id === job.id && previous.state !== "connected",
              ),
          )
        )
          await refresh();
        jobsRef.current = own;
        setJobs(own);
      } catch (e) {
        if (!canceled) setError(String(e));
      }
      if (!canceled) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [enabled, call, project.id, refresh]);
  if (!enabled) return null;
  const sources = project.sources ?? [];
  const openGitHub = (url: string) => call("open-github", { url });
  const loadInstallations = async (page = 1) => {
    const value = await call<{
      items: { id: string; name: string }[];
      nextPage: number | null;
    }>("installations", { page });
    setInstallations((previous) =>
      page === 1
        ? value.items
        : [
            ...new Map(
              [...previous, ...value.items].map((item) => [item.id, item]),
            ).values(),
          ],
    );
    setInstallationPage(value.nextPage);
    if (!value.items.length && page === 1)
      setNotice(
        "Install Orka on your account or request organization approval, then refresh accounts.",
      );
  };
  const loadRepositories = async (id: string, page = 1) => {
    const value = await call<{
      items: GitHubRepository[];
      nextPage: number | null;
    }>("repositories", { installationId: id, page });
    setRepositories((previous) =>
      page === 1
        ? value.items
        : [
            ...new Map(
              [...previous, ...value.items].map((item) => [item.id, item]),
            ).values(),
          ],
    );
    setNextPage(value.nextPage);
  };
  const selectedSource = sources.find((source) => source.id === cloneSource);
  return (
    <section className="repository-panel" aria-label="GitHub repositories">
      <div className="settings-row">
        <div>
          <h3>GitHub repositories</h3>
          <p>
            {status?.connected
              ? `Connected as @${status.identity?.login}`
              : "Connect GitHub to select and clone repositories."}
          </p>
        </div>
        <div className="actions">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await call<Authorization>("begin");
                setAuthorization(value);
                await openGitHub(value.verificationUrl);
              })
            }
          >
            {status?.connected ? "Reconnect GitHub" : "Connect GitHub"}
          </Button>
          {status?.connected && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call("disconnect");
                  setStatus(await call<GitHubStatus>("status"));
                  setInstallations([]);
                  setRepositories([]);
                  setAccess({});
                })
              }
            >
              Disconnect GitHub
            </Button>
          )}
        </div>
      </div>
      {authorization && (
        <div className="settings-notice" role="status">
          <p>
            Enter this code on GitHub: <strong>{authorization.userCode}</strong>
            . Confirm the account before authorizing Orka.
          </p>
          <div className="actions">
            <Button
              size="sm"
              onClick={() =>
                void run(async () => {
                  await openGitHub(authorization.verificationUrl);
                })
              }
            >
              Open GitHub authorization
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void run(async () => {
                  await call("cancel-authorization", { id: authorization.id });
                  setAuthorization(null);
                })
              }
            >
              Cancel GitHub connection
            </Button>
          </div>
        </div>
      )}
      {status?.connected && (
        <>
          <div className="actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await openGitHub(status.installationUrl);
                })
              }
            >
              Configure GitHub access
            </Button>
            {project.role === "owner" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(() => loadInstallations())}
              >
                Browse repositories
              </Button>
            )}
          </div>
          {project.role === "owner" && installations.length > 0 && (
            <div className="repository-browser">
              <label>
                GitHub account
                <select
                  aria-label="GitHub account"
                  value={installation}
                  disabled={busy}
                  onChange={(event) => {
                    const id = event.target.value;
                    setInstallation(id);
                    setRepositories([]);
                    if (id) void run(() => loadRepositories(id));
                  }}
                >
                  <option value="">Choose an account</option>
                  {installations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {installationPage && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => loadInstallations(installationPage))
                  }
                >
                  Load more accounts
                </Button>
              )}
              <label>
                Destination source
                <select
                  aria-label="Destination source"
                  value={sourceId}
                  disabled={busy}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  <option value="">Add a new repository source</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              <TextField
                label="Filter loaded repositories"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {repositories
                .filter((repo) =>
                  repo.fullName.toLowerCase().includes(search.toLowerCase()),
                )
                .map((repo) => (
                  <div className="settings-row" key={repo.id}>
                    <div>
                      <h3>{repo.fullName}</h3>
                      <p>{repo.private ? "Private" : "Public"}</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (sourceId) {
                            const source = sources.find(
                              (item) => item.id === sourceId,
                            );
                            await call("bind", {
                              projectId: project.id,
                              sourceId,
                              repositoryId: repo.id,
                              expectedRevision:
                                source?.repositoryRevision ??
                                source?.repository?.revision ??
                                0,
                            });
                          } else
                            await call("add-source", {
                              projectId: project.id,
                              repositoryId: repo.id,
                            });
                          await refresh();
                          setNotice(
                            "Repository linked. Review its location, then clone or locate an existing checkout.",
                          );
                        })
                      }
                    >
                      {sourceId ? "Link repository" : "Add repository source"}
                    </Button>
                  </div>
                ))}
              {nextPage && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => loadRepositories(installation, nextPage))
                  }
                >
                  Load more repositories
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {sources
        .filter((source) => source.repository)
        .map((source) => (
          <div className="repository-source" key={source.id}>
            <div>
              <h3>{source.name}</h3>
              <p>
                {source.repository!.fullName} ·{" "}
                {source.path
                  ? "Connected on this Mac"
                  : "Not connected on this Mac"}
              </p>
            </div>
            <div className="actions">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const value = await call<Access>("access", {
                      projectId: project.id,
                      sourceId: source.id,
                    });
                    setAccess((previous) => ({
                      ...previous,
                      [source.id]: value,
                    }));
                  })
                }
              >
                Check access
              </Button>
              {!source.path && (
                <>
                  <Button
                    size="sm"
                    disabled={busy || access[source.id]?.state !== "ready"}
                    onClick={() =>
                      void run(async () => {
                        setCloneSource(source.id);
                        setFolderName(
                          source.repository!.fullName.replace("/", "-"),
                        );
                        if (!directory)
                          setDirectory(await call<string>("default-directory"));
                      })
                    }
                  >
                    Clone &amp; connect
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await connectProject(project.id, source.id);
                        await refresh();
                      })
                    }
                  >
                    Locate existing checkout
                  </Button>
                </>
              )}
              {access[source.id]?.state === "access_unavailable" && (
                <>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setRequestSource(source.id);
                      setReason("");
                    }}
                  >
                    Request repository access
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (status) await openGitHub(status.installationUrl);
                      })
                    }
                  >
                    Request app approval
                  </Button>
                </>
              )}
              {project.role === "owner" && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call("unlink", {
                        projectId: project.id,
                        sourceId: source.id,
                        expectedRevision:
                          source.repositoryRevision ??
                          source.repository!.revision,
                      });
                      await refresh();
                    })
                  }
                >
                  Unlink repository
                </Button>
              )}
            </div>
            {access[source.id] && (
              <p role="status">
                {access[source.id].state === "ready"
                  ? "GitHub access verified. Ready to clone."
                  : access[source.id].state === "not_connected" ||
                      access[source.id].state === "reconnect"
                    ? "Connect or reconnect GitHub to verify access."
                    : "Access unavailable. Check repository membership, app approval and organization SSO."}
              </p>
            )}
          </div>
        ))}
      {selectedSource && (
        <div className="repository-browser" aria-label="Clone destination">
          <h3>Clone {selectedSource.repository?.fullName}</h3>
          <TextField
            label="Workspace location"
            value={directory}
            disabled={busy}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const selected = await open({
                  directory: true,
                  multiple: false,
                  title: "Choose workspace location",
                });
                if (typeof selected === "string") setDirectory(selected);
              })
            }
          >
            Choose workspace folder
          </Button>
          <TextField
            label="Checkout folder name"
            value={folderName}
            disabled={busy}
            onChange={(event) => setFolderName(event.target.value)}
          />
          <p>
            Destination: {directory}/{folderName}
          </p>
          <div className="actions">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !directory || !folderName}
              onClick={() =>
                void run(async () => {
                  const job = await call<CloneJob>("clone", {
                    projectId: project.id,
                    sourceId: selectedSource.id,
                    directory,
                    folderName,
                  });
                  setJobs((previous) => [job, ...previous]);
                  jobsRef.current = [job, ...jobsRef.current];
                  setCloneSource("");
                })
              }
            >
              Start clone
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setCloneSource("")}
            >
              Cancel clone setup
            </Button>
          </div>
        </div>
      )}
      {requestSource && (
        <div className="repository-browser">
          <TextField
            label="Reason for repository access"
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p>
            An Orka owner coordinates the request with a GitHub administrator.
            GitHub access is verified separately.
          </p>
          <div className="actions">
            <Button
              size="sm"
              disabled={busy || !reason.trim()}
              onClick={() =>
                void run(async () => {
                  await call("request-access", {
                    projectId: project.id,
                    sourceId: requestSource,
                    reason,
                  });
                  setRequestSource("");
                  setNotice(
                    "Request sent to project owners. Follow its progress in Manage → Requests.",
                  );
                })
              }
            >
              Send repository request
            </Button>
            <Button size="sm" onClick={() => setRequestSource("")}>
              Cancel request
            </Button>
          </div>
        </div>
      )}
      {jobs.map((job) => (
        <div className="repository-source" key={job.id}>
          <p>
            <strong>
              {sources.find((source) => source.id === job.sourceId)?.name ??
                "Repository"}
            </strong>{" "}
            · {job.state}
          </p>
          <p role="status">{job.message}</p>
          <p className="settings-path">{job.destination}</p>
          <div className="actions">
            {["queued", "cloning"].includes(job.state) && (
              <Button
                size="sm"
                onClick={() =>
                  void run(async () => {
                    await call("cancel-clone", { id: job.id });
                  })
                }
              >
                Cancel clone
              </Button>
            )}
            {["failed", "interrupted", "canceled"].includes(job.state) &&
              job.folderIdentity && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call("retry-connect", { id: job.id });
                      await refresh();
                    })
                  }
                >
                  Retry connect
                </Button>
              )}
          </div>
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function RepositoryRequests({
  project,
  state,
}: {
  project: Project;
  state: Snapshot;
}) {
  const call = useRepositoryCommand(state);
  const [requests, setRequests] = useState<RepositoryAccessRequest[]>([]);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(
    async (offset = 0) => {
      const value = await call<{
        items: RepositoryAccessRequest[];
        nextOffset: number | null;
      }>("requests", { projectId: project.id, offset });
      setRequests((previous) =>
        offset ? [...previous, ...value.items] : value.items,
      );
      setNextOffset(value.nextOffset);
    },
    [call, project.id],
  );
  useEffect(() => {
    let canceled = false;
    void call<{ enabled: boolean }>("capabilities")
      .then(async (value) => {
        if (!canceled && value.enabled) {
          setEnabled(true);
          await load();
        }
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [call, load]);
  if (!enabled) return null;
  const review = async (request: RepositoryAccessRequest, status: string) => {
    setBusy(true);
    setError("");
    try {
      await call("review", {
        projectId: project.id,
        id: request.id,
        expectedRevision: request.revision,
        status,
        note:
          notes[request.id] ||
          (status === "canceled" ? "Canceled by requester" : ""),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="repository-panel"
      aria-label="Repository access requests"
    >
      <h3>Repository access requests</h3>
      <p>
        Project owners coordinate grants in GitHub. Access becomes verified only
        after the requester checks GitHub access.
      </p>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void load().catch((e) => setError(String(e)))}
      >
        Refresh repository requests
      </Button>
      {requests.length === 0 && <p>No repository access requests.</p>}
      {requests.map((request) => (
        <div key={request.id} className="repository-source">
          <h3>
            {request.fullName} · @{request.githubLogin}
          </h3>
          <p>{request.reason}</p>
          <p>Status: {request.status.replaceAll("_", " ")}</p>
          {request.note && <p>{request.note}</p>}
          {["requested", "waiting_on_github", "invitation_pending"].includes(
            request.status,
          ) && (
            <>
              <div className="actions">
                <Button
                  size="sm"
                  onClick={() =>
                    void call("open-github", {
                      url: `https://github.com/${request.fullName}`,
                    }).catch((e) => setError(String(e)))
                  }
                >
                  Open repository on GitHub
                </Button>
              </div>
              {request.canReview && (
                <>
                  <TextField
                    label={`Review note for ${request.githubLogin}`}
                    value={notes[request.id] ?? ""}
                    maxLength={1000}
                    onChange={(event) =>
                      setNotes((previous) => ({
                        ...previous,
                        [request.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="actions">
                    {[
                      ["waiting_on_github", "Coordinate in GitHub"],
                      ["invitation_pending", "Invitation sent"],
                      ["rejected", "Reject request"],
                    ].map(([status, label]) => (
                      <Button
                        key={status}
                        size="sm"
                        disabled={busy || !notes[request.id]?.trim()}
                        onClick={() => void review(request, status)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              {request.requester === state.user && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void review(request, "canceled")}
                >
                  Cancel repository request
                </Button>
              )}
            </>
          )}
        </div>
      ))}
      {nextOffset !== null && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void load(nextOffset).catch((e) => setError(String(e)))
          }
        >
          Load more requests
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
