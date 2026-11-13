import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, MarkGithubIcon, XIcon } from "@primer/octicons-react";
import type { GitHubRepository } from "@portable/protocol";
import type { Project } from "../types.js";
import type { RepositoryController } from "./use-repositories.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { TextField } from "./text-field.js";
import { connectProject } from "./use-project-setup.js";
import { ActionPopover } from "./resource-actions.js";
import { PermissionSelect } from "./permission-select.js";

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
  const {
    call,
    status,
    authorization,
    busy,
    error,
    run,
    openGitHub,
    authorizationConnectedVersion,
    authorizationError,
  } = controller;
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [account, setAccount] = useState("");
  const [accountPage, setAccountPage] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const loading = loadingAccounts || loadingRepositories;
  const [loadError, setLoadError] = useState("");
  const [directory, setDirectory] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [awaitingGitHubAccess, setAwaitingGitHubAccess] = useState(false);
  const [guidedVersion, setGuidedVersion] = useState(0);
  const [accountsLoadedFor, setAccountsLoadedFor] = useState("");
  const accountScope = `${status?.identity?.id}:${authorizationConnectedVersion}:${refreshVersion}`;
  const [matchingFolder, setMatchingFolder] = useState<{
    repositoryId: string;
    sourceId: string | null;
  } | null>(null);
  const [matchingError, setMatchingError] = useState("");
  const [checkingFolder, setCheckingFolder] = useState(false);
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
  const boundSource = selected
    ? project.sources?.find(
        (item) => !item.removedAt && item.repository?.id === selected.id,
      )
    : undefined;
  const duplicateBinding =
    source && boundSource && source.id !== boundSource.id;
  const existing =
    source ??
    (selected
      ? project.sources?.find(
          (item) =>
            !item.removedAt &&
            (item.repository?.id === selected.id ||
              (matchingFolder?.repositoryId === selected.id &&
                item.id === matchingFolder.sourceId)),
        )
      : undefined);
  const connected = Boolean(
    existing?.path &&
    existing.repository?.id === selected?.id &&
    existing.folderState !== "reconnect",
  );
  useEffect(() => {
    if (needsAuth) return;
    let canceled = false;
    setLoadingAccounts(true);
    setLoadError("");
    void call<{
      items: { id: string; name: string }[];
      nextPage: number | null;
    }>("installations", { page: 1 })
      .then((value) => {
        if (!canceled) {
          setAccounts(value.items);
          setAccountPage(value.nextPage);
          setAccountsLoadedFor(accountScope);
          setAccount((previous) =>
            value.items.some((item) => item.id === previous)
              ? previous
              : (value.items[0]?.id ?? ""),
          );
        }
      })
      .catch((e) => {
        if (!canceled) setLoadError(String(e));
      })
      .finally(() => {
        if (!canceled) setLoadingAccounts(false);
      });
    return () => {
      canceled = true;
    };
  }, [call, needsAuth, accountScope]);
  useEffect(() => {
    if (!account || needsAuth || linked) {
      setRepositories([]);
      setRepositoryId("");
      setNextPage(null);
      setLoadingRepositories(false);
      return;
    }
    let canceled = false;
    setLoadingRepositories(true);
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
        if (!canceled) setLoadingRepositories(false);
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
  useEffect(() => {
    if (
      !authorizationConnectedVersion ||
      guidedVersion === authorizationConnectedVersion ||
      needsAuth ||
      accountsLoadedFor !== accountScope ||
      loading ||
      loadError ||
      accounts.length ||
      !status
    )
      return;
    setGuidedVersion(authorizationConnectedVersion);
    setAwaitingGitHubAccess(true);
    void run(() => openGitHub(status.installationUrl));
  }, [
    authorizationConnectedVersion,
    guidedVersion,
    needsAuth,
    accountsLoadedFor,
    accountScope,
    loading,
    loadError,
    accounts.length,
    status,
    run,
    openGitHub,
  ]);
  useEffect(() => {
    setMatchingFolder(null);
    setMatchingError("");
    setCheckingFolder(false);
    if (!selected || source || existing?.repository) return;
    let canceled = false;
    setCheckingFolder(true);
    void call<{ sourceId: string } | null>("matching-source", {
      projectId: project.id,
      repositoryId: selected.id,
    })
      .then((match) => {
        if (!canceled)
          setMatchingFolder({
            repositoryId: selected.id,
            sourceId: match?.sourceId ?? null,
          });
      })
      .catch((error) => {
        if (!canceled) setMatchingError(String(error));
      })
      .finally(() => {
        if (!canceled) setCheckingFolder(false);
      });
    return () => {
      canceled = true;
    };
  }, [call, project.id, selected, source, existing?.repository]);
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
      if (existing && !existing.repository) {
        await call("bind", {
          projectId: project.id,
          sourceId: existing.id,
          repositoryId: selected.id,
          expectedRevision: existing.repositoryRevision ?? 0,
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
          <p>
            Authorize your GitHub account, then choose which repositories Orka
            can access.
          </p>
          {authorization ? (
            <div className="repository-authorization" role="status">
              <p>Enter this code on GitHub:</p>
              <strong>{authorization.userCode}</strong>
              <p>Waiting for GitHub authorization…</p>
              <p>After authorization, continue with repository access.</p>
              {authorizationError && <p role="alert">{authorizationError}</p>}
              <Button
                onClick={() =>
                  void run(() => openGitHub(authorization.verificationUrl))
                }
              >
                Open GitHub
              </Button>
              <Button
                disabled={busy}
                onClick={() => void run(controller.checkAuthorization)}
              >
                I’ve authorized GitHub
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
          <div className="repository-account-row">
            <span>GitHub connected</span>
            <ActionPopover
              label="GitHub account options"
              trigger={
                <Button
                  className="repository-account-trigger"
                  aria-label={`GitHub account options for @${status?.identity?.login}`}
                  disabled={busy}
                >
                  <MarkGithubIcon size={16} aria-hidden="true" />
                  <span>@{status?.identity?.login}</span>
                  <ChevronDownIcon size={14} aria-hidden="true" />
                </Button>
              }
            >
              <Button size="sm" onClick={() => void run(manageAccess)}>
                Manage GitHub access
              </Button>
              <Button
                size="sm"
                onClick={() => void run(controller.connectGitHub)}
              >
                Connect another GitHub account
              </Button>
              <Button
                size="sm"
                onClick={() => void run(controller.disconnectGitHub)}
              >
                Disconnect GitHub
              </Button>
            </ActionPopover>
          </div>
          {awaitingGitHubAccess && (
            <div className="repository-access-setup" role="status">
              <p>Choose repository access on GitHub, then return to Orka.</p>
              <Button
                size="sm"
                disabled={busy || loading}
                onClick={() => {
                  setAwaitingGitHubAccess(false);
                  setRefreshVersion((value) => value + 1);
                }}
              >
                I’ve configured access
              </Button>
            </div>
          )}
          {linked ? (
            <p className="repository-selection-name">{linked.fullName}</p>
          ) : (
            <div className="repository-picker-fields">
              <div className="repository-picker-field">
                <span>GitHub account</span>
                <PermissionSelect
                  label="GitHub account"
                  placeholder={
                    loading ? "Loading accounts…" : "Choose an account"
                  }
                  value={account}
                  disabled={busy || loading || !accounts.length}
                  onChange={(value) => {
                    setAccount(value);
                    setQuery("");
                  }}
                  options={accounts.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
              </div>
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
              <div className="repository-picker-field">
                <span>Repository</span>
                <PermissionSelect
                  label="Repository"
                  placeholder={
                    loading ? "Loading repositories…" : "Choose a repository"
                  }
                  value={repositoryId}
                  disabled={busy || loading || !account}
                  onChange={(value) => {
                    setRepositoryId(value);
                    setFolderName(null);
                  }}
                  options={repositories
                    .filter((repository) =>
                      repository.fullName
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((repository) => ({
                      value: repository.id,
                      label: `${repository.fullName}${repository.private ? " · Private" : ""}`,
                    }))}
                />
              </div>
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
          {duplicateBinding && (
            <p role="status">
              This repository is already linked to {boundSource.name}. Choose
              another repository.
            </p>
          )}
          {selected && existing?.path && !duplicateBinding && (
            <p>
              {connected
                ? "Already connected on this Mac."
                : existing?.folderState === "reconnect"
                  ? "Confirm the existing folder to reconnect it on this Mac."
                  : "Your existing folder will be linked to GitHub. No clone is needed."}
            </p>
          )}
          <div className="repository-dialog-footer">
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
                    checkingFolder ||
                    Boolean(duplicateBinding) ||
                    Boolean(loadError || matchingError) ||
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
          variant="primary"
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
      {(error || loadError || matchingError) && (
        <p role="alert">{error || loadError || matchingError}</p>
      )}
    </Overlay>
  );
}
