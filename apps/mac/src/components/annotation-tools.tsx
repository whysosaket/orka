import { useSyncExternalStore } from "react";
import { Agentation } from "agentation";

function observeOverlays(changed: () => void) {
  const observer = new MutationObserver(() => {
    // Radix may hide the portal before Agentation moves it into the dialog.
    // Restore only the tool that is now inside the active focus boundary.
    activeOverlay()
      ?.querySelector('[data-agentation-portal][aria-hidden="true"]')
      ?.removeAttribute("aria-hidden");
    changed();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  return () => observer.disconnect();
}

const activeOverlay = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '.modal[data-state="open"], .drawer[data-state="open"]',
    ),
  ).at(-1) ?? null;

export default function AnnotationTools() {
  // Keep annotation input inside Radix's active focus boundary.
  const portalContainer = useSyncExternalStore(observeOverlays, activeOverlay);
  return (
    <Agentation
      appName="Orka"
      enableKeyboardShortcuts={false}
      portalContainer={portalContainer}
    />
  );
}
