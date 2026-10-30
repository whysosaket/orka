export const displayText = (value: string) =>
  value.replace(/\s*\u2014\s*/g, " · ");

/** Presentation only. Never use these labels for persistence or native commands. */
export function sessionFallbackTitle(title: string): string {
  const clean = title
    .trim()
    .replace(/^\[(https?:\/\/[^\]]+)\]\(.*$/, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (
    !clean ||
    /^#?\s*AGENTS\.md instructions/i.test(clean) ||
    clean.startsWith("<") ||
    /^Imported session$/i.test(clean)
  ) {
    return "Untitled session";
  }
  return displayText(clean);
}

export function resourceDisplayTitle(
  title: string,
  projectPath?: string | null,
): string {
  let display = title.trim().replace(/^Task Group:\s*/i, "");
  if (projectPath && display.startsWith(`${projectPath} `)) {
    display = display.slice(projectPath.length).trim();
  } else if (/^Task Group:\s*/i.test(title)) {
    // Task Group titles may refer to another checkout; remove only the leading path.
    display = display.replace(/^(?:\/Users\/|\/home\/|[A-Za-z]:\\)\S+\s+/, "");
  }
  // Imported dated summary filenames carry timestamps and an opaque four-character ID.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[\w]{4}-.+\.md$/.test(display)) {
    display = display
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[\w]{4}-/, "")
      .replace(/\.md$/, "")
      .replace(/_/g, " ");
  }
  return displayText(display || title);
}
