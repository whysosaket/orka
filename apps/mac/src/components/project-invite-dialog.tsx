import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MailIcon, XIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";
import { TextField } from "./text-field.js";

export function ProjectInviteDialog({
  title = "Invite member",
  projectId,
  projectName,
  onClose,
  onCloseAutoFocus,
}: {
  title?: string;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"email" | "link">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [joiningLink, setJoiningLink] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void invoke<{ email: boolean }>("cloud_action", {
      action: "invite-capabilities",
      input: {},
    })
      .then((capabilities) => {
        if (!active) return;
        setEmailAvailable(capabilities.email === true);
        if (!capabilities.email) setMode("link");
      })
      .catch(() => {
        if (!active) return;
        setEmailAvailable(false);
        setMode("link");
        setError(
          "Couldn’t check email delivery. You can still create a joining link.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    if (inFlight.current || emailAvailable === null) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "email") {
        const result = await invoke<{ sent: boolean; email: string }>(
          "cloud_action",
          {
            action: "invite",
            input: { projectId, email: email.trim().toLowerCase() },
          },
        );
        if (!result.sent)
          throw new Error(
            "Email invitations are unavailable. Use a joining link.",
          );
        setMessage(
          `Invitation sent to ${result.email}. It expires in 24 hours.`,
        );
        setEmail("");
      } else {
        let link = joiningLink;
        if (!link) {
          const result = await invoke<{ token: string; url?: string }>(
            "cloud_action",
            {
              action: "invite",
              input: { projectId },
            },
          );
          link = result.url ?? `orka://join/${result.token}`;
          setJoiningLink(link);
        }
        await navigator.clipboard.writeText(link);
        setMessage(
          "Joining link copied. It can be used once and expires in 24 hours.",
        );
      }
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/, ""));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Overlay
      open
      title={title}
      className="create-project-modal"
      onCloseAutoFocus={onCloseAutoFocus}
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <form
        className="create-project-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="create-project-heading">
          <h2>{title}</h2>
          <IconButton
            icon={XIcon}
            variant="tertiary"
            size="sm"
            aria-label={`Close ${title.toLowerCase()}`}
            disabled={busy}
            onClick={onClose}
          />
        </div>
        <div className="create-project-fields">
          <p>Invite a teammate to {projectName}.</p>
          {emailAvailable === null ? (
            <p role="status">Checking invitation options…</p>
          ) : mode === "email" ? (
            <TextField
              label="Email address"
              icon={MailIcon}
              type="email"
              autoFocus
              required
              maxLength={254}
              autoComplete="email"
              placeholder="teammate@example.com"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              hint="They’ll need to sign in with this email address to accept. Invitations expire after 24 hours."
            />
          ) : (
            <>
              <p>
                {emailAvailable
                  ? "Share a one-use joining link with your teammate."
                  : "Email invitations aren’t available on this service. Share a joining link instead."}
              </p>
              {joiningLink && (
                <TextField
                  label="Joining link"
                  value={joiningLink}
                  readOnly
                  onFocus={(event) => event.target.select()}
                  hint="Anyone with this link can use it once. It expires after 24 hours."
                />
              )}
            </>
          )}
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
          {emailAvailable && (
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() => {
                setMode(mode === "email" ? "link" : "email");
                setError("");
                setMessage("");
              }}
            >
              {mode === "email" ? "Use joining link" : "Invite by email"}
            </Button>
          )}
        </div>
        <div className="create-project-footer">
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            Done
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              emailAvailable === null ||
              (mode === "email" && !email.trim())
            }
          >
            {busy
              ? mode === "email"
                ? "Sending…"
                : "Copying…"
              : mode === "email"
                ? "Send invitation"
                : "Copy joining link"}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}
