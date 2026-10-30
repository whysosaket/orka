import { EyeClosedIcon, EyeIcon } from "@primer/octicons-react";
import { Button } from "../button.js";
import { IconButton } from "../icon-button.js";
import type { EnvController } from "./use-environments.js";
export function EnvKeyList({ c }: { c: EnvController }) {
  const { draft, checked, busy, revealed } = c;
  if (!draft) return null;
  return (
    <section aria-label="Environment keys">
      <div className="env-key-heading">
        <h3>
          {checked.length} of {draft.keys.length} keys selected
        </h3>
        <Button
          size="sm"
          variant="tertiary"
          disabled={Boolean(busy)}
          onClick={() => {
            c.setChecked(
              checked.length === draft.keys.length ? [] : draft.keys,
            );
            c.setPreview(null);
            c.clearRevealed();
          }}
        >
          {checked.length === draft.keys.length ? "Deselect all" : "Select all"}
        </Button>
      </div>
      <div className="env-keys">
        {draft.keys.map((key) => (
          <div className="env-key" key={key}>
            <label>
              <input
                type="checkbox"
                checked={checked.includes(key)}
                disabled={Boolean(busy)}
                onChange={() => {
                  c.setChecked(c.toggle(checked, key));
                  c.setPreview(null);
                  c.clearRevealed();
                }}
              />
              <span>{key}</span>
            </label>
            <span className="env-value">
              {revealed?.key === key ? revealed.value : "••••••••"}
            </span>
            <IconButton
              icon={revealed?.key === key ? EyeClosedIcon : EyeIcon}
              size="sm"
              variant="tertiary"
              aria-label={`${revealed?.key === key ? "Hide" : "Reveal"} ${key}`}
              disabled={Boolean(busy)}
              onClick={() => c.reveal(draft.draftId, key)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
