import type { KeyboardEvent } from "react";

/** Radix's light-DOM focus loop cannot see Pierre's shadow-root controls. */
export function handleReviewTab(event: KeyboardEvent<HTMLDivElement>) {
  if (
    event.key !== "Tab" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.defaultPrevented
  )
    return;

  const candidates: HTMLElement[] = [];
  const visit = (element: Element) => {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden") === "true"
    )
      return;
    if (
      element instanceof HTMLElement &&
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0 &&
      !["hidden", "collapse"].includes(getComputedStyle(element).visibility)
    )
      candidates.push(element);

    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedElements({ flatten: true });
      for (const child of assigned.length
        ? assigned
        : Array.from(element.children))
        visit(child);
    } else {
      for (const child of Array.from(
        element.shadowRoot?.children ?? element.children,
      ))
        visit(child);
    }
  };
  for (const child of Array.from(event.currentTarget.children)) visit(child);

  // Stop Radix's shallow bubble handler after resolving the actual focused node.
  event.preventDefault();
  event.stopPropagation();
  if (candidates.length === 0) {
    event.currentTarget.focus();
    return;
  }
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  const current = candidates.indexOf(active as HTMLElement);
  const next =
    current < 0
      ? event.shiftKey
        ? candidates.length - 1
        : 0
      : (current + (event.shiftKey ? -1 : 1) + candidates.length) %
        candidates.length;
  candidates[next].focus();
}
