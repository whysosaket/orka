import React from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  PersonIcon,
  type Icon as OcticonIcon,
} from "@primer/octicons-react";
import type { ProjectResource as Resource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { SourceLabel } from "./source-label.js";
import { ActionPopover } from "./resource-actions.js";
import { useMemberLabel } from "./member-names.js";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A static fact. The icon is tertiary, the text secondary, and there is no hover. */
function FactChip({
  icon,
  label,
  title,
  children,
}: {
  icon?: OcticonIcon;
  /** Screen-reader prefix when the visible text alone is ambiguous. */
  label?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="fact-chip" title={title}>
      {icon && <Icon icon={icon} size="xs" variant="tertiary" />}
      {label && <span className="sr-only">{label} </span>}
      {children}
    </span>
  );
}

/** A fact that opens a menu: primary text, a chevron, and a selected fill while open. */
function FactMenu({
  icon,
  menuLabel,
  menu,
  children,
}: {
  icon: OcticonIcon;
  menuLabel: string;
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ActionPopover
      align="start"
      label={menuLabel}
      className="fact-menu"
      trigger={
        <button type="button" className="fact-chip fact-chip--menu">
          <Icon icon={icon} size="xs" variant="tertiary" />
          {children}
          <Icon icon={ChevronDownIcon} size="xs" variant="tertiary" />
        </button>
      }
    >
      {menu}
    </ActionPopover>
  );
}

export interface ResourceFactsProps {
  resource: Resource;
  user: string | null;
  /** The inspected file for memories and plans; omit for sessions. */
  file?: { selected: string; onSelect: (path: string) => void };
}

/** Source, author, date, and the file switcher for multi-file resources. */
export function ResourceFacts({ resource, user, file }: ResourceFactsProps) {
  const memberName = useMemberLabel(user);
  const author = memberName(resource.updatedBy);
  const updated = new Date(resource.updatedAt);
  const files = plural(resource.files.length, "file");
  return (
    <>
      <div className="detail-facts" role="group" aria-label="Resource facts">
        {resource.repositoryName && (
          <FactChip label="Repository">{resource.repositoryName}</FactChip>
        )}
        <FactChip label="Source">
          <SourceLabel source={resource.source} />
        </FactChip>
        <FactChip
          icon={ClockIcon}
          label="Updated"
          title={`Updated ${updated.toLocaleString()}`}
        >
          <time dateTime={resource.updatedAt}>
            {updated.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </FactChip>
        <FactChip icon={PersonIcon} label="Updated by">
          <span className="fact-chip-author">{author}</span>
        </FactChip>
        {file && resource.files.length > 1 && (
          <FactMenu
            icon={FileIcon}
            menuLabel="Files"
            menu={resource.files.map((entry) => (
              <Button
                key={entry.path}
                size="sm"
                variant="tertiary"
                className="fact-menu-file"
                aria-current={entry.path === file.selected ? "true" : undefined}
                title={entry.path}
                onClick={() => file.onSelect(entry.path)}
              >
                <span className="fact-menu-file-name">{entry.path}</span>
                {entry.path === file.selected && (
                  <Icon icon={CheckIcon} label="Selected" />
                )}
              </Button>
            ))}
          >
            {files}
          </FactMenu>
        )}
      </div>
    </>
  );
}
