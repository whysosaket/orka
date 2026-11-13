import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { useProjectSkillUsage } from "../../../apps/mac/src/components/skill-usage.js";
import type { Resource } from "@portable/protocol";

export type UsageWindow = Window & {
  usageFixture: {
    calls: string[];
    deferred: boolean;
    failed: boolean;
    finish: (() => void)[];
    observedCounts: (number | null)[];
  };
};
const fixture = {
  calls: [] as string[],
  deferred: false,
  failed: false,
  finish: [] as (() => void)[],
  observedCounts: [] as (number | null)[],
};
Object.assign(window, {
  usageFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke: async (_command: string, args: { projectId: string }) => {
      fixture.calls.push(args.projectId);
      if (fixture.failed) throw new Error("History unavailable");
      const result = {
        counts: { skill: fixture.calls.length },
        partial: false,
      };
      if (fixture.deferred)
        return new Promise((resolve) =>
          fixture.finish.push(() => resolve(result)),
        );
      return result;
    },
  },
});
const h = React.createElement;
function Fixture() {
  const [project, setProject] = useState("one");
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState("account:service:profile");
  const [folders, setFolders] = useState("/synthetic/first");
  const [path, setPath] = useState("review");
  const [syncMinutes, setSyncMinutes] = useState(1);
  const resources = [
    { resourceId: "skill", logicalPath: path, sourceId: "source" },
  ] as Resource[];
  const usage = useProjectSkillUsage(
    project,
    scope,
    resources,
    enabled,
    folders,
    syncMinutes,
  );
  const count = usage.usage?.counts.skill;
  useEffect(() => {
    fixture.observedCounts.push(count ?? null);
  }, [count]);
  return h(
    "main",
    null,
    h("button", { onClick: () => setProject("one") }, "Project one"),
    h("button", { onClick: () => setProject("two") }, "Project two"),
    h("button", { onClick: () => setEnabled(true) }, "Skills"),
    h("button", { onClick: () => setEnabled(false) }, "Home"),
    h("button", { onClick: () => setSyncMinutes(1) }, "Sync 1 minute"),
    h("button", { onClick: () => setSyncMinutes(5) }, "Sync 5 minutes"),
    h(
      "button",
      { onClick: () => setScope("other-account:service:profile") },
      "Change account",
    ),
    h(
      "button",
      { onClick: () => setScope("account:other-service:profile") },
      "Change service",
    ),
    h(
      "button",
      { onClick: () => setScope("account:service:other-profile") },
      "Change profile",
    ),
    h(
      "button",
      { onClick: () => setFolders("/synthetic/second") },
      "Change folders",
    ),
    h("button", { onClick: () => setPath("other-skill") }, "Change skills"),
    h("button", { onClick: usage.retry }, "Refresh"),
    h(
      "output",
      { "aria-label": "Count" },
      String(usage.usage?.counts.skill ?? ""),
    ),
    h("output", { "aria-label": "Loading" }, String(usage.loading)),
    h("output", { "aria-label": "Error" }, usage.error),
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(h(Fixture));
