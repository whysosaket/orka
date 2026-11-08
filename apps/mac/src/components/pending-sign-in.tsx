import React from "react";
import { MarkGithubIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
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
  onBack,
  children,
}: {
  account: Account;
  busy: boolean;
  error: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onRetry: () => void;
  onBack: () => void;
  children?: React.ReactNode;
}) {
  const email = account.pending === "magic-link";

  return (
    <OnboardingAuthLayout
      busy={busy}
      className="onboarding-entry__pending"
      onSubmit={(event) => event.preventDefault()}
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
                ? `We sent a sign-in link to ${account.email}.`
                : "Continue with GitHub in your browser. Orka will open when you finish."}
            </p>
          </div>
          <OnboardingError>{error}</OnboardingError>
          <Button
            size="lg"
            className="onboarding-entry__flat-button"
            disabled={busy}
            onClick={onRetry}
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
