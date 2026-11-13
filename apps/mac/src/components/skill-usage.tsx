import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import { Button } from "./button.js";

export interface SkillUsage {
  counts: Record<string, number>;
  partial: boolean;
}

interface UsageEntry {
  key: string;
  usage: SkillUsage | null;
  error: string;
  updatedAt: number;
  pending?: Promise<void>;
}
const freshness = 30_000;

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
  folders = "",
) {
  const cache = useMemo(
    () => ({ scope, projects: new Map<string, UsageEntry>() }),
    [scope],
  );
  const key = JSON.stringify([
    folders,
    resources.map((skill) => [
      skill.resourceId,
      skill.logicalPath,
      skill.sourceId,
    ]),
  ]);
  const entry = useMemo(() => {
    if (!enabled) return undefined;
    const cached = cache.projects.get(projectId);
    if (cached?.key === key) return cached;
    const next: UsageEntry = {
      key,
      usage: null,
      error: "",
      updatedAt: 0,
    };
    cache.projects.set(projectId, next);
    return next;
  }, [cache, projectId, key, enabled]);
  const [, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    if (entry) entry.updatedAt = 0;
    setAttempt((current) => current + 1);
  }, [entry]);
  useEffect(() => {
    if (!entry) return;
    let active = true;
    if (
      !entry.pending &&
      (!entry.updatedAt || Date.now() - entry.updatedAt >= freshness)
    ) {
      entry.error = "";
      entry.pending = invoke<SkillUsage>("project_skill_usage", { projectId })
        .then((usage) => {
          entry.usage = usage;
        })
        .catch((error) => {
          entry.error = String(error);
        })
        .finally(() => {
          entry.updatedAt = Date.now();
          entry.pending = undefined;
        });
    }
    if (entry.pending) {
      setVersion((version) => version + 1);
      void entry.pending.then(() => {
        if (active) setVersion((version) => version + 1);
      });
    }
    return () => {
      active = false;
    };
  }, [entry, projectId, attempt]);
  return {
    usage: entry?.usage ?? null,
    loading: Boolean(entry && (!entry.updatedAt || entry.pending)),
    error: entry?.error ?? "",
    retry,
  };
}

export function ProjectSkillUsageStatus({
  loading,
  error,
  retry,
}: ReturnType<typeof useProjectSkillUsage>) {
  if (!loading && !error) return null;
  if (loading)
    return (
      <span className="sr-only" role="status">
        Loading skill usage…
      </span>
    );
  return (
    <div className="session-preview-status" role="status">
      <span>{`Skill usage unavailable. ${error}`}</span>
      {error && !loading && (
        <Button size="sm" variant="tertiary" onClick={retry}>
          Retry usage
        </Button>
      )}
    </div>
  );
}
