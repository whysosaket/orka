import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
  CopyIcon,
  TerminalIcon,
} from "@primer/octicons-react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectResource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";
import { Textarea } from "./textarea.js";
import { CopyLinkButton } from "./copy-link-button.js";
import { ActionPopover } from "./resource-actions.js";
import { PermissionSelect } from "./permission-select.js";
import {
  sessionTool,
  type ResourceActionHandlers,
  type SessionLaunchOption,
  type SessionTool,
  type SessionDestination,
} from "./use-resource-actions.js";

function AppIcon({
  option,
  tool,
}: {
  option?: SessionLaunchOption;
  tool: SessionTool;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const icon = option?.icon;
  const localIcon = icon && icon !== failed ? icon : undefined;
  if (!localIcon && option?.destination !== "desktop" && option)
    return <Icon icon={TerminalIcon} />;
  return (
    <span className="ui-icon" aria-hidden="true">
      <img
        className="resume-source-icon"
        src={localIcon ?? `${import.meta.env.BASE_URL}source-icons/${tool}.svg`}
        alt=""
        draggable={false}
        onError={localIcon ? () => setFailed(localIcon) : undefined}
      />
    </span>
  );
}

export function SessionLauncher({
  resource,
  project,
  scope,
  busy,
  actions,
  onError,
}: {
  resource: ProjectResource;
  project: Project;
  scope: string;
  busy: boolean;
  actions: ResourceActionHandlers;
  onError: (message: string) => void;
}) {
  const tool = sessionTool(resource.source);
  const key = JSON.stringify([
    scope,
    resource.resourceId,
    resource.revision,
    resource.hash,
    resource.localForkId,
    project.id,
    project.path,
    project.sources,
  ]);
  const [state, setState] = useState<{
    key: string;
    options?: SessionLaunchOption[];
    error?: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [copyFailure, setCopyFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [terminalChoice, setTerminalChoice] = useState<{
    key: string;
    destination: SessionDestination;
  } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = state?.key === key ? state : null;
  const options = current?.options ?? [];
  const defaultOption =
    options.find((option) => option.isDefault) ?? options[0];
  const hosts = options.filter(
    (option, index) =>
      option.destination !== "desktop" &&
      options.findIndex((other) => other.destination === option.destination) ===
        index,
  );
  const host =
    (terminalChoice?.key === key &&
    hosts.some((option) => option.destination === terminalChoice.destination)
      ? terminalChoice.destination
      : undefined) ??
    (defaultOption?.destination !== "desktop"
      ? defaultOption?.destination
      : undefined) ??
    hosts[0]?.destination;
  const primary =
    defaultOption?.destination === "desktop"
      ? defaultOption
      : options.find(
          (option) =>
            option.tool === defaultOption?.tool && option.destination === host,
        );
  const targetLabel = (option: SessionLaunchOption) =>
    option.destination === "desktop"
      ? option.label
      : option.tool === "claude"
        ? "Claude Code CLI"
        : "Codex CLI";
  const label = primary
    ? targetLabel(primary)
    : tool === "claude"
      ? "Claude Desktop"
      : tool === "codex"
        ? "Codex"
        : "source app";
  const visibleOptions = options
    .filter(
      (option) =>
        option.destination === "desktop" || option.destination === host,
    )
    .sort((a, b) => Number(b === primary) - Number(a === primary));
  const forkOptions = visibleOptions.filter(
    (option) => option.tool === tool && option.mode === "resume",
  );
  const actionLabel =
    primary?.mode === "handoff"
      ? primary.destination === "desktop"
        ? `Continue in ${label}…`
        : `Start in ${label}`
      : primary?.mode === "fork" ||
          (!primary && !resource.fork && !resource.localForkId)
        ? `Fork and open in ${label}`
        : `Open in ${label}`;
  useEffect(() => {
    let cancelled = false;
    void invoke<SessionLaunchOption[]>("session_launch_options", {
      id: resource.resourceId,
    }).then(
      (options) => {
        if (!cancelled)
          setState(
            Array.isArray(options)
              ? { key, options }
              : { key, error: "Invalid launch options" },
          );
      },
      (error) => {
        if (!cancelled) setState({ key, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, resource.resourceId, refresh]);

  const renderOption = (option: SessionLaunchOption) => {
    const handoff = option.tool !== tool;
    return (
      <Button
        key={`${option.tool}:${option.destination}`}
        variant="tertiary"
        size="sm"
        role="menuitem"
        disabled={busy || !option.available}
        title={
          option.reason ??
          (handoff && option.destination !== "desktop"
            ? "Starts a new conversation immediately with the transferred context"
            : undefined)
        }
        onClick={() => void actions.resume(option)}
      >
        <AppIcon option={option} tool={option.tool} />
        <span className="session-launcher-option-text">
          <span>
            {handoff
              ? `Continue in ${targetLabel(option)}…`
              : option.mode === "fork"
                ? `Fork in ${targetLabel(option)}`
                : `Open in ${targetLabel(option)}`}
          </span>
          {option.reason ? (
            <span className="session-launcher-hint">{option.reason}</span>
          ) : handoff ? (
            <span className="session-launcher-hint">
              {option.destination === "desktop"
                ? "New conversation with context"
                : `Starts immediately in ${option.label} with context`}
            </span>
          ) : option.destination !== "desktop" ? (
            <span className="session-launcher-hint">
              {option.mode === "fork" ? "New fork" : "Existing session"} in{" "}
              {option.label}
            </span>
          ) : (
            <span className="session-launcher-hint">
              {option.mode === "fork"
                ? "Creates a new fork"
                : "Opens the existing session"}
            </span>
          )}
        </span>
        {option === primary && option.available && (
          <span className="session-launcher-default">Default</span>
        )}
      </Button>
    );
  };
  return (
    <div className="session-launcher">
      <Button
        variant="secondary"
        size="sm"
        className="session-launcher-open"
        aria-label={actionLabel}
        title={
          primary?.reason ??
          (current?.error
            ? "Open the menu to retry checking apps"
            : primary
              ? primary.mode === "handoff" && primary.destination !== "desktop"
                ? `Starts a new conversation immediately in ${label}`
                : actionLabel
              : current
                ? "No compatible app available"
                : "Checking apps…")
        }
        disabled={busy || !tool || !primary?.available}
        onClick={() => void actions.resume(primary)}
      >
        {tool && <AppIcon option={primary} tool={primary?.tool ?? tool} />}{" "}
        {actionLabel}
      </Button>
      <ActionPopover
        label="Open session"
        className="session-launcher-popover"
        onOpenChange={(open) => {
          if (open && current) setRefresh((value) => value + 1);
        }}
        trigger={
          <IconButton
            icon={ChevronDownIcon}
            size="sm"
            variant="secondary"
            className="session-launcher-trigger"
            aria-label="Choose how to open session"
            aria-haspopup="menu"
            disabled={busy}
          />
        }
      >
        <div
          ref={menu}
          role="menu"
          aria-label="Open session"
          onKeyDown={(event) => {
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ) ?? [],
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "ArrowDown"
                ? items[(index + 1) % items.length]
                : event.key === "ArrowUp"
                  ? items[(index - 1 + items.length) % items.length]
                  : event.key === "Home"
                    ? items[0]
                    : event.key === "End"
                      ? items[items.length - 1]
                      : undefined;
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }}
        >
          {current?.error ? (
            <div className="session-launcher-status" data-keep-open>
              <p role="status">Couldn’t check available apps.</p>
              <Button
                variant="tertiary"
                size="sm"
                onClick={() => setRefresh((value) => value + 1)}
              >
                Try again
              </Button>
            </div>
          ) : !current ? (
            <p className="session-launcher-status" role="status">
              Checking apps…
            </p>
          ) : (
            <>
              {visibleOptions.map(renderOption)}
              {forkOptions.length > 0 && (
                <div role="separator" className="session-launcher-separator" />
              )}
              {forkOptions.map((forkOption) => (
                <Button
                  key={`fork:${forkOption.tool}:${forkOption.destination}`}
                  variant="tertiary"
                  size="sm"
                  role="menuitem"
                  disabled={
                    busy || !(forkOption.forkAvailable ?? forkOption.available)
                  }
                  title={forkOption.forkReason ?? undefined}
                  onClick={() => void actions.resume(forkOption, true)}
                >
                  <AppIcon option={forkOption} tool={forkOption.tool} />
                  <span className="session-launcher-option-text">
                    <span>Fork and open in {targetLabel(forkOption)}</span>
                    <span className="session-launcher-hint">
                      {forkOption.forkReason ??
                        (forkOption.destination === "desktop"
                          ? "Creates another session"
                          : `Creates another session in ${forkOption.label}`)}
                    </span>
                  </span>
                </Button>
              ))}
              {options.length === 0 && (
                <p className="session-launcher-status">
                  No compatible app available.
                </p>
              )}
            </>
          )}
          <div role="separator" className="session-launcher-separator" />
          <CopyLinkButton
            value={key}
            label="Copy session prompt"
            errorTitle="Couldn’t copy session prompt"
            loadValue={actions.sessionPrompt}
            icon={CopyIcon}
            variant="tertiary"
            role="menuitem"
            disabled={busy}
            onError={(message) =>
              setCopyFailure(message ? { key, message } : null)
            }
          />
          <Button
            variant="tertiary"
            size="sm"
            role="menuitem"
            disabled={busy}
            onClick={() => void actions.exportZip()}
          >
            <Icon icon={DownloadIcon} /> Download session (.zip)…
          </Button>
        </div>
        {copyFailure?.key === key && (
          <p
            role="alert"
            className="session-launcher-status session-launcher-copy-error"
          >
            {copyFailure.message}
          </p>
        )}
        {hosts.length > 1 && host && (
          <div className="session-launcher-host" data-keep-open>
            <span>Terminal</span>
            <PermissionSelect
              label="Terminal application"
              value={host}
              disabled={busy}
              options={hosts.map((option) => ({
                value: option.destination,
                label: option.label,
              }))}
              onChange={(destination) =>
                setTerminalChoice({ key, destination })
              }
            />
          </div>
        )}
      </ActionPopover>
      {actions.manualCommand && (
        <Overlay
          open
          title={`Continue in ${actions.manualDestination}`}
          onClose={actions.dismissManualCommand}
          dismissOnBackdrop
        >
          <h2>Continue in {actions.manualDestination}</h2>
          <p>
            {actions.manualDestination} hasn’t confirmed startup. If the session
            isn’t already open, copy this command and run it there to continue.
            A cross-app continuation starts a new conversation when the command
            runs.
          </p>
          <Textarea
            label="Resume command"
            readOnly
            value={actions.manualCommand}
            rows={5}
          />
          <div className="actions">
            <Button onClick={actions.dismissManualCommand}>Close</Button>
            <CopyLinkButton
              label="Copy command"
              errorTitle="Couldn’t copy command"
              value={actions.manualCommand}
              onError={onError}
            />
          </div>
        </Overlay>
      )}
    </div>
  );
}
