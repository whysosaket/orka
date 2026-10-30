import * as Select from "@radix-ui/react-select";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileDirectoryIcon,
  GearIcon,
  PeopleIcon,
  SyncIcon,
  DeviceDesktopIcon,
  PersonIcon,
} from "@primer/octicons-react";
import { projectLabel } from "../project-navigation.js";
import type { Project } from "../../types.js";

export const settingsSections = {
  general: { label: "General", icon: GearIcon },
  folder: { label: "Source folders", icon: FileDirectoryIcon },
  sharing: { label: "Sharing", icon: PeopleIcon },
  sync: { label: "Sync & startup", icon: SyncIcon },
  devices: { label: "Connected Macs", icon: DeviceDesktopIcon },
  account: { label: "Account & service", icon: PersonIcon },
} as const;
export type SettingsSection = keyof typeof settingsSections;
const groups = {
  "Project settings": ["general", "folder", "sharing"],
  "This Mac": ["sync"],
  Account: ["devices", "account"],
} as const;

export function SettingsNavigation({
  projects,
  projectId,
  section,
  disabled,
  onProject,
  onSection,
}: {
  projects: Project[];
  projectId: string;
  section: SettingsSection;
  disabled: boolean;
  onProject: (id: string) => void;
  onSection: (section: SettingsSection) => void;
}) {
  const selected = projects.find((p) => p.id === projectId);
  return (
    <aside className="settings-navigation">
      <Select.Root
        value={selected?.id ?? ""}
        disabled={disabled || !projects.length}
        onValueChange={onProject}
      >
        <Select.Trigger
          className="settings-project-selector"
          aria-label="Settings project"
          title={selected ? projectLabel(selected) : undefined}
        >
          <FileDirectoryIcon size={16} aria-hidden="true" />
          <span>
            <Select.Value placeholder="Select project">
              {selected ? projectLabel(selected) : undefined}
            </Select.Value>
          </span>
          <Select.Icon asChild>
            <ChevronDownIcon size={14} aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="project-menu settings-project-menu"
            position="popper"
            align="start"
            sideOffset={6}
            collisionPadding={12}
          >
            <Select.ScrollUpButton className="project-menu-scroll">
              <ChevronUpIcon size={14} />
            </Select.ScrollUpButton>
            <Select.Viewport className="p-1">
              {projects.map((project) => (
                <Select.Item
                  className="project-menu-item"
                  key={project.id}
                  value={project.id}
                  textValue={projectLabel(project)}
                >
                  <FileDirectoryIcon size={16} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <Select.ItemText>{projectLabel(project)}</Select.ItemText>
                  </span>
                  <Select.ItemIndicator>
                    <CheckIcon size={14} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="project-menu-scroll">
              <ChevronDownIcon size={14} />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      <nav aria-label="Settings sections">
        {Object.entries(groups).map(([group, sections]) => (
          <div
            className="settings-nav-group"
            role="group"
            aria-label={group}
            key={group}
          >
            {sections.map((id) => {
              const { label, icon: Icon } = settingsSections[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id ? "page" : undefined}
                  disabled={
                    disabled || (group === "Project settings" && !selected)
                  }
                  onClick={() => onSection(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
