import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { useLocalResources } from "../../../apps/mac/src/components/use-local-resources.js";
import type { ProjectPage } from "../../../apps/mac/src/types.js";

export interface CatalogCall {
  projectId: string;
  kind: string;
  accountId: string;
  serviceOrigin: string;
}
export type CatalogWindow = Window & {
  catalogFixture: {
    calls: CatalogCall[];
    deferred: boolean;
    finish: (() => void)[];
  };
};
const fixture = {
  calls: [] as CatalogCall[],
  deferred: false,
  finish: [] as (() => void)[],
};
Object.assign(window, {
  catalogFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke: async (_command: string, args: CatalogCall) => {
      fixture.calls.push(args);
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
  const [page, setPage] = useState<ProjectPage>("home");
  const [user, setUser] = useState("user");
  const [origin, setOrigin] = useState("https://first.example");
  const [scope, setScope] = useState("profile-one");
  const [folder, setFolder] = useState("/synthetic/first");
  const [source, setSource] = useState("/synthetic/repository-first");
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
    h(
      "output",
      { "aria-label": "Rows" },
      catalog.resources.map((r) => r.title).join(", "),
    ),
    h("output", { "aria-label": "Loading" }, String(catalog.loading)),
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(h(Fixture));
