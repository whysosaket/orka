import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { SearchIcon, XIcon } from "@primer/octicons-react";
import { TextField, type TextFieldProps } from "./text-field.js";
import { IconButton } from "./icon-button.js";
export interface SearchFieldProps extends Omit<
  TextFieldProps,
  "value" | "defaultValue" | "onChange" | "type" | "icon" | "trailing"
> {
  value: string;
  onValueChange: (value: string) => void;
}
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      size = "md",
      onKeyDown,
      disabled,
      readOnly,
      ...props
    },
    ref,
  ) {
    const input = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => input.current!);
    const clear = () => {
      onValueChange("");
      input.current?.focus();
    };
    return (
      <TextField
        {...props}
        ref={input}
        type="search"
        icon={SearchIcon}
        size={size}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            event.key === "Escape" &&
            value &&
            !disabled &&
            !readOnly
          ) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
        trailing={
          value && !disabled && !readOnly ? (
            <IconButton
              type="button"
              variant="tertiary"
              size={size}
              icon={XIcon}
              aria-label="Clear search"
              onClick={clear}
            />
          ) : undefined
        }
      />
    );
  },
);
