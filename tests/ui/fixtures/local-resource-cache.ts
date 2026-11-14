import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { useLocalResources } from "../../../apps/mac/src/components/use-local-resources.js";
import type { ProjectPage } from "../../../apps/mac/src/types.js";

export interface CatalogCall {
  projectId: string;
  kind: string;
  accountId: string;
  serviceOrigin: string;
  refresh?: boolean;
}
export type CatalogWindow = Window & {
  catalogFixture: {
    calls: CatalogCall[];
    deferred: boolean;
    finish: (() => void)[];
    busy: boolean;
  };
};
const fixture = {
  calls: [] as CatalogCall[],
  deferred: sessionStorage.getItem("defer-discovery") === "true",
  busy: sessionStorage.getItem("busy-discovery") === "true",
  finish: [] as (() => void)[],
};
Object.assign(window, {
  catalogFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke: async (_command: string, args: CatalogCall) => {
      const key = JSON.stringify([
        args.projectId,
        args.kind,
        args.accountId,
        args.serviceOrigin,
      ]);
      const cached = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? {
        resources: [],
        errors: [],
      };
      if (args.refresh === false) return cached;
      fixture.calls.push(args);
      if (fixture.busy) return { ...cached, refreshPending: true };
      const result = {
        resources: [
          {
            resourceId: `${args.projectId}-${args.kind}`,
            projectId: args.projectId,
            kind: args.kind,
            title: `${args.projectId} ${args.kind} ${args.accountId} ${fixture.calls.length}`,
          },
        ],
        errors: [],
      };
      const complete = () => {
        sessionStorage.setItem(key, JSON.stringify(result));
        return result;
      };
      if (fixture.deferred)
        return new Promise((resolve) =>
          fixture.finish.push(() => resolve(complete())),
        );
      return complete();
    },
  },
});
const h = React.createElement;
function Fixture() {
  const [project, setProject] = useState("one");
  const [page, setPage] = useState<ProjectPage>("home");
  const [user, setUser] = useState("user");
  const [origin, setOrigin] = useState("https://first.example");
  const [scope, setScope] = useState("profile-one");
  const [folder, setFolder] = useState("/synthetic/first");
  const [source, setSource] = useState("/synthetic/repository-first");
  const [syncMinutes, setSyncMinutes] = useState(1);
  const catalog = useLocalResources({
    scope,
    project: {
      id: project,
      name: project,
      path: folder,
      role: "owner",
      sources: [
        {
          id: "repository",
          name: "Repository",
          path: source,
          folderState: "connected",
        },
      ],
    },
    page,
    user,
    serviceOrigin: origin,
    syncMinutes,
  });
  return h(
    "main",
    null,
    h("button", { onClick: () => setProject("one") }, "Project one"),
    h("button", { onClick: () => setProject("two") }, "Project two"),
    ...(["home", "memory", "session", "plan"] as const).map((page) =>
      h("button", { key: page, onClick: () => setPage(page) }, page),
    ),
    h("button", { onClick: () => setUser("other") }, "Change account"),
    h(
      "button",
      { onClick: () => setOrigin("https://second.example") },
      "Change service",
    ),
    h("button", { onClick: () => setScope("profile-two") }, "Change profile"),
    h(
      "button",
      { onClick: () => setFolder("/synthetic/second") },
      "Change folder",
    ),
    h(
      "button",
      { onClick: () => setSource("/synthetic/repository-second") },
      "Change sources",
    ),
    h("button", { onClick: catalog.refresh }, "Refresh"),
    h("button", { onClick: () => setSyncMinutes(1) }, "Sync every minute"),
    h(
      "button",
      { onClick: () => setSyncMinutes(5) },
      "Sync every five minutes",
    ),
    h(
      "output",
      { "aria-label": "Rows" },
      catalog.resources.map((r) => r.title).join(", "),
    ),
    h("output", { "aria-label": "Loading" }, String(catalog.loading)),
    h("output", { "aria-label": "Errors" }, catalog.errors.join(", ")),
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(h(Fixture));
