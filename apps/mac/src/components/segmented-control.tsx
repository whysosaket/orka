import React from "react";
import { Button } from "./button.js";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Text, or text with a mark; the accessible name is the rendered content. */
  label: React.ReactNode;
}

/** Two or more exclusive views in one pill; the selected option is pressed. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
}: {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`segmented-control ${className}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant="tertiary"
          className="segmented-control-option"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
