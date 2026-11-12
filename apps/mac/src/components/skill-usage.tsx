import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import { Button } from "./button.js";

export interface SkillUsage {
  counts: Record<string, number>;
  partial: boolean;
}

export function SkillUsageCount({ count }: { count: number | undefined }) {
  return count === undefined ? null : (
    <span
      className="skill-usage-count"
      title="Recorded skill loads on this Mac, counted once per chat. Unrecorded usage is not included."
    >
      Detected in {count} {count === 1 ? "chat" : "chats"}
    </span>
  );
}

export function useProjectSkillUsage(
  projectId: string,
  scope: string,
  resources: Resource[],
  enabled: boolean,
) {
  const key = enabled
    ? JSON.stringify([
        scope,
        projectId,
        resources.map((skill) => [skill.resourceId, skill.logicalPath]),
      ])
    : "";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({
    key: "",
    usage: null as SkillUsage | null,
    loading: false,
    error: "",
  });
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  useEffect(() => {
    if (!key) return;
    let active = true;
    setState((current) => ({
      key,
      usage: current.key === key ? current.usage : null,
      loading: true,
      error: "",
    }));
    void invoke<SkillUsage>("project_skill_usage", { projectId })
      .then((usage) => {
        if (active) setState({ key, usage, loading: false, error: "" });
      })
      .catch((error) => {
        if (active)
          setState((current) => ({
            ...current,
            loading: false,
            error: String(error),
          }));
      });
    return () => {
      active = false;
    };
  }, [key, projectId, attempt]);
  return {
    usage: state.key === key ? state.usage : null,
    loading: Boolean(key) && (state.key !== key || state.loading),
    error: state.key === key ? state.error : "",
    retry,
  };
}

export function ProjectSkillUsageStatus({
  loading,
  error,
  retry,
}: ReturnType<typeof useProjectSkillUsage>) {
  if (!loading && !error) return null;
  return (
    <div className="session-preview-status" role="status">
      <span>
        {loading
          ? "Checking project skill usage…"
          : `Skill usage unavailable. ${error}`}
      </span>
      {error && !loading && (
        <Button size="sm" variant="tertiary" onClick={retry}>
          Retry usage
        </Button>
      )}
    </div>
  );
}
