import React, { useRef, useState } from "react";
import { MarkGithubIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { TextField } from "./text-field.js";
import type { Account } from "./use-account.js";
import {
  OnboardingAuthLayout,
  OnboardingError,
  OnboardingLogo,
  onboardingAsset,
} from "./onboarding-auth-layout.js";

export function PendingSignIn({
  account,
  busy,
  error,
  headingRef,
  onRetry,
  onCode,
  onBack,
  children,
}: {
  account: Account;
  busy: boolean;
  error: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onRetry: () => void;
  onCode: (code: string) => void;
  onBack: () => void;
  children?: React.ReactNode;
}) {
  const email = account.pending === "magic-link";
  const canUseCode = email && account.capabilities?.auth.emailCode === true;
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const enterCode = canUseCode && showCode;
  const validCode = /^[0-9]{6,10}$/.test(code);

  return (
    <OnboardingAuthLayout
      busy={busy}
      className="onboarding-entry__pending"
      onSubmit={(event) => {
        event.preventDefault();
        if (enterCode && validCode && !busy) onCode(code);
      }}
      afterCard={
        email && (
          <div className="onboarding-entry__recovery-actions">
            <Button
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={onBack}
            >
              Use a different email
            </Button>
          </div>
        )
      }
    >
      <header className="onboarding-entry__header">
        <OnboardingLogo />
      </header>
      {children}
      <div className="onboarding-entry__pending-content">
        {email ? (
          <div className="onboarding-entry__envelope" aria-hidden="true">
            <img
              src={onboardingAsset("inbox-envelope.png")}
              width={188}
              height={125}
              alt=""
            />
          </div>
        ) : (
          <div className="onboarding-entry__browser-icon" aria-hidden="true">
            <Icon icon={MarkGithubIcon} size="lg" />
          </div>
        )}
        <div className="onboarding-entry__pending-actions">
          <div className="onboarding-entry__heading">
            <h1 id="onboarding-entry-title" ref={headingRef} tabIndex={-1}>
              {email ? "Check your inbox" : "Continue in your browser"}
            </h1>
            <p role="status">
              {email
                ? canUseCode
                  ? `We sent a sign-in link and code to ${account.email}.`
                  : `We sent a sign-in link to ${account.email}.`
                : "Continue with GitHub in your browser. Orka will open when you finish."}
            </p>
          </div>
          {enterCode && (
            <>
              <TextField
                ref={codeInput}
                className="onboarding-entry__field"
                label="Email code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={busy}
                onChange={(event) =>
                  setCode(
                    event.target.value.replace(/[^0-9]/g, "").slice(0, 10),
                  )
                }
              />
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !validCode}
              >
                {busy ? "Verifying…" : "Verify code"}
              </Button>
            </>
          )}
          <OnboardingError>{error}</OnboardingError>
          {canUseCode && !enterCode && (
            <Button
              className="onboarding-entry__flat-button"
              disabled={busy}
              onClick={() => {
                setShowCode(true);
                requestAnimationFrame(() => codeInput.current?.focus());
              }}
            >
              Use email code
            </Button>
          )}
          <Button
            size="lg"
            className="onboarding-entry__flat-button"
            disabled={busy}
            onClick={() => {
              setCode("");
              onRetry();
            }}
          >
            {email ? (busy ? "Sending…" : "Resend email") : "Try again"}
          </Button>
          {!email && (
            <Button
              size="lg"
              variant="tertiary"
              disabled={busy}
              onClick={onBack}
            >
              Cancel sign-in
            </Button>
          )}
        </div>
      </div>
    </OnboardingAuthLayout>
  );
}
