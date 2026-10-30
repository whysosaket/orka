import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
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
import {
  sessionTool,
  type ResourceActionHandlers,
  type SessionLaunchOption,
  type SessionTool,
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
  const menu = useRef<HTMLDivElement>(null);
  const current = state?.key === key ? state : null;
  const options = current?.options ?? [];
  const primary = options.find(
    (option) => option.tool === tool && option.destination === "desktop",
  );
  const label =
    tool === "claude"
      ? "Claude Desktop"
      : tool === "codex"
        ? "Codex"
        : "source app";
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
          (option.destination !== "desktop"
            ? `Resume with ${tool === "claude" ? "Claude Code" : "Codex CLI"}`
            : undefined)
        }
        onClick={() => void actions.resume(option)}
      >
        <AppIcon option={option} tool={option.tool} />
        <span className="session-launcher-option-text">
          <span>{handoff ? `Continue in ${option.label}…` : option.label}</span>
          {option.reason ? (
            <span className="session-launcher-hint">{option.reason}</span>
          ) : handoff ? (
            <span className="session-launcher-hint">
              New conversation with context
            </span>
          ) : null}
        </span>
        {!handoff && option.destination === "desktop" && (
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
        aria-label={`Open in ${label}`}
        title={
          primary?.reason ??
          (current?.error
            ? "Open the menu to retry checking apps"
            : primary
              ? `Open in ${label}`
              : "Checking apps…")
        }
        disabled={busy || !tool || !primary?.available}
        onClick={() => void actions.resume(primary)}
      >
        {tool && <AppIcon option={primary} tool={tool} />} Open in {label}
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
              {options
                .filter((option) => option.tool === tool)
                .map(renderOption)}
              <div role="separator" className="session-launcher-separator" />
              {options
                .filter((option) => option.tool !== tool)
                .map(renderOption)}
            </>
          )}
          <div role="separator" className="session-launcher-separator" />
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
      </ActionPopover>
      {actions.manualCommand && (
        <Overlay
          open
          title="Continue in Warp"
          onClose={actions.dismissManualCommand}
          dismissOnBackdrop
        >
          <h2>Continue in Warp</h2>
          <p>
            Warp hasn’t confirmed startup. If the session isn’t already open,
            copy this command and run it there to continue.
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
