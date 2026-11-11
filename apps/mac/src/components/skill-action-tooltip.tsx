import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Labels are also on each button; this portal keeps the visual hint out of the rail's clipping area. */
export function SkillActionTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const show = () => {
    const box = anchor.current?.getBoundingClientRect();
    if (box)
      setPosition({
        left: Math.max(80, Math.min(innerWidth - 80, box.x + box.width / 2)),
        top: box.y - 8,
      });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  return (
    <span
      ref={anchor}
      className="skill-action-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={() => setPosition(null)}
      onFocus={show}
      onBlur={() => setPosition(null)}
      onClick={() => setPosition(null)}
    >
      {children}
      {position &&
        createPortal(
          <span
            className="skill-action-tooltip"
            role="tooltip"
            aria-hidden="true"
            style={position}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
