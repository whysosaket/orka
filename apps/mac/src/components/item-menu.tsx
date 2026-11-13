import React, { useRef } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRightIcon, KebabHorizontalIcon } from "@primer/octicons-react";
import { IconButton } from "./icon-button.js";
import "./item-menu.css";

export interface ItemMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  separator?: boolean;
  children?: ItemMenuAction[];
  restoreFocus?: boolean;
}

export function hasNativeTextMenu(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'input, textarea, [contenteditable]:not([contenteditable="false"]), a[href], [data-native-context-menu]',
    )
  )
    return true;
  const selection = window.getSelection();
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    (target.contains(selection.anchorNode) ||
      selection.containsNode(target, true)),
  );
}

function MenuItems({
  actions,
  contextual,
  onSelect,
}: {
  actions: ItemMenuAction[];
  contextual: boolean;
  onSelect: (action: ItemMenuAction) => void;
}) {
  const Menu = contextual ? ContextMenu : DropdownMenu;
  return actions.map((action) => (
    <React.Fragment key={action.id}>
      {action.separator && <Menu.Separator className="item-menu-separator" />}
      {action.children?.length ? (
        <Menu.Sub>
          <Menu.SubTrigger
            className="item-menu-action"
            disabled={action.disabled}
            title={action.reason}
          >
            {action.label}
            <ChevronRightIcon size={14} aria-hidden="true" />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent
              className="item-menu-content"
              collisionPadding={10}
              sideOffset={4}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MenuItems
                actions={action.children}
                contextual={contextual}
                onSelect={onSelect}
              />
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      ) : (
        <Menu.Item
          className="item-menu-action"
          data-danger={action.danger || undefined}
          disabled={action.disabled}
          title={action.reason}
          onSelect={() => {
            onSelect(action);
            action.onSelect();
          }}
        >
          {action.label}
        </Menu.Item>
      )}
    </React.Fragment>
  ));
}

export function ItemContextMenu({
  actions,
  label,
  children,
  footer,
  disabled = false,
}: {
  actions: ItemMenuAction[];
  label: string;
  children: React.ReactElement;
  footer?: React.ReactNode;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const selected = useRef(false);
  if (!actions.length) return children;
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) selected.current = false;
      }}
    >
      <ContextMenu.Trigger
        asChild
        ref={trigger}
        disabled={disabled}
        onContextMenuCapture={(event) => {
          if (hasNativeTextMenu(event.target)) event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (
            !disabled &&
            !hasNativeTextMenu(event.target) &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + 8,
                clientY: bounds.bottom,
              }),
            );
          }
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="item-menu-content"
          aria-label={label}
          collisionPadding={10}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!selected.current) {
              const element = trigger.current;
              const target = element?.matches("button, [tabindex]")
                ? element
                : element?.querySelector<HTMLElement>(
                    "button[data-resource-id], button, [tabindex]",
                  );
              target?.focus();
            }
          }}
        >
          <MenuItems
            actions={actions}
            contextual
            onSelect={(action) => {
              selected.current = action.restoreFocus === false;
            }}
          />
          {footer}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ItemMenuButton({
  actions,
  label,
  disabled,
  footer,
  size = "sm",
}: {
  actions: ItemMenuAction[];
  label: string;
  disabled?: boolean;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const selected = useRef(false);
  return (
    <DropdownMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) selected.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <IconButton
          icon={KebabHorizontalIcon}
          variant="tertiary"
          size={size}
          aria-label={label}
          disabled={disabled || !actions.length}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="item-menu-content"
          aria-label={label}
          align="end"
          sideOffset={5}
          collisionPadding={10}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (selected.current) event.preventDefault();
          }}
        >
          <MenuItems
            actions={actions}
            contextual={false}
            onSelect={(action) => {
              selected.current = action.restoreFocus === false;
            }}
          />
          {footer}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
