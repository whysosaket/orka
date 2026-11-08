import React, { useState } from "react";
import { MarkGithubIcon, ServerIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { TextField } from "./text-field.js";
import type { Account } from "./use-account.js";
import {
  OnboardingAuthLayout,
  OnboardingError,
  OnboardingLegal,
  OnboardingLogo,
  onboardingAsset as asset,
} from "./onboarding-auth-layout.js";

export function SignInEntry({
  account,
  busy,
  ready,
  error,
  variant = "sign-up",
  headingRef,
  password = false,
  onEmail,
  onGitHub,
  onSwitch,
  onPassword,
  onSelfHosted,
  children,
}: {
  account: Account;
  busy: boolean;
  ready: boolean;
  error: string;
  variant?: "sign-up" | "sign-in";
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  password?: boolean;
  onEmail: () => void;
  onGitHub: () => void;
  onSwitch: () => void;
  onPassword: () => void;
  onSelfHosted: () => void;
  children?: React.ReactNode;
}) {
  const [submitting, setSubmitting] = useState<"email" | "github" | null>(null);
  const [linkError, setLinkError] = useState("");
  const methods = account.capabilities?.auth;
  const showEmail = !methods || methods.magicLink || methods.password;
  const showGitHub = !methods || methods.github;
  const signIn = variant === "sign-in";
  return (
    <OnboardingAuthLayout
      busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          busy ||
          !ready ||
          !(password ? methods?.password : methods?.magicLink)
        )
          return;
        setSubmitting("email");
        onEmail();
      }}
    >
      <header className="onboarding-entry__header">
        <OnboardingLogo />
        <div className="onboarding-entry__heading">
          <h1 id="onboarding-entry-title" ref={headingRef} tabIndex={-1}>
            {signIn ? "Welcome back to Orka" : "Get started with Orka"}
          </h1>
          <p>
            {signIn ? "New to Orka? " : "Already have an account ? "}
            <button
              type="button"
              className="onboarding-entry__sign-in"
              disabled={!ready}
              onClick={onSwitch}
            >
              {signIn ? "Get started" : "Sign In"}
            </button>
          </p>
        </div>
      </header>

      {children}

      <div className="onboarding-entry__content">
        {showEmail && (
          <div className="onboarding-entry__email">
            <TextField
              className="onboarding-entry__field"
              label="Email"
              type="email"
              required
              value={account.email}
              placeholder="name@company.com"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => account.setEmail(event.target.value)}
            />
            {password && (
              <TextField
                className="onboarding-entry__field"
                label="Password"
                type="password"
                required
                value={account.password}
                autoComplete="current-password"
                disabled={busy}
                onChange={(event) => account.setPassword(event.target.value)}
              />
            )}
            <Button
              size="lg"
              className="onboarding-entry__submit"
              variant="primary"
              type="submit"
              disabled={
                busy ||
                !ready ||
                !account.email.trim() ||
                (password && !account.password)
              }
            >
              {busy && submitting === "email"
                ? password
                  ? "Signing in…"
                  : "Sending…"
                : signIn || password
                  ? "Sign in"
                  : "Start for free"}
            </Button>
          </div>
        )}

        {showEmail && showGitHub && (
          <div className="onboarding-entry__divider" aria-hidden="true">
            <img src={asset("divider.svg")} width={162} height={1} alt="" />
            <span>OR</span>
            <img src={asset("divider.svg")} width={162} height={1} alt="" />
          </div>
        )}

        <div className="onboarding-entry__providers">
          {signIn && methods?.password && methods.magicLink && (
            <Button
              size="lg"
              variant="tertiary"
              disabled={busy}
              onClick={onPassword}
            >
              {password ? "Use an email link" : "Use a password"}
            </Button>
          )}
          {showGitHub && (
            <Button
              size="lg"
              variant="secondary"
              disabled={busy || !ready}
              onClick={() => {
                setSubmitting("github");
                onGitHub();
              }}
            >
              <Icon icon={MarkGithubIcon} />
              {busy && submitting === "github"
                ? "Opening GitHub…"
                : "Continue with GitHub"}
            </Button>
          )}
          <Button
            size="lg"
            variant="tertiary"
            disabled={busy}
            onClick={onSelfHosted}
          >
            <Icon icon={ServerIcon} />
            {account.mode === "self-hosted"
              ? "Change server"
              : "Connect to your server"}
          </Button>
        </div>

        {methods && !showEmail && !showGitHub && (
          <p className="onboarding-entry__message" role="status">
            This server has no sign-in methods enabled. Contact its
            administrator or change server.
          </p>
        )}
        <OnboardingError>{error || linkError}</OnboardingError>
        {account.connectionError && (
          <Button disabled={busy} onClick={account.retryConnection}>
            Try again
          </Button>
        )}
        {!methods && !account.connectionError && (
          <span className="sr-only" role="status">
            Checking service…
          </span>
        )}
      </div>

      <OnboardingLegal onError={setLinkError} />
    </OnboardingAuthLayout>
  );
}
