import React, { useEffect, useRef, useState } from "react";
import { CheckIcon, LinkIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

export function CopyLinkButton({
  value,
  label = "Copy link",
  errorTitle = "Couldn’t copy link",
  disabled,
  onError,
  iconOnly = false,
}: {
  value: string;
  label?: string;
  errorTitle?: string;
  disabled?: boolean;
  onError: (message: string) => void;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [motion, setMotion] = useState("instant");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    setCopied(false);
    setPending(false);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [value]);
  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const current = generation.current;
    setMotion(event.detail === 0 ? "instant" : "pointer");
    setPending(true);
    clearTimeout(timer.current);
    onError("");
    try {
      await navigator.clipboard.writeText(value);
      if (current !== generation.current) return;
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      if (current !== generation.current) return;
      setCopied(false);
      onError(`${errorTitle}: ${String(error)}`);
    } finally {
      if (current === generation.current) setPending(false);
    }
  };
  return (
    <>
      <Button
        variant={iconOnly ? "tertiary" : "secondary"}
        size="sm"
        className={`copy-link-button${iconOnly ? " ui-icon-button" : ""}`}
        disabled={disabled || pending}
        data-copied={copied}
        data-motion={motion}
        aria-label={label}
        title={iconOnly ? (copied ? "Link copied" : label) : undefined}
        onClick={(event) => void copy(event)}
      >
        <span className="copy-link-content" aria-hidden="true">
          <span className="copy-link-default">
            <Icon icon={LinkIcon} size="sm" />
            {!iconOnly && label}
          </span>
          <span className="copy-link-success">
            <Icon icon={CheckIcon} size="sm" />
            {!iconOnly && "Copied"}
          </span>
        </span>
      </Button>
      <span className="sr-only" role="status">
        {copied ? "Link copied" : ""}
      </span>
    </>
  );
}
