import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlugIcon, XIcon } from "lucide-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";

export interface PluginAccount {
  id: string;
  email: string | null;
  displayName: string | null;
}

interface Authorization {
  requestId: string;
  account: PluginAccount;
  serviceOrigin: string;
  client: { id: string; name: string };
  scopes: string[];
  permissionDescriptions: string[];
  expiresAt: string;
  verified?: boolean;
}

export function PluginAuthorization({
  request,
  scope,
  onClose,
  automatic = false,
}: {
  request: { requestId: string; scope: string };
  scope: string;
  onClose: () => void;
  automatic?: boolean;
}) {
  const [preview, setPreview] = useState<Authorization | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const changed = request.scope !== scope;
  useEffect(() => {
    if (changed) {
      onClose();
      return;
    }
    let stopped = false;
    void invoke<Authorization | null>("plugin_authorization", {
      operation: "preview",
      input: {
        requestId: request.requestId,
        ...(automatic && { automatic: true }),
      },
    }).then(
      (result) => {
        if (stopped) return;
        if (!result) {
          onClose();
          return;
        }
        setPreview(result);
        setScopes(result.scopes);
      },
      (failure: unknown) => {
        if (!stopped) setError(String(failure));
      },
    );
    return () => {
      stopped = true;
    };
  }, [request.requestId, changed, attempt, onClose, automatic]);
  useEffect(() => {
    if (!preview || approved) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    const timer = window.setTimeout(onClose, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [preview, approved, onClose]);
  useEffect(() => {
    if (!automatic || changed || approved || busy) return;
    let stopped = false;
    let timer: number;
    const check = async () => {
      try {
        const pending = await invoke<{ requestId: string }[]>(
          "plugin_connection_requests",
        );
        if (
          !stopped &&
          !pending.some((item) => item.requestId === request.requestId)
        ) {
          onClose();
          return;
        }
      } catch {
        // A temporary native error can be checked again on the next poll.
      }
      if (!stopped) timer = window.setTimeout(() => void check(), 1000);
    };
    timer = window.setTimeout(() => void check(), 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [automatic, request.requestId, changed, approved, busy, onClose]);
  const close = async () => {
    if (busy) return;
    if (!approved) {
      setBusy(true);
      try {
        await invoke("plugin_authorization", {
          operation: "cancel",
          input: { requestId: request.requestId },
        });
      } catch {
        // Unapproved requests also expire in the native broker.
      }
    }
    onClose();
  };
  const approve = async () => {
    if (!preview || busy || changed) return;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ approved: boolean } | null>(
        "plugin_authorization",
        {
          operation: "approve",
          input: { requestId: preview.requestId, scopes },
        },
      );
      if (result?.approved) setApproved(true);
      else onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay
      open
      title="Connect to Orka"
      onClose={() => void close()}
      className="plugin-authorization"
    >
      <header className="review-header plugin-authorization-heading">
        <h2>Connect to Orka</h2>
        <IconButton
          icon={XIcon}
          aria-label="Close connection"
          variant="tertiary"
          size="sm"
          disabled={busy}
          onClick={() => void close()}
        />
      </header>
      {!approved && error && (
        <p role="alert" className="connector-feedback" tabIndex={0}>
          {error}
        </p>
      )}
      <div
        className="plugin-authorization-content"
        aria-busy={busy}
        role="region"
        aria-label="Connection details"
        tabIndex={0}
      >
        {approved ? (
          <p role="status">
            Connection approved. Return to your assistant to use Orka.
          </p>
        ) : (
          <>
            {!preview && !error && (
              <p role="status">Checking connection request…</p>
            )}
            {preview && (
              <>
                <div className="connector-identity">
                  <div className="connector-icon" aria-hidden="true">
                    <PlugIcon size={24} />
                  </div>
                  <div>
                    <h3>{preview.client.name}</h3>
                    <p>Requests access through Orka on this Mac.</p>
                  </div>
                </div>
                <dl
                  className="plugin-connection-identity connector-consent-account"
                  aria-label="Account on this Mac"
                >
                  <div>
                    <dt>Account</dt>
                    <dd>
                      {preview.account.displayName ||
                        preview.account.email ||
                        preview.account.id}
                      {preview.account.email && preview.account.displayName && (
                        <span>{preview.account.email}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>{preview.serviceOrigin}</dd>
                  </div>
                </dl>
                <section
                  className="connector-consent-access"
                  aria-labelledby="connector-access-title"
                >
                  <h3 id="connector-access-title">Requested access</h3>
                  <ul
                    className="plugin-permissions"
                    aria-label="Requested permissions"
                  >
                    {preview.permissionDescriptions.map((description, i) => (
                      <li key={preview.scopes[i]}>
                        <label className="connector-permission">
                          <input
                            type="checkbox"
                            checked={scopes.includes(preview.scopes[i]!)}
                            disabled={busy || preview.scopes[i] === "orka.read"}
                            onChange={(event) => {
                              const selected = preview.scopes[i]!;
                              setScopes((current) =>
                                event.target.checked
                                  ? [...current, selected]
                                  : current.filter(
                                      (value) => value !== selected,
                                    ),
                              );
                            }}
                          />
                          <span>{description}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
                <p className="connector-consent-note">
                  {preview.verified
                    ? "Orka verified this app on your Mac and will remember your choices when it reconnects. Switching accounts or services requires a new approval."
                    : "Orka uses the name reported by this assistant. Access lasts until the assistant quits."}
                </p>
              </>
            )}
          </>
        )}
      </div>
      <footer className="review-footer plugin-authorization-actions">
        <Button disabled={busy} onClick={() => void close()}>
          {approved ? "Done" : "Cancel"}
        </Button>
        {error && !changed && !approved && (
          <Button
            disabled={busy}
            onClick={() => {
              setError("");
              setPreview(null);
              setAttempt((value) => value + 1);
            }}
          >
            Retry connection
          </Button>
        )}
        {!approved && (
          <Button
            variant="primary"
            disabled={!preview || busy || changed || Boolean(error)}
            onClick={() => void approve()}
          >
            {busy ? "Connecting…" : "Allow connection"}
          </Button>
        )}
      </footer>
    </Overlay>
  );
}
