import { Button } from "../button.js";
import type { EnvController } from "./use-environments.js";
export function DeleteEnvDialog({ c }: { c: EnvController }) {
  const {
    project,
    setSelected,
    draft,
    setDraft,
    modal,
    setModal,
    setNotice,
    busy,
    load,
    run,
    close,
    env,
  } = c;
  if (!(modal === "delete" && draft)) return null;
  return (
    <>
      <p>
        Delete “{draft.manifest?.name}” for all recipients? Local files already
        applied will remain.
      </p>
      <div className="dialog-actions">
        <Button size="sm" disabled={Boolean(busy)} onClick={close}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={Boolean(busy)}
          onClick={() =>
            void run("Deleting ENV set…", async () => {
              try {
                await env("delete", {
                  projectId: project.id,
                  setId: draft.setId,
                  revision: draft.revision,
                });
                await env("discard", { draftId: draft.draftId });
                setDraft(null);
                setSelected("");
                setModal(null);
                setNotice("ENV set deleted.");
              } finally {
                await load();
              }
            })
          }
        >
          Delete ENV set
        </Button>
      </div>
    </>
  );
}
