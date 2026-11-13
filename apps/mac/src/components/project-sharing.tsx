import { useId } from "react";
import {
  BookIcon,
  CommentDiscussionIcon,
  KeyIcon,
  TasklistIcon,
  ZapIcon,
  type Icon as OcticonIcon,
} from "@primer/octicons-react";
import type { ProjectSharing } from "../types.js";
import { Icon } from "./icon.js";
import { Switch } from "./switch.js";
import { PermissionSelect } from "./permission-select.js";
import { ENV_ENABLED } from "../lib/features.js";

export const privateSharing: ProjectSharing = {
  memory: false,
  skill: false,
  session: false,
  plan: false,
  env: false,
};

export const defaultSharing: ProjectSharing = {
  memory: true,
  skill: true,
  session: false,
  plan: true,
  env: false,
};

export function SharingModeSelect({
  label,
  enabled,
  disabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <PermissionSelect
      label={`${label} sharing`}
      value={enabled ? "automatic" : "selected"}
      disabled={disabled}
      options={[
        { value: "automatic", label: "Share automatically" },
        { value: "selected", label: "Only when asked" },
      ]}
      onChange={(value) => onChange(value === "automatic")}
    />
  );
}

export const legacySharing: ProjectSharing = {
  memory: true,
  skill: true,
  session: true,
  plan: true,
  env: true,
};

const choices: {
  key: keyof ProjectSharing;
  label: string;
  description?: string;
  icon: OcticonIcon;
}[] = [
  { key: "memory", label: "Memories", icon: BookIcon },
  { key: "session", label: "Sessions", icon: CommentDiscussionIcon },
  { key: "plan", label: "Plans", icon: TasklistIcon },
  { key: "skill", label: "Skills", icon: ZapIcon },
  {
    key: "env",
    label: "ENVs",
    description: "Encrypted. Published manually after review.",
    icon: KeyIcon,
  },
];

export const sharingChoices = choices.filter(
  ({ key }) => ENV_ENABLED || key !== "env",
);

export function ProjectSharingChoices({
  value,
  disabled,
  onChange,
  context = "setup",
}: {
  value: ProjectSharing;
  disabled: boolean;
  onChange: (value: ProjectSharing) => void;
  context?: "setup" | "settings";
}) {
  const id = useId();
  return (
    <fieldset
      className="project-sharing"
      disabled={disabled}
      aria-label={context === "settings" ? "Share from this Mac" : undefined}
      aria-describedby={context === "setup" ? `${id}-help` : undefined}
    >
      {context === "setup" && <legend>Share from this Mac</legend>}
      {context === "setup" && (
        <p id={`${id}-help`} className="project-sharing-help">
          Choose automatic sharing below. Share individual items with the Orka
          plugin.
        </p>
      )}
      <div className="project-sharing-choices">
        {sharingChoices.map(
          ({ key, label, description: settingsDescription, icon }) => {
            const description =
              context === "settings" ? settingsDescription : undefined;
            const change = (enabled: boolean) =>
              onChange({
                ...value,
                env: ENV_ENABLED && value.env,
                [key]: enabled,
              });
            return (
              <div
                className={`project-sharing-choice${context === "settings" ? " project-sharing-choice--switch" : ""}`}
                data-sharing-kind={key}
                key={key}
              >
                {context === "settings" && (
                  <Icon icon={icon} className="project-sharing-icon" />
                )}
                <span className="project-sharing-copy">
                  <strong>{label}</strong>
                  {description && (
                    <span
                      id={`${id}-${key}`}
                      className="project-sharing-description"
                    >
                      {description}
                    </span>
                  )}
                </span>
                {key === "env" ? (
                  <Switch
                    checked={value.env}
                    aria-label={label}
                    disabled={disabled}
                    onChange={(event) => change(event.target.checked)}
                  />
                ) : (
                  <SharingModeSelect
                    label={label}
                    enabled={value[key]}
                    disabled={disabled}
                    onChange={change}
                  />
                )}
              </div>
            );
          },
        )}
      </div>
      {context === "setup" &&
        ((ENV_ENABLED && value.env) ||
          !sharingChoices.some(({ key }) => value[key])) && (
          <p
            className="project-sharing-help project-sharing-summary"
            role="status"
          >
            {ENV_ENABLED && value.env
              ? "Review keys and recipients before publishing ENVs manually. ENV files never upload automatically."
              : "Automatic sharing is off. Only items you explicitly share through the plugin will be sent."}
          </p>
        )}
    </fieldset>
  );
}
