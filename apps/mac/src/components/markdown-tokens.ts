export type TokenKind = "text" | "punct" | "heading" | "string" | "key";

export interface Token {
  kind: TokenKind;
  text: string;
}

const inlinePattern = /(`+)([^`]*?)\1|\[([^\]\n]+)\]\(([^)\n]+)\)/g;

/** Code spans and links; other inline Markdown stays plain. */
function inline(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ kind: "text", text: text.slice(last, index) });
    if (match[1] !== undefined) {
      tokens.push({ kind: "punct", text: match[1] });
      tokens.push({ kind: "string", text: match[2] });
      tokens.push({ kind: "punct", text: match[1] });
    } else {
      tokens.push({ kind: "punct", text: "[" });
      tokens.push({ kind: "text", text: match[3] });
      tokens.push({ kind: "punct", text: "](" });
      tokens.push({ kind: "string", text: match[4] });
      tokens.push({ kind: "punct", text: ")" });
    }
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

/**
 * A small, line-oriented Markdown tinter: frontmatter keys and values,
 * heading markers and text, list markers, fences, code spans, and links.
 */
export function tokenizeMarkdown(source: string): Token[][] {
  const lines =
    source === "" ? [""] : source.replace(/\r?\n$/, "").split(/\r\n|\n/);
  let frontmatter = false;
  let fence: string | null = null;
  return lines.map((line, index) => {
    if (index === 0 && /^\uFEFF?---\s*$/.test(line)) {
      frontmatter = true;
      return [{ kind: "punct", text: line }];
    }
    if (frontmatter) {
      if (/^---\s*$/.test(line)) {
        frontmatter = false;
        return [{ kind: "punct", text: line }];
      }
      const entry = /^(\s*[\w.-]+)(\s*:)(.*)$/.exec(line);
      if (entry)
        return [
          { kind: "key", text: entry[1] },
          { kind: "punct", text: entry[2] },
          ...(entry[3] ? [{ kind: "string" as const, text: entry[3] }] : []),
        ];
      return [{ kind: "string", text: line }];
    }
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      return [{ kind: "punct", text: line }];
    }
    if (fence !== null) return [{ kind: "text", text: line }];
    const heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
    if (heading)
      return [
        { kind: "punct", text: heading[1] },
        { kind: "text", text: heading[2] },
        { kind: "heading", text: heading[3] },
      ];
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line))
      return [{ kind: "punct", text: line }];
    const quote = /^(\s*>+)(.*)$/.exec(line);
    if (quote) return [{ kind: "punct", text: quote[1] }, ...inline(quote[2])];
    const list = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
    if (list)
      return [
        ...(list[1] ? [{ kind: "text" as const, text: list[1] }] : []),
        { kind: "punct", text: list[2] },
        { kind: "text", text: list[3] },
        ...inline(list[4]),
      ];
    return line ? inline(line) : [{ kind: "text", text: "" }];
  });
}
