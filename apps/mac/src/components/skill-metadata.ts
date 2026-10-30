import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readSkillMarkdown } from "./skill-markdown.js";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";

export function useSkillMetadata(resource: Resource | undefined) {
  const id = resource?.resourceId;
  const key =
    resource?.kind === "skill"
      ? `${resource.resourceId}:${resource.revision}`
      : "";
  const [result, setResult] = useState<{
    key: string;
    name: string;
    description: string;
  } | null>(null);
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
