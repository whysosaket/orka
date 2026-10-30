import { isMap, parseDocument } from "yaml";

export function readSkillMarkdown(content: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const fallback = { name: "", description: "", body: content };
  if (!match || match[1].length > 32_768) return fallback;
  try {
    const doc = parseDocument(match[1], { logLevel: "silent" });
    if (doc.errors.length || !isMap(doc.contents)) return fallback;
    // Read scalars without resolving YAML aliases or materializing collections.
    const name = doc.get("name");
    const description = doc.get("description");
    return {
      name: typeof name === "string" ? name.trim() : "",
      description: typeof description === "string" ? description.trim() : "",
      body: content.slice(match[0].length),
    };
  } catch {
    return fallback;
  }
}
