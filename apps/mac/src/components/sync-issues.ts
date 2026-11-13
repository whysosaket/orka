export function syncIssueRecovery(error: string): string | undefined {
  if (/package contains symlink/i.test(error))
    return "The skill stays on this Mac. Replace the link with a regular file you intend to share, then scan again.";
  if (/session exceeds 128 mb/i.test(error))
    return "This session stays on this Mac. Start a new session for future work that you want to sync.";
}
