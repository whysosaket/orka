import { useEffect, useRef } from "react";
import type { Preview } from "./api.js";
import { Button } from "../button.js";
import { TextField } from "../text-field.js";
import type { EnvController } from "./use-environments.js";
export function ApplyEnvDialog({ c }: { c: EnvController }) {
  const {
    project,
    draft,
    checked,
    path,
    setPath,
    preview,
    setPreview,
    modal,
    setModal,
    setNotice,
    busy,
    run,
    close,
    env,
  } = c;
  const scope = JSON.stringify([modal, draft?.draftId, path, checked]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [scope],
  );
  if (!(modal === "apply" && draft)) return null;
  const reviewed = preview?.path === path ? preview : null;
  const requestPreview = async (exclude = false) => {
    const generation = ++request.current;
    const requestedScope = scope;
    const isCurrent = () =>
      generation === request.current &&
      requestedScope === currentScope.current &&
      c.active.current;
    setPreview(null);
    if (exclude) {
      await env("exclude", {
        projectId: project.id,
        sourceId: c.draft?.sourceId,
        path,
      });
      if (!isCurrent()) return;
    }
    const next = await env<Preview>("preview", {
      draftId: draft.draftId,
      path,
      keys: checked,
    });
    if (isCurrent() && next.path === path) setPreview(next);
  };
  return (
    <>
      <p>
        Merge selected keys while preserving unrelated local variables and
        comments.
      </p>
      <label>
        File inside this project
        <TextField
          autoFocus
          value={path}
          disabled={Boolean(busy)}
          onChange={(e) => {
            request.current += 1;
            setPath(e.target.value);
            setPreview(null);
          }}
          placeholder=".env.local"
        />
      </label>
      <Button
        size="sm"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Checking local changes…", () => requestPreview())
        }
      >
        Preview changes
      </Button>
      {reviewed && (
        <>
          <ul className="env-change-list">
            {reviewed.keys.map((k) => (
              <li key={k.key}>
                <code>{k.key}</code>
                <span>{k.change}</span>
              </li>
            ))}
          </ul>
          {!reviewed.ignored && (
            <p className="env-pending">
              This file needs a local Git exclusion.
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("Adding local Git exclusion…", () =>
                    requestPreview(true),
                  )
                }
              >
                Exclude this file locally
              </Button>
            </p>
          )}
          <div className="dialog-actions">
            <Button size="sm" disabled={Boolean(busy)} onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(busy) || !reviewed.ignored}
              onClick={() =>
                void run("Applying reviewed keys…", async () => {
                  if (currentScope.current !== scope || reviewed.path !== path)
                    return;
                  const appliedPath = reviewed.path;
                  await env("apply", { draftId: draft.draftId });
                  setModal(null);
                  setPreview(null);
                  setNotice(`Selected keys applied to ${appliedPath}.`);
                })
              }
            >
              Apply {reviewed.keys.length} keys
            </Button>
          </div>
        </>
      )}
    </>
  );
}
