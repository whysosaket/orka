import { open } from "@tauri-apps/plugin-dialog";
import { UploadIcon } from "@primer/octicons-react";
import { Button } from "../button.js";
import { Textarea } from "../textarea.js";
import type { EnvController } from "./use-environments.js";
import { activeSources, repositoryLabel } from "../project-sources.js";
export function ImportEnvDialog({ c }: { c: EnvController }) {
  const { text, setText, modal, busy, run, close, imported } = c;
  if (!(modal === "import")) return null;
  return (
    <>
      <p>
        Choose a file or paste assignments. Values are processed locally; review
        keys and recipients before publishing.
      </p>
      {c.draft?.revision && (
        <p className="env-pending">
          Import the complete key list you want to share. Keys missing from this
          import will be removed from the next published version. You’ll review
          those changes before publishing.
        </p>
      )}
      {!c.draft?.revision &&
        Boolean(activeSources(c.project.sources).length) && (
          <label>
            Repository
            <select
              value={c.sourceId}
              disabled={Boolean(busy)}
              onChange={(event) => c.setSourceId(event.target.value)}
            >
              {activeSources(c.project.sources).map((source) => (
                <option key={source.id} value={source.id}>
                  {repositoryLabel(c.project.sources ?? [], source.id)}
                </option>
              ))}
            </select>
          </label>
        )}
      <Button
        size="sm"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Reading ENV file locally…", async () => {
            const path = await open({
              multiple: false,
              title: "Choose an ENV file",
            });
            if (typeof path === "string") await imported({ path });
          })
        }
      >
        <UploadIcon size={15} />
        Choose ENV file
      </Button>
      <label>
        ENV assignments
        <Textarea
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"API_URL=https://example.test\nAPI_KEY=…"}
        />
      </label>
      <div className="dialog-actions">
        <Button size="sm" onClick={close} disabled={Boolean(busy)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={Boolean(busy) || !text.trim()}
          onClick={() => void run("Parsing locally…", () => imported({ text }))}
        >
          Review keys
        </Button>
      </div>
    </>
  );
}
