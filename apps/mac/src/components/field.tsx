import React, { useId } from "react";
import { AlertIcon, type Icon as OcticonIcon } from "@primer/octicons-react";
import { Icon, type ControlSize } from "./icon.js";

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  size?: ControlSize;
  icon?: OcticonIcon;
  className?: string;
}

export function useFieldIds(
  id?: string,
  describedBy?: string,
  hint?: string,
  error?: string,
) {
  const generated = useId();
  const inputId = id ?? generated;
  return {
    inputId,
    description:
      [
        describedBy,
        error ? `${inputId}-error` : hint ? `${inputId}-hint` : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

const sizes = { lg: "ui-field--lg", md: "ui-field--md", sm: "ui-field--sm" };
export function Field({
  id,
  label,
  hint,
  error,
  size = "md",
  icon,
  className = "",
  disabled,
  readOnly,
  multiline,
  trailing,
  children,
}: FieldProps & {
  id: string;
  disabled?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`ui-field ${sizes[size]} ${className}`}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      data-invalid={!!error || undefined}
    >
      {label && (
        <label className="ui-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <div
        className={`ui-field__control${multiline ? " ui-field__control--multiline" : ""}${trailing ? " ui-field__control--trailing" : ""}`}
      >
        {icon && <Icon icon={icon} size={size} />}
        {children}
        {trailing && <span className="ui-field__trailing">{trailing}</span>}
      </div>
      {(hint !== undefined || error !== undefined) && (
        <div className="ui-field__support">
          <p id={`${id}-error`} className="ui-field__error" role="alert">
            {error && (
              <>
                <Icon icon={AlertIcon} size="sm" />
                <span>{error}</span>
              </>
            )}
          </p>
          {!error && hint && (
            <p id={`${id}-hint`} className="ui-field__hint">
              {hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
