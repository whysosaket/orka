import type { Draft } from "./api.js";
import { Button } from "../button.js";
import type { EnvController } from "./use-environments.js";
export function EnvConflictDialog({ c }: { c: EnvController }) {
  const {
    draft,
    checked,
    revealed,
    remote,
    setRemote,
    comparison,
    choices,
    setChoices,
    modal,
    setModal,
    setNotice,
    busy,
    run,
    close,
    replaceDraft,
    env,
    setOrigin,
    reveal,
  } = c;
  if (!(modal === "conflict" && draft && remote)) return null;
  return (
    <>
      <p>
        Choose which version to keep for each changed key. Values stay masked.
        Your choices become a draft for another explicit publication.
      </p>
      <div className="env-comparison">
        {comparison.map((k) => (
          <div className="env-conflict-key" key={k.key}>
            <label>
              <code>{k.key}</code>
              <select
                aria-label={`Version for ${k.key}`}
                value={choices[k.key] ?? ""}
                onChange={(e) =>
                  setChoices({ ...choices, [k.key]: e.target.value })
                }
              >
                <option value="" disabled>
                  Choose a version
                </option>
                {k.local && <option value="local">My draft</option>}
                {k.remote && <option value="remote">Latest shared</option>}
                <option value="omit">Omit from set</option>
              </select>
            </label>
            <div className="env-conflict-values">
              {(["local", "remote"] as const)
                .filter((side) => k[side])
                .map((side) => {
                  const id = `${side}:${k.key}`;
                  return (
                    <div key={side}>
                      <Button
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          reveal(
                            side === "local" ? draft.draftId : remote.draftId,
                            k.key,
                            id,
                          )
                        }
                      >
                        {revealed?.key === id ? "Hide" : "Reveal"}{" "}
                        {side === "local" ? "my draft" : "latest shared"}{" "}
                        {k.key}
                      </Button>
                      <code>
                        {revealed?.key === id ? revealed.value : "••••••••"}
                      </code>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <Button size="sm" disabled={Boolean(busy)} onClick={close}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={Boolean(busy) || comparison.some((k) => !choices[k.key])}
          onClick={() =>
            void run("Preparing reviewed draft…", async () => {
              const d = await env<Draft>("rebase", {
                draftId: draft.draftId,
                remoteDraft: remote.draftId,
                keys: checked,
                choices,
              });
              setOrigin("imported");
              await replaceDraft(d);
              await env("discard", { draftId: remote.draftId });
              setRemote(null);
              setModal(null);
              setNotice("Reviewed draft ready. Publish when you’re satisfied.");
            })
          }
        >
          Use reviewed choices
        </Button>
      </div>
    </>
  );
}
