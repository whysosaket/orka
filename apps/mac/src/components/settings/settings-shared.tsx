import type { ReactNode } from "react";
import type { Snapshot } from "../../types.js";

export interface SettingsEditor {
  dirty: boolean;
  save: () => Promise<true | string>;
  pendingSave?: boolean;
  draftText?: () => string;
  discard: () => void;
}
export const settingsContext = (state: Snapshot) => ({
  user: state.user,
  service: state.config?.apiUrl,
});
export const settingsScope = (state: Snapshot, projectId = "") =>
  JSON.stringify([state.profile, state.user, state.config?.apiUrl, projectId]);

export function SettingsHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="settings-heading">
      <div>
        <h2 tabIndex={-1}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
