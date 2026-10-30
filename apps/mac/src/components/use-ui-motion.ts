import { useMemo } from "react";
import { useReducedMotion, type Transition } from "motion/react";

/** Read the existing CSS timing tokens rather than introducing another motion scale. */
export function useUiMotion(durationToken = "--motion-control-duration") {
  const reduced = useReducedMotion();
  const transition = useMemo<Transition>(() => {
    const styles = getComputedStyle(document.documentElement);
    const duration = styles.getPropertyValue(durationToken).trim();
    const points = styles
      .getPropertyValue("--motion-control-ease")
      .match(/[\d.]+/g)
      ?.map(Number);
    return {
      duration:
        (Number.parseFloat(duration) || 0) /
        (duration.endsWith("ms") ? 1000 : 1),
      ease:
        points?.length === 4
          ? (points as [number, number, number, number])
          : "easeOut",
    };
  }, [durationToken]);
  return {
    reduced: Boolean(reduced),
    transition: reduced ? { duration: 0 } : transition,
  };
}
