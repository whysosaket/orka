import React, { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { KebabHorizontalIcon } from "@primer/octicons-react";
import { IconButton } from "./icon-button.js";

export interface ActionPopoverProps {
  /** The control that opens the menu; it receives the Radix trigger props. */
  trigger: React.ReactElement;
  label: string;
  align?: "start" | "end";
  className?: string;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Anchored action menu shared by the ⋯ button and the fact chips. It closes
 * after any enabled action unless the control opts out with data-keep-open.
 */
export function ActionPopover({
  trigger,
  label,
  align = "end",
  className = "",
  onOpenChange,
  children,
}: ActionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [motion, setMotion] = useState("instant");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        onOpenChange?.(value);
      }}
    >
      <Popover.Trigger
        asChild
        onPointerDownCapture={() => setMotion("pointer")}
        onKeyDownCapture={() => setMotion("instant")}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`resource-actions-popover ${className}`.trim()}
          data-motion={motion}
          sideOffset={6}
          align={align}
          aria-label={label}
          onPointerDownCapture={() => setMotion("pointer")}
          onKeyDownCapture={() => setMotion("instant")}
          onPointerDownOutside={() => setMotion("pointer")}
          onEscapeKeyDown={() => setMotion("instant")}
          onClick={(event) => {
            if (
              !(event.target as HTMLElement).closest("[data-keep-open]") &&
              (event.target as HTMLElement).closest("button:not(:disabled)")
            )
              setOpen(false);
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ResourceActions({ children }: { children: React.ReactNode }) {
  return (
    <ActionPopover
      label="Resource actions"
      trigger={
        <IconButton
          icon={KebabHorizontalIcon}
          size="sm"
          variant="tertiary"
          aria-label="More resource actions"
        />
      }
    >
      {children}
    </ActionPopover>
  );
}
