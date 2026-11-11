import { isMap, parseDocument } from "yaml";

export interface SkillMarkdown {
  name: string;
  description: string;
  body: string;
  /** A frontmatter block is present but could not be read as metadata. */
  invalid: boolean;
}

export function readSkillMarkdown(content: string): SkillMarkdown {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const fallback = { name: "", description: "", body: content, invalid: false };
  if (!match) return fallback;
  if (match[1].length > 32_768) return { ...fallback, invalid: true };
  try {
    const doc = parseDocument(match[1], { logLevel: "silent" });
    if (doc.errors.length || !isMap(doc.contents))
      return { ...fallback, invalid: true };
    // Read scalars without resolving YAML aliases or materializing collections.
    const name = doc.get("name");
    const description = doc.get("description");
    return {
      name: typeof name === "string" ? name.trim() : "",
      description: typeof description === "string" ? description.trim() : "",
      body: content.slice(match[0].length),
      invalid: false,
    };
  } catch {
    return { ...fallback, invalid: true };
  }
}
