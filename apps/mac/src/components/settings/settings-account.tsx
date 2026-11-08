import { useState } from "react";
import { ServerIcon } from "@primer/octicons-react";
import type { Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import { ServiceConnection } from "../service-connection.js";
import { useAccount } from "../use-account.js";

/** A separate draft prevents canceled service edits from leaking into sign-in. */
export function SettingsAccount({
  state,
  busy,
  run,
  onDirty,
  onSignedOut,
  onStart,
}: {
  state: Snapshot;
  busy: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
  onSignedOut: () => void;
  onStart: (action: () => void) => void;
}) {
  const account = useAccount(state.config);
  const [stage, setStage] = useState<"current" | "choose" | "review">(
    "current",
  );
  const changed =
    account.url.trim() !== state.config?.apiUrl ||
    account.mode !== (state.config?.mode ?? "cloud");
  return (
    <>
      <div className="settings-row">
        <div>
          <h3>Current service</h3>
          <p>
            {state.config?.mode === "self-hosted"
              ? "Self-hosted"
              : "Orka Cloud"}
          </p>
          {state.config?.mode === "self-hosted" && (
            <p className="settings-path">{state.config?.apiUrl}</p>
          )}
        </div>
        {stage === "current" ? (
          <Button
            className="settings-service-action"
            onClick={() => {
              onStart(() => {
                setStage("choose");
                onDirty(true);
              });
            }}
          >
            <Icon icon={ServerIcon} />
            {state.config?.mode === "self-hosted"
              ? "Change service"
              : "Move to self-hosted"}
          </Button>
        ) : (
          <div className="settings-service-setup">
            <h3>
              {stage === "choose"
                ? "Choose a service"
                : "Review service change"}
            </h3>
            {stage === "choose" ? (
              <>
                <ServiceConnection
                  showHelp={false}
                  mode={account.mode}
                  url={account.url}
                  busy={busy}
                  onModeChange={(mode) => {
                    void run(() => account.changeMode(mode));
                  }}
                  onUrlChange={account.setUrl}
                />
                {account.connectionError && (
                  <p role="alert">
                    {account.connectionError}{" "}
                    <Button disabled={busy} onClick={account.retryConnection}>
                      Check again
                    </Button>
                  </p>
                )}
                {!account.capabilities &&
                  !account.connectionError &&
                  account.url && <p role="status">Checking service…</p>}
                <Button
                  disabled={busy || !changed || !account.capabilities}
                  onClick={() => setStage("review")}
                >
                  Review change
                </Button>
              </>
            ) : (
              <>
                <p>
                  Connect to{" "}
                  <strong>
                    {account.mode === "cloud" ? "Orka Cloud" : "Self-hosted"}
                  </strong>
                </p>
                <p className="settings-path">{account.url.trim()}</p>
                <p>
                  You’ll be signed out. Existing projects and queued changes
                  stay with the current service and account.
                </p>
                <div className="settings-inline-actions">
                  <Button disabled={busy} onClick={() => setStage("choose")}>
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || !account.capabilities}
                    onClick={() => {
                      void run(account.switchService).then((saved) => {
                        if (saved) onSignedOut();
                      });
                    }}
                  >
                    Switch service and sign in
                  </Button>
                </div>
              </>
            )}
            <Button
              disabled={busy}
              onClick={() => {
                account.resetConnection();
                setStage("current");
                onDirty(false);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
