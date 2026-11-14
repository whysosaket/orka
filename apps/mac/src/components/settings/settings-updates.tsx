import {
  CheckCircleIcon,
  DownloadIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { Button } from "../button.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { UpdateChangelog, UpdateInstallation } from "../desktop-updates.js";
import type { DesktopUpdates } from "../use-desktop-updates.js";
import { SettingsHeading } from "./settings-shared.js";

export function SettingsUpdates({ updates }: { updates: DesktopUpdates }) {
  const { status, checking, installing, checkedAt, error } = updates;
  const release = status?.update ?? status?.release;
  const unsupported = status?.supported === false;
  const title = checking
    ? "Checking for updates…"
    : error
      ? "Couldn’t check for updates"
      : unsupported
        ? "Updates are unavailable for this build"
        : status?.update
          ? `Orka ${status.update.version} is available`
          : checkedAt
            ? "Orka is up to date"
            : "Check for the latest version";
  const StatusIcon = status?.update
    ? DownloadIcon
    : checkedAt && !error
      ? CheckCircleIcon
      : SyncIcon;
  return (
    <>
      <SettingsHeading
        title="Updates"
        description="Keep Orka up to date on this Mac."
      />
      <section
        className="settings-update-card settings-group"
        aria-label="Application updates"
        aria-busy={checking}
      >
        <div className="settings-update-identity">
          <div className="settings-update-icon" aria-hidden="true">
            <StatusIcon size={24} />
          </div>
          <div>
            <h3>Orka</h3>
            <p>
              {status?.installedVersion
                ? `Version ${status.installedVersion}`
                : checking
                  ? "Checking installed version…"
                  : "Installed version unavailable"}
            </p>
          </div>
        </div>
        <div className="settings-update-status">
          <strong role={installing ? undefined : "status"}>{title}</strong>
          {error ? (
            <p role="alert">{error}</p>
          ) : unsupported ? (
            <p>{status.message}</p>
          ) : status?.update ? (
            <p>Ready when you are. Orka will restart to finish updating.</p>
          ) : (
            <p>Orka checks when it opens and every four hours while running.</p>
          )}
          {checkedAt && (
            <p className="settings-update-checked">
              Last checked{" "}
              <time dateTime={checkedAt.toISOString()}>
                {checkedAt.toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </p>
          )}
        </div>
        <div className="settings-update-actions">
          {status?.update && <UpdateInstallation updates={updates} />}
          <Button
            disabled={checking || installing || unsupported}
            onClick={() => void updates.check(true)}
          >
            {checking && <ActivityIndicator />}
            {checking ? "Checking…" : "Check for Updates"}
          </Button>
        </div>
      </section>
      {release && (
        <section
          className="settings-update-release"
          aria-label="Release information"
          key={release.version}
        >
          <details className="settings-group settings-update-notes">
            <summary>
              <span>Release notes</span>
              <span className="settings-update-release-version">
                Version {release.version}
              </span>
            </summary>
            <div className="settings-update-notes-content">
              <p>
                {release.notes.trim() ||
                  "Read the full changelog for details about this release."}
              </p>
              <UpdateChangelog version={release.version} updates={updates} />
            </div>
          </details>
          {!status?.update && updates.actionError && (
            <p role="alert">{updates.actionError}</p>
          )}
        </section>
      )}
    </>
  );
}
