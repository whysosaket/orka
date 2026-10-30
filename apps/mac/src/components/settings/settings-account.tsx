import { useState } from "react";
import type { Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { ServiceConnection } from "../service-connection.js";
import { useAccount } from "../use-account.js";
import { useMemberLabel } from "../member-names.js";

/** A separate draft prevents canceled service edits from leaking into sign-in. */
export function SettingsAccount({
  state,
  busy,
  run,
  onDirty,
  onSignedOut,
}: {
  state: Snapshot;
  busy: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
  onSignedOut: () => void;
}) {
  const account = useAccount(state.config);
  const memberName = useMemberLabel(state.user);
  const [stage, setStage] = useState<"current" | "choose" | "review">(
    "current",
  );
  const changed =
    account.url.trim() !== state.config?.apiUrl ||
    account.mode !== (state.config?.mode ?? "cloud");
  return (
    <>
      <div className="settings-detail">
        <h3>Account</h3>
        <p className="settings-path">{memberName(state.user)}</p>
      </div>
      <div className="settings-detail">
        <h3>Current service</h3>
        <p>
          {state.config?.mode === "self-hosted" ? "Self-hosted" : "Orka Cloud"}
        </p>
        <p className="settings-path">{state.config?.apiUrl}</p>
      </div>
      {stage === "current" ? (
        <Button
          onClick={() => {
            setStage("choose");
            onDirty(true);
          }}
        >
          Change service
        </Button>
      ) : (
        <div className="settings-service-setup">
          <h3>
            {stage === "choose" ? "Choose a service" : "Review service change"}
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
                <p role="alert">{account.connectionError}</p>
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
                You’ll be signed out. Existing projects and queued changes stay
                with the current service and account.
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
        </div>
      )}
    </>
  );
}
