import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLinkIcon, PlugIcon } from "lucide-react";
import type { Snapshot } from "../../types.js";
import {
  PluginAuthorization,
  type PluginAccount,
} from "../plugin-authorization.js";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import { SettingsHeading, settingsScope } from "./settings-shared.js";

interface ConnectionStatus {
  state:
    "not_linked" | "linked" | "pending" | "reconnect_required" | "signed_out";
  account: PluginAccount | null;
  serviceOrigin: string | null;
  connections: {
    id: string;
    client: { id: string; name: string };
    scopes: string[];
    state: string;
    connectedAt: string | null;
    sessionCount?: number;
    remembered?: boolean;
    requestId?: string;
  }[];
  pendingCount: number;
  reason: string | null;
  reconnectRequired: boolean;
}

export function SettingsPluginConnections({ state }: { state: Snapshot }) {
  const scope = settingsScope(state);
  const [cached, setCached] = useState<{
    scope: string;
    status: ConnectionStatus;
  } | null>(null);
  const result = cached?.scope === scope ? cached.status : null;
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [checked, setChecked] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef<Promise<ConnectionStatus> | null>(null);
  const check = useRef<() => void>(() => {});
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [request, setRequest] = useState<{
    requestId: string;
    scope: string;
  } | null>(null);
  const closeRequest = useCallback(() => {
    setRequest(null);
    setRevision((value) => value + 1);
  }, []);
  const [setupError, setSetupError] = useState("");
  const installationUrl =
    "https://github.com/quaylabshq/orka/blob/main/plugins/orka/README.md#connect";
  const revoke = async (connectionId: string) => {
    setRevoking(connectionId);
    setActionError("");
    try {
      await invoke("plugin_authorization", {
        operation: "revoke",
        input: { connectionId },
      });
      setRevision((value) => value + 1);
    } catch (failure) {
      setActionError(String(failure));
    } finally {
      setRevoking(null);
    }
  };
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let manualRequested = false;
    setError("");
    setChecked(false);
    setChecking(true);
    const refresh = async (kind: "initial" | "manual" | "background") => {
      if (stopped || (kind === "background" && document.hidden)) return;
      if (kind === "manual") {
        manualRequested = true;
        setChecked(false);
        setChecking(true);
      }
      if (pending) return;
      pending = true;
      let request: Promise<ConnectionStatus> | null = null;
      try {
        // A response from an old account/service must finish before starting a
        // fresh check, but must never be displayed in the new scope.
        while (inFlight.current) {
          await inFlight.current.catch(() => {});
          if (stopped) return;
        }
        request = invoke<ConnectionStatus>("plugin_connection_status");
        inFlight.current = request;
        const status = await request;
        if (!stopped) {
          setCached({ scope, status });
          setError("");
          if (manualRequested) setChecked(true);
        }
      } catch (failure) {
        if (!stopped) {
          setError(String(failure));
          setChecked(false);
        }
      } finally {
        if (request && inFlight.current === request) inFlight.current = null;
        pending = false;
        manualRequested = false;
        if (!stopped) setChecking(false);
      }
    };
    check.current = () => void refresh("manual");
    void refresh("initial");
    const timer = window.setInterval(() => void refresh("background"), 5000);
    const focus = () => void refresh("background");
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [scope, revision]);
  const title = error
    ? "Couldn’t check connection"
    : !result
      ? "Checking connection…"
      : result.state === "linked"
        ? "Approved on this Mac"
        : result?.state === "reconnect_required"
          ? "Reconnect required"
          : result?.state === "pending"
            ? "Approval pending"
            : result?.state === "signed_out"
              ? "Sign in to connect"
              : "Not connected";
  return (
    <>
      <SettingsHeading
        title="Connectors"
        description="Connect assistants to the Orka account on this Mac."
      />
      <section
        className="settings-group connector-card"
        aria-label="Orka connector"
      >
        <div className="connector-identity connector-card-section">
          <div className="connector-icon" aria-hidden="true">
            <PlugIcon size={24} />
          </div>
          <div>
            <h3>Orka desktop</h3>
            <p role="status">
              {checked && result && !error && "Connection checked. "}
              {title}
            </p>
          </div>
        </div>
        {result && (
          <dl
            className="plugin-connection-identity connector-card-section"
            aria-label="Account on this Mac"
          >
            <div>
              <dt>Account</dt>
              <dd>
                {result.account?.displayName ||
                  result.account?.email ||
                  result.account?.id ||
                  "Signed out"}
                {result.account?.email && result.account.displayName && (
                  <span>{result.account.email}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd>{result.serviceOrigin || "No service selected"}</dd>
            </div>
          </dl>
        )}
        <div className="connector-card-section connector-card-actions">
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            result &&
            (result.state === "linked" ? (
              <p>Connected assistants use this account. Manage access below.</p>
            ) : (
              <p>
                {result.reason ||
                  "Connect Orka from your assistant, then review its request here."}
              </p>
            ))
          )}
          <Button
            className="connector-action-button"
            size="sm"
            disabled={checking}
            onClick={() => check.current()}
          >
            {checking ? "Checking…" : "Check connection"}
          </Button>
        </div>
      </section>
      {result && result.connections.length > 0 && (
        <section
          className="settings-group connector-card"
          aria-label="Connector sessions"
        >
          {result.connections.map((connection) => (
            <div
              className="connector-card-section connector-session"
              key={connection.id}
            >
              <div>
                <h3>{connection.client.name}</h3>
                <p>
                  {connection.state === "approved" ||
                  connection.state === "idle"
                    ? connection.scopes
                        .map(
                          (value) =>
                            ({
                              "orka.read": "Read",
                              "orka.write": "Write",
                              "orka.manage": "Manage",
                            })[value] ?? value,
                        )
                        .join(" · ")
                    : connection.state === "pending"
                      ? "Awaiting approval"
                      : connection.state === "denied"
                        ? "Access removed"
                        : "Reconnect required"}
                </p>
                {connection.state === "idle" && <p>No active sessions</p>}
                {connection.state === "idle" && connection.remembered && (
                  <p>Access saved for next time</p>
                )}
                {connection.state === "approved" &&
                  (connection.sessionCount ?? 0) > 1 && (
                    <p>{connection.sessionCount} active sessions</p>
                  )}
              </div>
              {connection.state === "pending" && connection.requestId && (
                <Button
                  size="sm"
                  onClick={() =>
                    setRequest({ requestId: connection.requestId!, scope })
                  }
                >
                  Review request
                </Button>
              )}
              {(connection.state === "approved" ||
                connection.state === "idle") && (
                <Button
                  size="sm"
                  disabled={revoking !== null}
                  onClick={() => void revoke(connection.id)}
                >
                  {revoking === connection.id ? "Revoking…" : "Revoke access"}
                </Button>
              )}
            </div>
          ))}
          {actionError && (
            <p role="alert" className="connector-card-section">
              {actionError}
            </p>
          )}
        </section>
      )}
      <section
        className="settings-group connector-setup"
        aria-labelledby="connector-setup-title"
      >
        <div>
          <h3 id="connector-setup-title">Connect or reconnect</h3>
          <ol>
            <li>
              Install the desktop Orka plugin in your assistant and connect.
            </li>
            <li>
              Review new requests here. Orka remembers access for verified
              assistants on this Mac.
            </li>
            <li>
              After an account or service change, reconnect in your assistant
              and review the new request here.
            </li>
          </ol>
        </div>
        <Button
          className="connector-action-button"
          size="sm"
          onClick={() => {
            setSetupError("");
            void invoke("open_web_link", { url: installationUrl }).catch(() =>
              setSetupError(
                `Couldn’t open your browser. Open ${installationUrl} to view installation instructions.`,
              ),
            );
          }}
        >
          Installation instructions
          <Icon icon={ExternalLinkIcon} />
        </Button>
        {setupError && <p role="alert">{setupError}</p>}
      </section>
      {request && (
        <PluginAuthorization
          key={request.requestId}
          request={request}
          scope={scope}
          onClose={closeRequest}
        />
      )}
    </>
  );
}
