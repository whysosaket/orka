import React, { useState } from "react";
import { Button } from "./button.js";
import { TextField } from "./text-field.js";
import type { Account } from "./use-account.js";
import {
  OnboardingAuthLayout,
  OnboardingError,
  OnboardingLegal,
  OnboardingLogo,
} from "./onboarding-auth-layout.js";

export function SelfHostedConnection({
  account,
  busy,
  error,
  headingRef,
  onConnect,
  onBack,
  onSignIn,
  children,
}: {
  account: Account;
  busy: boolean;
  error: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onConnect: () => void;
  onBack: () => void;
  onSignIn: () => void;
  children?: React.ReactNode;
}) {
  const [linkError, setLinkError] = useState("");
  return (
    <OnboardingAuthLayout
      busy={busy}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && account.url.trim()) onConnect();
      }}
    >
      <header className="onboarding-entry__header">
        <OnboardingLogo />
        <div className="onboarding-entry__heading">
          <h1 id="onboarding-entry-title" ref={headingRef} tabIndex={-1}>
            Log into your account
          </h1>
          <p>
            Already have an account ?{" "}
            <button
              className="onboarding-entry__sign-in"
              type="button"
              disabled={busy}
              onClick={onSignIn}
            >
              Sign In
            </button>
          </p>
        </div>
      </header>
      {children}
      <div className="onboarding-entry__content">
        <OnboardingError>{error || linkError}</OnboardingError>
        <div className="onboarding-entry__email">
          <TextField
            className="onboarding-entry__field"
            label="Server link"
            type="url"
            required
            placeholder="https://orka.your-team.com"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            value={account.url}
            onChange={(event) => account.setUrl(event.target.value)}
          />
          <div className="onboarding-entry__providers">
            <Button
              className="onboarding-entry__flat-button"
              type="submit"
              disabled={busy || !account.url.trim()}
            >
              {busy ? "Connecting…" : "Connect server"}
            </Button>
            <Button variant="tertiary" disabled={busy} onClick={onBack}>
              Back
            </Button>
          </div>
        </div>
      </div>
      <OnboardingLegal onError={setLinkError} />
    </OnboardingAuthLayout>
  );
}
