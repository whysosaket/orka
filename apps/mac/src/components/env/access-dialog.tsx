import type { Draft } from "./api.js";
import { Button } from "../button.js";
import { Recipients } from "./recipients.js";
import type { EnvController } from "./use-environments.js";
export function EnvAccessDialog({ c }: { c: EnvController }) {
  const {
    project,
    user,
    listing,
    draft,
    grants,
    removedDevices,
    setRemovedDevices,
    modal,
    busy,
    label,
    load,
    run,
    close,
    replaceDraft,
    setOrigin,
    published,
    toggle,
    env,
  } = c;
  if (!(modal === "access" && draft?.manifest)) return null;
  return (
    <>
      <Recipients c={c} editable={draft.manifest.creator === user} />
      <fieldset className="env-recipients">
        <legend>Approved Macs · select to revoke</legend>
        {draft.manifest.devices.map((d) => (
          <label key={d.id}>
            <input
              type="checkbox"
              checked={removedDevices.includes(d.id)}
              disabled={
                Boolean(busy) ||
                d.id === listing?.device.id ||
                (user !== draft.manifest!.creator && user !== d.owner)
              }
              onChange={() => setRemovedDevices(toggle(removedDevices, d.id))}
            />
            <span>
              {d.name}
              <small>
                {label(d.owner)}
                {d.id === listing?.device.id ? " · this Mac" : ""}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <p>
        Removing access stops future retrieval and updates. Previously saved
        values remain on recipients’ machines.
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
            void run("Updating access and re-encrypting…", async () => {
              try {
                await published(
                  await env("access", {
                    projectId: project.id,
                    setId: draft.setId,
                    revision: draft.revision,
                    grants,
                    removeDevices: removedDevices,
                  }),
                  "ENV access updated",
                );
                await replaceDraft(
                  await env<Draft>("pull", {
                    projectId: project.id,
                    setId: draft.setId,
                  }),
                );
                setOrigin("pulled");
              } finally {
                await load();
              }
            })
          }
        >
          Save access
        </Button>
      </div>
    </>
  );
}
