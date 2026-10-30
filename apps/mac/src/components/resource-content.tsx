import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "diff";
import type { Inspection } from "../types.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { Button } from "./button.js";
import { MermaidDiagram } from "./mermaid-diagram.js";

/** Shared Markdown element overrides for synced content and session turns. */
export const markdownComponents: Components = {
  pre: ({ children }) => {
    const code = React.Children.toArray(children)[0];
    if (
      React.isValidElement<{ className?: string; children?: React.ReactNode }>(
        code,
      ) &&
      code.props.className?.split(/\s+/).includes("language-mermaid")
    )
      return (
        <MermaidDiagram
          source={String(code.props.children ?? "").replace(/\n$/, "")}
        />
      );
    return <pre>{children}</pre>;
  },
  li: ({ children, className }) => (
    <li className={className}>
      {className?.includes("task-list-item") ? (
        <label>{children}</label>
      ) : (
        children
      )}
    </li>
  ),
  // Source files can contain arbitrary URLs. Only web links leave the reader;
  // relative file references remain text until native file navigation exists.
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span title={href}>{children}</span>
    ),
  // Native CSP only permits local images. Keep remote/file images readable
  // without broken-image UI or network requests from synced Markdown.
  img: ({ alt }) => (
    <span className="markdown-image-note">
      Image: {alt || "Untitled image"}
    </span>
  ),
  table: ({ children }) => (
    <div
      className="markdown-table"
      role="region"
      aria-label="Markdown table"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
};

export function ResourceContent({
  inspection,
  changes,
  markdown,
  conversation,
  skillDocument = false,
  error,
  onRetry,
}: {
  inspection: Inspection | null;
  changes: boolean;
  markdown: boolean;
  conversation: boolean;
  skillDocument?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  if (error)
    return (
      <div className="content-message" role="alert">
        <p>{error}</p>
        {onRetry && (
          <Button size="sm" variant="tertiary" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  if (!inspection)
    return (
      <p className="content-message" role="status">
        Loading…
      </p>
    );
  if (inspection.content === null)
    return (
      <p className="content-message">Binary file. Open it in your editor.</p>
    );
  if (changes) {
    if (inspection.previous === null)
      return (
        <p className="content-message">
          Previous revision is not cached on this Mac.
        </p>
      );
    return (
      <pre className="content" aria-label="File changes">
        {diffLines(inspection.previous, inspection.content).map((part, i) => (
          <span
            key={i}
            className={part.added ? "addition" : part.removed ? "deletion" : ""}
          >
            {part.added || part.removed
              ? (part.value.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(
                  (line, index) => (
                    <span className="block" key={index}>
                      <span
                        className="diff-marker"
                        aria-label={part.added ? "Added" : "Removed"}
                      >
                        {part.added ? "+" : "−"}
                      </span>
                      {line}
                    </span>
                  ),
                )
              : part.value}
          </span>
        ))}
      </pre>
    );
  }
  const content = conversation
    ? (inspection.conversation ?? inspection.content)
    : inspection.content;
  if (!markdown) return <pre className="content">{content}</pre>;
  return (
    <article className="markdown-content" aria-label="Rendered Markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {skillDocument ? readSkillMarkdown(content).body : content}
      </Markdown>
    </article>
  );
}
