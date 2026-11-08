import type { RefObject } from "react";
import { Button } from "./button.js";
import {
  OnboardingAuthLayout,
  OnboardingLogo,
  OnboardingError,
} from "./onboarding-auth-layout.js";

export function AuthRecovery({
  kind,
  busy,
  server,
  headingRef,
  onRetry,
  onBack,
  error,
}: {
  kind: "keychain" | "locked-keychain" | "server" | "location";
  busy: boolean;
  server?: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onRetry: () => void;
  onBack: () => void;
  error?: string;
}) {
  const locked = kind === "locked-keychain";
  const serverError = kind === "server";
  const location = kind === "location";
  return (
    <OnboardingAuthLayout
      busy={busy}
      layoutClassName="onboarding-entry--recovery"
      className={`onboarding-auth-recovery${locked ? " onboarding-auth-recovery--locked" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onRetry();
      }}
    >
      <div
        className="onboarding-auth-recovery__content"
        data-figma-frame={
          location
            ? "716:3798"
            : serverError
              ? "715:3182"
              : locked
                ? "714:3388"
                : "714:3473"
        }
      >
        <OnboardingLogo />
        <div className="onboarding-entry__heading">
          <h1 ref={headingRef} id="onboarding-entry-title" tabIndex={-1}>
            {location
              ? "Move Orka to Applications"
              : serverError
                ? "Can’t reach your server"
                : locked
                  ? "Unlock your keychain"
                  : "Can’t access Keychain"}
          </h1>
          <p>
            {location
              ? "Drag Orka into Applications in Finder, then open that copy."
              : serverError
                ? "Check the server address and connection. Connect to your team’s VPN if required."
                : locked
                  ? "To save your sign-in, unlock your login keychain in the macOS prompt."
                  : "Allow Orka’s Keychain request to save your sign-in, then try again."}
          </p>
        </div>
        {serverError && server && (
          <p className="onboarding-auth-recovery__server">{server}</p>
        )}
        <OnboardingError>{error}</OnboardingError>
        <div className="onboarding-auth-recovery__actions">
          <Button size="lg" type="submit" variant="primary" disabled={busy}>
            {location ? "Check location" : "Try again"}
          </Button>
          {!location && (
            <Button
              size="lg"
              variant="tertiary"
              disabled={busy}
              onClick={onBack}
            >
              {serverError ? "Edit server address" : "Back to sign-in"}
            </Button>
          )}
        </div>
      </div>
    </OnboardingAuthLayout>
  );
}
