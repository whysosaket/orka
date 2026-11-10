import React, { useEffect, useRef, useState } from "react";
import { Button } from "./button.js";
import type { ServiceMode } from "../types.js";
import type { Account } from "./use-account.js";
import { sameServiceUrl } from "./project-invite.js";
import { SignInEntry } from "./sign-in-entry.js";
import { SelfHostedConnection } from "./self-hosted-connection.js";
import { PendingSignIn } from "./pending-sign-in.js";
import { AuthRecovery } from "./auth-recovery.js";

type SignInStep = "entry" | "login" | "service" | "server-error";

export function SignInForm({
  account,
  busy,
  error,
  act,
  invite,
}: {
  account: Account;
  busy: boolean;
  error: string;
  act: (action: () => Promise<unknown>) => Promise<void>;
  invite?: { serviceUrl?: string; onCancel: () => void };
}) {
  const [selectedStep, setStep] = useState<SignInStep | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const [storageRecovery, setStorageRecovery] = useState<
    "keychain" | "locked-keychain" | null
  >(null);
  const [serverReturn, setServerReturn] = useState<{
    step: "entry" | "login";
    mode: ServiceMode;
  }>({ step: "entry", mode: "cloud" });
  const heading = useRef<HTMLHeadingElement>(null);
  const methods = account.capabilities?.auth;
  const step =
    selectedStep ??
    (account.mode === "self-hosted"
      ? account.configured
        ? "login"
        : "service"
      : methods?.password && !methods.magicLink && !methods.github
        ? "login"
        : "entry");
  const password = Boolean(
    methods?.password && (usePassword || !methods.magicLink),
  );
  const ready = !busy && Boolean(methods);
  const pending = account.pending;
  const keychainError = /keychain/i.test(error);
  const recoveryKind = keychainError
    ? /locked|interaction not allowed|interaction required|-25308/i.test(error)
      ? "locked-keychain"
      : "keychain"
    : storageRecovery;
  useEffect(() => {
    if (keychainError)
      setStorageRecovery(
        /locked|interaction not allowed|interaction required|-25308/i.test(
          error,
        )
          ? "locked-keychain"
          : "keychain",
      );
  }, [keychainError, error]);

  useEffect(() => {
    heading.current?.focus();
  }, [step, pending, keychainError]);

  const navigate = (next: SignInStep, mode = account.mode) =>
    void act(async () => {
      await account.changeMode(mode);
      setStorageRecovery(null);
      setUsePassword(false);
      setStep(next);
    });
  const inviteNotice = invite && (
    <div className="auth-status" role="status">
      <p>
        {invite.serviceUrl
          ? `Sign in to ${invite.serviceUrl} to review and join the project.`
          : "Sign in to review and join the project."}{" "}
        Your invite is ready.
      </p>
      {invite.serviceUrl &&
        !sameServiceUrl(invite.serviceUrl, account.url.trim()) && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await account.switchService(invite.serviceUrl);
                setStep("login");
                setUsePassword(false);
              })
            }
          >
            Use invite service
          </Button>
        )}
      <Button variant="tertiary" disabled={busy} onClick={invite.onCancel}>
        Dismiss invite
      </Button>
    </div>
  );

  if (recoveryKind)
    return (
      <AuthRecovery
        kind={recoveryKind}
        busy={busy}
        headingRef={heading}
        onRetry={() =>
          void act(async () => {
            await account.retryKeychain();
            setStorageRecovery(null);
          })
        }
        onBack={() => navigate("login")}
      />
    );

  const connect = () =>
    void act(async () => {
      try {
        await account.connect();
        setUsePassword(false);
        setStep("login");
      } catch (e) {
        if (
          /cannot reach|can’t reach|unavailable|timed? ?out|network|connection refused/i.test(
            String(e),
          )
        )
          setStep("server-error");
        throw e;
      }
    });
  if (step === "server-error")
    return (
      <AuthRecovery
        kind="server"
        server={account.url}
        busy={busy}
        headingRef={heading}
        onRetry={connect}
        onBack={() => navigate("service", "self-hosted")}
      />
    );

  if (pending) {
    return (
      <PendingSignIn
        account={account}
        busy={busy}
        error={error}
        headingRef={heading}
        onRetry={() => void act(() => account.begin(pending))}
        onCode={(code) => void act(() => account.complete(null, code))}
        onBack={() => navigate(step === "entry" ? "entry" : "login")}
      >
        {inviteNotice}
      </PendingSignIn>
    );
  }

  if (step === "service") {
    return (
      <SelfHostedConnection
        account={account}
        busy={busy}
        error={error}
        headingRef={heading}
        onConnect={connect}
        onBack={() => navigate(serverReturn.step, serverReturn.mode)}
        onSignIn={() => navigate("login", "cloud")}
      >
        {inviteNotice}
      </SelfHostedConnection>
    );
  }

  return (
    <SignInEntry
      account={account}
      busy={busy}
      ready={ready}
      error={error || account.connectionError}
      variant={step === "login" ? "sign-in" : "sign-up"}
      password={password}
      headingRef={heading}
      onEmail={() =>
        void act(password ? account.signIn : () => account.begin("magic-link"))
      }
      onGitHub={() => void act(() => account.begin("github"))}
      onSwitch={() => navigate(step === "login" ? "entry" : "login", "cloud")}
      onPassword={() => {
        account.setPassword("");
        setUsePassword(!usePassword);
      }}
      onSelfHosted={() => {
        setServerReturn({ step, mode: account.mode });
        navigate("service", "self-hosted");
      }}
    >
      {inviteNotice}
    </SignInEntry>
  );
}
