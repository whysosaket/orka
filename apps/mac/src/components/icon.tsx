import React from "react";
import { type Icon as OcticonIcon } from "@primer/octicons-react";

export type ControlSize = "lg" | "md" | "sm";
/** Control sizes plus the 12px inline glyph used by facts and path lines. */
export type IconSize = ControlSize | "xs";
export type IconVariant = "primary" | "secondary" | "tertiary" | "inherit";

const sizes: Record<IconSize, string> = {
  lg: "ui-icon--lg",
  md: "ui-icon--md",
  sm: "ui-icon--sm",
  xs: "ui-icon--xs",
};
const variants = {
  primary: "ui-icon--primary",
  secondary: "ui-icon--secondary",
  tertiary: "ui-icon--tertiary",
  inherit: "ui-icon--inherit",
};

export interface IconProps {
  icon: OcticonIcon;
  size?: IconSize;
  variant?: IconVariant;
  /** Omit for decorative icons; labeled controls supply their own name. */
  label?: string;
  className?: string;
}

/** A Primer Octicon centered in a container matching the label line height. */
export function Icon({
  icon: Glyph,
  size = "md",
  variant = "inherit",
  label,
  className = "",
}: IconProps) {
  return (
    <span
      className={`ui-icon ${sizes[size]} ${variants[variant]} ${className}`.trim()}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Glyph size={16} aria-hidden="true" focusable="false" />
    </span>
  );
}
