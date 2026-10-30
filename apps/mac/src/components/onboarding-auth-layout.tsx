import React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./sign-in-entry.css";

export const onboardingAsset = (name: string) =>
  `${import.meta.env.BASE_URL}onboarding/${name}`;

export function OnboardingAuthLayout({
  busy,
  onSubmit,
  children,
  afterCard,
  className = "",
  layoutClassName = "",
  noValidate,
}: {
  busy: boolean;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  children: React.ReactNode;
  afterCard?: React.ReactNode;
  className?: string;
  layoutClassName?: string;
  noValidate?: boolean;
}) {
  return (
    <main
      className={`sign-in onboarding-entry ${layoutClassName}`.trim()}
      data-tauri-drag-region
    >
      <div className="onboarding-entry__backdrop" aria-hidden="true">
        <img src={onboardingAsset("background.svg")} alt="" />
      </div>
      <form
        className={`auth onboarding-entry__card ${className}`.trim()}
        aria-labelledby="onboarding-entry-title"
        aria-busy={busy}
        onSubmit={onSubmit}
        noValidate={noValidate}
      >
        {children}
      </form>
      {afterCard}
    </main>
  );
}

export function OnboardingLogo() {
  return (
    <img
      className="onboarding-entry__logo"
      src={onboardingAsset("orka-lockup.svg")}
      width={102.731}
      height={24}
      alt="Orka"
    />
  );
}

export function OnboardingError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="onboarding-entry__error" role="alert">
      <img
        src={onboardingAsset("error-info.svg")}
        width={16}
        height={16}
        alt=""
      />
      <span>
        {typeof children === "string"
          ? children.replace(/^Error:\s*/, "")
          : children}
      </span>
    </div>
  );
}

export function OnboardingLegal({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const openLegalLink = (
    event: React.MouseEvent<HTMLAnchorElement>,
    document: "terms" | "privacy",
  ) => {
    if (!isTauri()) return;
    event.preventDefault();
    onError("");
    void invoke("open_legal_link", { document }).catch(() =>
      onError("Cannot open your browser. Open https://x.com manually."),
    );
  };
  return (
    <footer className="onboarding-entry__legal">
      <a
        href="https://x.com"
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => openLegalLink(event, "terms")}
      >
        Terms Of Use
      </a>
      <span className="onboarding-entry__legal-separator" aria-hidden="true">
        <img
          src={onboardingAsset("footer-divider.svg")}
          width={16}
          height={1}
          alt=""
        />
      </span>
      <a
        href="https://x.com"
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => openLegalLink(event, "privacy")}
      >
        Privacy Policy
      </a>
    </footer>
  );
}
