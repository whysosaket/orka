import React, { useRef } from "react";
import { CheckIcon, ChevronDownIcon } from "@primer/octicons-react";
import { Button, type ButtonVariant } from "./button.js";
import { Icon, type ControlSize } from "./icon.js";
import { ActionPopover } from "./resource-actions.js";

/** Radio-style sort menu shared by collection tools and the skill picker. */
export function SortMenu<T extends string>({
  value,
  options,
  onChange,
  label = "Sort by",
  size = "sm",
  variant = "tertiary",
  className = "index-toolbar-sort",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (sort: T) => void;
  label?: string;
  size?: ControlSize;
  variant?: ButtonVariant;
  className?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  return (
    <ActionPopover
      label={label}
      className="index-sort-menu"
      trigger={
        <Button
          size={size}
          variant={variant}
          className={className}
          aria-haspopup="menu"
        >
          <span className="sr-only">{label} </span>
          {options.find((option) => option.value === value)?.label}
          <Icon icon={ChevronDownIcon} size="xs" variant="tertiary" />
        </Button>
      }
    >
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          const items = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]',
            ) ?? [],
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "ArrowDown"
              ? items[(index + 1) % items.length]
              : event.key === "ArrowUp"
                ? items[(index - 1 + items.length) % items.length]
                : event.key === "Home"
                  ? items[0]
                  : event.key === "End"
                    ? items[items.length - 1]
                    : undefined;
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }}
      >
        {options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant="tertiary"
            role="menuitemradio"
            aria-checked={option.value === value}
            className="index-sort-option"
            onClick={() => onChange(option.value)}
          >
            <span className="index-sort-option-label">{option.label}</span>
            {option.value === value && <Icon icon={CheckIcon} />}
          </Button>
        ))}
      </div>
    </ActionPopover>
  );
}
