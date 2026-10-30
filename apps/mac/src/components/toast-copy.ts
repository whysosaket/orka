import type { ToastInput } from "./toasts.js";

/** Convert legacy success notices to the approved title-only feedback. */
export function noticeToast(message: string): ToastInput {
  const known: [RegExp, string, ToastInput["kind"]?][] = [
    [/continuation.*(?:copy|separate)/i, "Changes will save as a copy", "info"],
    [/Opened native session/i, "Session opened"],
    [
      /new-session composer|exported transcript/i,
      /Claude/.test(message)
        ? "Handoff ready in Claude"
        : "Handoff ready in Codex",
      "info",
    ],
    [/^Invite copied/i, "Invite copied"],
    [/^Folder disconnected/i, "Folder disconnected"],
    [/^Member removed/i, "Member removed"],
    [/^Suggestion submitted/i, "Suggestion sent for review"],
    [
      /^The resource or permissions changed/i,
      "Suggestion needs a fresh review",
      "warning",
    ],
    [/^Reviewed version installed/i, "Reviewed update installed"],
    [/^Old ENV set disabled/i, "Old ENV set disabled", "info"],
    [/^Encrypted ENV set published/i, "ENV set published"],
    [/^Selected keys applied/i, "ENV keys applied"],
    [/^Reviewed draft ready/i, "Reviewed draft ready", "info"],
    [/^Review and publish this new/i, "Replacement draft ready", "info"],
    [/^Publishing access requested/i, "Publishing access requested", "queued"],
    [
      /queued$|^Sync requested|^Upload retry requested/i,
      message.replace(/[.]$/, ""),
      "queued",
    ],
  ];
  const match = known.find(([pattern]) => pattern.test(message));
  return {
    title: match?.[1] ?? message.replace(/[.]$/, ""),
    kind: match?.[2] ?? "success",
  };
}
