import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { KebabHorizontalIcon, XIcon } from "@primer/octicons-react";
import type { GitHubRepository } from "@portable/protocol";
import type { Project } from "../types.js";
import type { RepositoryController } from "./use-repositories.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { TextField } from "./text-field.js";
import { connectProject } from "./use-project-setup.js";
import { ActionPopover } from "./resource-actions.js";

export type RepositorySource = NonNullable<Project["sources"]>[number];
export function RepositoryPicker({
  project,
  source,
  controller,
  onClose,
  onConnected,
  onLocalFolder,
  onRequestAccess,
}: {
  project: Project;
  source?: RepositorySource;
  controller: RepositoryController;
  onClose: () => void;
  onConnected: () => void;
  onLocalFolder?: () => Promise<unknown>;
  onRequestAccess: (source: RepositorySource) => void;
}) {
  const { call, status, authorization, busy, error, run, openGitHub } =
    controller;
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [account, setAccount] = useState("");
  const [accountPage, setAccountPage] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState("");
  const [directory, setDirectory] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [awaitingGitHubAccess, setAwaitingGitHubAccess] = useState(false);
  const needsAuth =
    Boolean(authorization) ||
    !status?.connected ||
    (source &&
      ["reconnect", "not_connected"].includes(
        controller.access[source.id]?.state,
      ));
  const linked = source?.repository;
  const sourceAccess = source ? controller.access[source.id] : undefined;
  const canConnectSource = !linked || sourceAccess?.state === "ready";
  const selected =
    linked ?? repositories.find((repository) => repository.id === repositoryId);
  const existing =
    source ??
    project.sources?.find((item) => item.repository?.id === selected?.id);
  const connected = Boolean(
    existing?.path &&
    existing.repository?.id === selected?.id &&
    existing.folderState !== "reconnect",
  );
  useEffect(() => {
    if (needsAuth || linked) return;
    let canceled = false;
    setLoading(true);
    setLoadError("");
    void call<{
      items: { id: string; name: string }[];
      nextPage: number | null;
    }>("installations", { page: 1 })
      .then((value) => {
        if (!canceled) {
          setAccounts(value.items);
          setAccountPage(value.nextPage);
          if (value.items.length === 1) setAccount(value.items[0].id);
        }
      })
      .catch((e) => {
        if (!canceled) setLoadError(String(e));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [call, needsAuth, linked, refreshVersion]);
  useEffect(() => {
    if (!account || needsAuth || linked) return;
    let canceled = false;
    setLoading(true);
    setLoadError("");
    setRepositories([]);
    setRepositoryId("");
    void call<{ items: GitHubRepository[]; nextPage: number | null }>(
      "repositories",
      { installationId: account, page: 1 },
    )
      .then((value) => {
        if (!canceled) {
          setRepositories(value.items);
          setNextPage(value.nextPage);
        }
      })
      .catch((e) => {
        if (!canceled) setLoadError(String(e));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [call, account, needsAuth, linked, refreshVersion]);
  useEffect(() => {
    let canceled = false;
    void call<string>("default-directory")
      .then((value) => {
        if (!canceled) setDirectory(value);
      })
      .catch((e) => {
        if (!canceled) setLoadError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [call]);
  useEffect(() => {
    if (!awaitingGitHubAccess) return;
    const onFocus = () => {
      setAwaitingGitHubAccess(false);
      setRefreshVersion((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [awaitingGitHubAccess]);
  const manageAccess = () => {
    setAwaitingGitHubAccess(true);
    return openGitHub(status!.installationUrl);
  };
  const defaultName = selected?.fullName.split("/")[1] ?? "";
  const name = folderName ?? defaultName;
  const connect = () =>
    run(async () => {
      if (!selected) return;
      let sourceId = existing?.id;
      if (source && !linked) {
        await call("bind", {
          projectId: project.id,
          sourceId: source.id,
          repositoryId: selected.id,
          expectedRevision: source.repositoryRevision ?? 0,
        });
      } else if (!sourceId) {
        sourceId = (
          await call<{ sourceId: string }>("add-source", {
            projectId: project.id,
            repositoryId: selected.id,
          })
        ).sourceId;
      }
      await controller.refresh();
      if (!sourceId)
        throw new Error("Could not connect this repository. Try again.");
      if (existing?.path && existing.folderState === "reconnect") {
        if (!(await connectProject(project.id, sourceId, existing.path)))
          return;
        await controller.refresh();
      } else if (!existing?.path)
        await controller.startClone(sourceId, directory, name);
      onConnected();
    });
  const close = () => {
    if (busy) return;
    if (authorization)
      void run(async () => {
        await controller.cancelAuthorization();
        onClose();
      });
    else onClose();
  };
  return (
    <Overlay
      open
      title="Connect repository"
      className="repository-dialog"
      onClose={close}
    >
      <div className="repository-dialog-heading">
        <h2>Connect repository</h2>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close repository connection"
          disabled={busy}
          onClick={close}
        />
      </div>
      {!status ? (
        <>
          <p role="status">
            {error
              ? "GitHub is temporarily unavailable."
              : "Checking GitHub connection…"}
          </p>
          {error && (
            <Button
              disabled={busy}
              onClick={() => void run(controller.reloadStatus)}
            >
              Retry
            </Button>
          )}
        </>
      ) : needsAuth ? (
        <>
          <p>Connect GitHub to choose a repository for {project.name}.</p>
          {authorization ? (
            <div className="repository-authorization" role="status">
              <p>Enter this code on GitHub:</p>
              <strong>{authorization.userCode}</strong>
              <p>Waiting for authorization…</p>
              <Button
                onClick={() =>
                  void run(() => openGitHub(authorization.verificationUrl))
                }
              >
                Open GitHub
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(controller.connectGitHub)}
            >
              Connect GitHub
            </Button>
          )}
        </>
      ) : (
        <>
          {linked ? (
            <p className="repository-selection-name">{linked.fullName}</p>
          ) : (
            <div className="repository-picker-fields">
              <label>
                GitHub account
                <select
                  aria-label="GitHub account"
                  value={account}
                  disabled={busy || loading}
                  onChange={(event) => {
                    setAccount(event.target.value);
                    setQuery("");
                  }}
                >
                  <option value="">Choose an account</option>
                  {accounts.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {accountPage && (
                <Button
                  size="sm"
                  disabled={busy || loading}
                  onClick={() =>
                    void run(async () => {
                      const value = await call<{
                        items: { id: string; name: string }[];
                        nextPage: number | null;
                      }>("installations", { page: accountPage });
                      setAccounts((items) => [...items, ...value.items]);
                      setAccountPage(value.nextPage);
                    })
                  }
                >
                  More accounts
                </Button>
              )}
              {(repositories.length > 10 || nextPage) && (
                <TextField
                  label="Search loaded repositories"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              )}
              <label>
                Repository
                <select
                  aria-label="Repository"
                  value={repositoryId}
                  disabled={busy || loading || !account}
                  onChange={(event) => {
                    setRepositoryId(event.target.value);
                    setFolderName(null);
                  }}
                >
                  <option value="">Choose a repository</option>
                  {repositories
                    .filter((repository) =>
                      repository.fullName
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.fullName}
                        {repository.private ? " · Private" : ""}
                      </option>
                    ))}
                </select>
              </label>
              {nextPage && (
                <Button
                  size="sm"
                  disabled={busy || loading}
                  onClick={() =>
                    void run(async () => {
                      const value = await call<{
                        items: GitHubRepository[];
                        nextPage: number | null;
                      }>("repositories", {
                        installationId: account,
                        page: nextPage,
                      });
                      setRepositories((items) => [
                        ...new Map(
                          [...items, ...value.items].map((item) => [
                            item.id,
                            item,
                          ]),
                        ).values(),
                      ]);
                      setNextPage(value.nextPage);
                    })
                  }
                >
                  More repositories
                </Button>
              )}
              {!loading && (
                <details
                  className="repository-help"
                  open={!accounts.length || undefined}
                >
                  <summary>Can’t find a repository?</summary>
                  <p>
                    Give Orka access to the repository on GitHub. Organization
                    owners may need to approve it.
                  </p>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(manageAccess)}
                  >
                    Manage GitHub access
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => setRefreshVersion((value) => value + 1)}
                  >
                    Refresh repositories
                  </Button>
                </details>
              )}
            </div>
          )}
          {loading && <p role="status">Loading repositories…</p>}
          {selected && !existing?.path && canConnectSource && (
            <div className="repository-location">
              <p>
                Clone to{" "}
                <span>
                  {directory}/{name}
                </span>
              </p>
              <details>
                <summary>Change location</summary>
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
                      const value = await open({
                        directory: true,
                        multiple: false,
                        title: "Choose workspace location",
                      });
                      if (typeof value === "string") setDirectory(value);
                    })
                  }
                >
                  Choose folder
                </Button>
                <TextField
                  label="Checkout folder name"
                  value={name}
                  disabled={busy}
                  onChange={(event) => setFolderName(event.target.value)}
                />
              </details>
            </div>
          )}
          {selected && existing?.path && (
            <p>
              {connected
                ? "Already connected on this Mac."
                : existing?.folderState === "reconnect"
                  ? "Confirm the existing folder to reconnect it on this Mac."
                  : "This folder will be linked to GitHub."}
            </p>
          )}
          <div className="repository-dialog-footer">
            <span className="repository-account">
              @{status?.identity?.login}
              <ActionPopover
                label="GitHub account options"
                trigger={
                  <IconButton
                    icon={KebabHorizontalIcon}
                    size="sm"
                    variant="tertiary"
                    aria-label="GitHub account options"
                    disabled={busy}
                  />
                }
              >
                <Button size="sm" onClick={() => void run(manageAccess)}>
                  Manage GitHub access
                </Button>
                <Button
                  size="sm"
                  onClick={() => void run(controller.connectGitHub)}
                >
                  Use another GitHub account
                </Button>
                <Button
                  size="sm"
                  onClick={() => void run(controller.disconnectGitHub)}
                >
                  Disconnect GitHub
                </Button>
              </ActionPopover>
            </span>
            {!connected &&
              (sourceAccess?.state === "access_unavailable" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => source && onRequestAccess(source)}
                >
                  Request access
                </Button>
              ) : sourceAccess?.state === "unavailable" ? (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => controller.recheck(source!.id))}
                >
                  Retry access check
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    loading ||
                    !selected ||
                    !canConnectSource ||
                    (!existing?.path && (!directory || !name))
                  }
                  onClick={() => void connect()}
                >
                  {busy
                    ? "Connecting…"
                    : !canConnectSource
                      ? "Checking access…"
                      : "Connect repository"}
                </Button>
              ))}
          </div>
        </>
      )}
      {onLocalFolder && !source && !authorization && (
        <Button
          className="repository-local-option"
          variant="tertiary"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (await onLocalFolder()) onConnected();
            })
          }
        >
          Use a local folder instead
        </Button>
      )}
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
    </Overlay>
  );
}
