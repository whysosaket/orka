import React, { forwardRef } from "react";
import { Field, useFieldIds, type FieldProps } from "./field.js";
export interface TextareaProps
  extends
    Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className">,
    Omit<FieldProps, "icon"> {}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      id,
      label,
      hint,
      error,
      size,
      className,
      rows = 4,
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
        className={className}
        disabled={props.disabled}
        readOnly={props.readOnly}
        multiline
      >
        <textarea
          {...props}
          ref={ref}
          id={inputId}
          rows={rows}
          className="ui-field__input ui-field__textarea"
          aria-describedby={description}
          aria-invalid={error ? true : invalid}
        />
      </Field>
    );
  },
);
