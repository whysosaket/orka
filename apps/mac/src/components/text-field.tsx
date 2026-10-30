import React, { forwardRef } from "react";
import { Field, useFieldIds, type FieldProps } from "./field.js";

export interface TextFieldProps
  extends
    Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "className">,
    FieldProps {
  trailing?: React.ReactNode;
}
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    {
      id,
      label,
      hint,
      error,
      size,
      icon,
      className,
      trailing,
      "aria-describedby": describedBy,
      "aria-invalid": invalid,
      ...props
    },
    ref,
  ) {
    const { inputId, description } = useFieldIds(id, describedBy, hint, error);
    return (
      <Field
        id={inputId}
        label={label}
        hint={hint}
        error={error}
        size={size}
        icon={icon}
        className={className}
        trailing={trailing}
        disabled={props.disabled}
        readOnly={props.readOnly}
      >
        <input
          {...props}
          ref={ref}
          id={inputId}
          className="ui-field__input"
          aria-describedby={description}
          aria-invalid={error ? true : invalid}
        />
      </Field>
    );
  },
);
