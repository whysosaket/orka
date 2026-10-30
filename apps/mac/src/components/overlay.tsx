import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import { useUiMotion } from "./use-ui-motion.js";
import { ToastViewport, useToastEscape } from "./toasts.js";

export function Overlay({
  open,
  onClose,
  title,
  drawer = false,
  className = "",
  children,
  onEscapeKeyDown,
  onCloseAutoFocus,
  dismissOnBackdrop = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  drawer?: boolean;
  className?: string;
  children: React.ReactNode;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
  dismissOnBackdrop?: boolean;
}) {
  const { transition, reduced } = useUiMotion();
  const dismissToastOnEscape = useToastEscape();
  const [returnFocusTo] = React.useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          asChild
          onPointerDown={
            dismissOnBackdrop
              ? (event) => {
                  if (
                    event.button === 0 &&
                    !event.defaultPrevented &&
                    event.target === event.currentTarget
                  )
                    onClose();
                }
              : undefined
          }
        >
          <motion.div
            className="overlay-backdrop"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          />
        </Dialog.Overlay>
        <Dialog.Content
          asChild
          className={`${drawer ? "drawer" : "modal toast-host-modal"} ${className}`}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (!dismissToastOnEscape(event)) onEscapeKeyDown?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            returnFocusTo?.focus();
          }}
        >
          <motion.div
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            {children}
            <ToastViewport modal />
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
