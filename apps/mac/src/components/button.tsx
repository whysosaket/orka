import React, { forwardRef } from "react";
import type { ControlSize } from "./icon.js";

export type ButtonVariant =
  "primary" | "primary-brand" | "secondary" | "tertiary";

const variants = {
  primary: "ui-button--primary",
  "primary-brand": "ui-button--primary-brand",
  secondary: "ui-button--secondary",
  tertiary: "ui-button--tertiary",
};
const sizes = { lg: "ui-button--lg", md: "ui-button--md", sm: "ui-button--sm" };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      type = "button",
      className = "",
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={`ui-button ${variants[variant]} ${sizes[size]} ${className}`.trim()}
      />
    );
  },
);
