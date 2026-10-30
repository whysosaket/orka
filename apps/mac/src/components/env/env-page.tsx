import {
  LockIcon,
  PlusIcon,
  ShieldCheckIcon,
  SyncIcon,
} from "@primer/octicons-react";
import type { Project } from "../../types.js";
import { Button } from "../button.js";
import { IconButton } from "../icon-button.js";
import { TextField } from "../text-field.js";
import { EnvSetList } from "./env-set-list.js";
import { useEnvironments } from "./use-environments.js";
import { EnvDetail } from "./env-detail.js";
import { EnvDialogs } from "./env-dialogs.js";
import { ENV_ENABLED } from "../../lib/features.js";

export function EnvPage(props: {
  project: Project;
  user: string;
  initialSet?: string;
  repository: string;
  onSettings: () => void;
  onGovernance?: (id: string, title: string) => void;
}) {
  if (!ENV_ENABLED) return null;
  if (props.project.sharing && !props.project.sharing.env) {
    return (
      <section
        className="env-page"
        aria-label="Encrypted environment variables"
      >
        <div className="env-empty">
          <LockIcon size={24} />
          <h2>ENV sharing is off for this project</h2>
          <p>
            Enable ENVs in Project sharing, then review keys and recipients
            before publishing an encrypted set.
          </p>
          <Button onClick={props.onSettings}>Open sharing settings</Button>
        </div>
      </section>
    );
  }
  return <EnabledEnvPage {...props} />;
}

function EnabledEnvPage({
  project,
  user,
  initialSet,
  repository,
  onGovernance,
}: {
  project: Project;
  user: string;
  initialSet?: string;
  repository: string;
  onGovernance?: (id: string, title: string) => void;
}) {
  const c = useEnvironments(project, user, initialSet, repository);
  const enabled = c.capability?.supported && c.capability.enabled;
  return (
    <section className="env-page" aria-label="Encrypted environment variables">
      {enabled && (
        <div
          className="env-header-actions"
          role="group"
          aria-label="ENV actions"
        >
          <IconButton
            icon={SyncIcon}
            size="sm"
            aria-label="Refresh ENVs"
            disabled={Boolean(c.busy)}
            onClick={() => void c.run("Refreshing…", c.load)}
          />
          <Button
            aria-label="Approve a Mac"
            title={
              c.hasUnpublishedChanges
                ? "Publish or discard your draft before approving a Mac"
                : "Approve a Mac"
            }
            size="sm"
            disabled={Boolean(c.busy) || c.hasUnpublishedChanges}
            onClick={() => {
              c.setCode("");
              c.setApprovalInfo(null);
              c.setModal("approve");
            }}
          >
            <ShieldCheckIcon size={14} />
            <span className="workspace-action-label">Approve a Mac</span>
          </Button>
          {Boolean(c.listing?.sets.length || c.draft) && (
            <Button
              aria-label="New ENV set"
              title="New ENV set"
              size="sm"
              variant="primary"
              disabled={Boolean(c.busy)}
              onClick={c.newSet}
            >
              <PlusIcon size={14} />
              <span className="workspace-action-label">New ENV set</span>
            </Button>
          )}
        </div>
      )}
      {c.busy && (
        <p role="status" className="env-status">
          {c.busy}
        </p>
      )}
      {c.error && !c.modal && (
        <div role="alert" className="env-status">
          {c.error}
          {enabled && (
            <Button
              size="sm"
              variant="tertiary"
              onClick={() => void c.run("Refreshing…", c.load)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {!c.capability && !c.busy && (
        <div className="env-empty">
          <h2>Couldn’t check ENV availability</h2>
          <p>Your local files are unchanged.</p>
          <Button onClick={() => void c.checkAvailability()}>
            Retry connection
          </Button>
        </div>
      )}
      {c.capability && !c.capability.supported && (
        <div className="env-empty">
          <LockIcon size={24} />
          <h2>This service needs an update</h2>
          <p>
            Update the Orka service to enable encrypted ENV sharing. Memories,
            skills, and sessions remain available.
          </p>
          <Button size="sm" onClick={() => void c.checkAvailability()}>
            Check again
          </Button>
        </div>
      )}
      {c.capability?.supported && !c.capability.enabled && (
        <div className="env-empty env-onboard">
          <ShieldCheckIcon size={24} />
          <h2>Enable ENVs on this Mac</h2>
          <p>
            Share environment variables with your project. Private keys stay in
            macOS Keychain; new Macs need approval before they can read a set.
          </p>
          <TextField
            label="This Mac’s name"
            value={c.name}
            maxLength={100}
            placeholder="My MacBook"
            onChange={(e) => c.setName(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={Boolean(c.busy) || !c.name.trim()}
            onClick={() =>
              void c.run("Creating keys in Keychain…", async () => {
                await c.env("enable", { name: c.name });
                c.setCapability({ supported: true, enabled: true });
                c.setName("");
                await c.load();
              })
            }
          >
            Enable ENVs
          </Button>
        </div>
      )}
      {c.listing?.pending.map((item) => (
        <div className="env-status" key={item.id}>
          <span>
            Unconfirmed publication: <strong>{item.name}</strong>
          </span>
          <Button
            size="sm"
            disabled={
              Boolean(c.busy) ||
              (c.hasUnpublishedChanges && c.draft?.setId !== item.setId)
            }
            title={
              c.hasUnpublishedChanges && c.draft?.setId !== item.setId
                ? "Publish or discard your draft before retrying another publication"
                : undefined
            }
            onClick={() =>
              void c.run("Retrying encrypted publication…", async () => {
                await c.published(await c.env("retry", { pendingId: item.id }));
              })
            }
          >
            Retry publication
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            disabled={Boolean(c.busy)}
            onClick={() =>
              void c.run("Discarding retry…", async () => {
                await c.env("discard", { pendingId: item.id });
                await c.load();
              })
            }
          >
            Discard retry
          </Button>
        </div>
      ))}
      {c.listing?.responses?.map((item) => (
        <div className="env-status" key={item.code}>
          <span>
            Approval response for {item.device} · available for 24 hours
          </span>
          <Button
            size="sm"
            onClick={() => {
              c.setOutputCode(item.code);
              c.setModal("code");
            }}
          >
            Show response
          </Button>
        </div>
      ))}
      {enabled && (
        <div className="env-layout">
          <EnvSetList c={c} repository={repository} />
          <EnvDetail
            c={c}
            repository={repository}
            onGovernance={onGovernance}
          />
        </div>
      )}
      <EnvDialogs c={c} />
    </section>
  );
}
