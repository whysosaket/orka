import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readSkillMarkdown, type SkillMarkdown } from "./skill-markdown.js";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";

export function useSkillMetadata(
  resource: Resource | undefined,
  scope: string,
) {
  const id = resource?.resourceId;
  const key =
    resource?.kind === "skill"
      ? JSON.stringify([
          scope,
          resource.projectId,
          resource.resourceId,
          resource.revision,
          resource.files.find((file) => file.path === "SKILL.md")?.hash,
        ])
      : "";
  const [result, setResult] = useState<
    (SkillMarkdown & { key: string }) | null
  >(null);
  useEffect(() => {
    if (!key || !id) return;
    let active = true;
    void invoke<Inspection>("inspect_resource", {
      id,
      file: "SKILL.md",
      conflictId: null,
    })
      .then((value) => {
        if (active && value.content !== null)
          setResult({ key, ...readSkillMarkdown(value.content) });
      })
      .catch(() => {
        if (active) setResult(null);
      });
    return () => {
      active = false;
    };
  }, [key, id]);
  return result?.key === key ? result : null;
}
