import React from "react";

export type ReaderIllustration =
  | "previous-version-unavailable"
  | "skill-md-missing"
  | "file-unavailable-offline"
  | "preview-unavailable"
  | "empty-markdown-body"
  | "no-changes"
  | "up-to-date";

export interface ReaderStateProps {
  illustration: ReaderIllustration;
  title: string;
  message?: string;
  action?: React.ReactNode;
  /** Reader states sit in the document column; overlay states fill the drawer. */
  size?: "reader" | "overlay";
  tone?: "status" | "alert";
  className?: string;
}

/** An illustrated empty or error state for the skill reader and review drawer. */
export function ReaderState({
  illustration,
  title,
  message,
  action,
  size = "reader",
  tone = "status",
  className = "",
}: ReaderStateProps) {
  const overlay = size === "overlay";
  return (
    <div
      className={`reader-state reader-state--${size} ${className}`.trim()}
      role={tone}
    >
      <img
        className="reader-state-illustration"
        src={`/skill-states/${illustration}.png`}
        alt=""
        width={overlay ? 256 : 188}
        height={overlay ? 171 : 125}
        draggable={false}
      />
      <p className="reader-state-title">{title}</p>
      {message && <p className="reader-state-message">{message}</p>}
      {action && <div className="reader-state-action">{action}</div>}
    </div>
  );
}
