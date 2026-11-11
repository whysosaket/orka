import React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "diff";
import type { Inspection } from "../types.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { Button } from "./button.js";
import { MermaidDiagram } from "./mermaid-diagram.js";
import { LoadingRegion } from "./loading-region.js";
import { useToasts } from "./toasts.js";

const sampleInspection: Inspection = {
  content:
    "# Project notes\n\nKeep the project context available across your tools.\n\n## Working notes\n\nReview the current approach and the decisions behind it.\n\n- Inspect the existing behavior\n- Keep useful context together\n- Verify the result",
  previous: "Earlier project notes",
  paths: [],
};

function MarkdownWebLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const { notify } = useToasts();
  const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button > 1 || !isTauri()) return;
    event.preventDefault();
    void invoke("open_web_link", { url: href }).catch(() =>
      notify({
        kind: "error",
        title: "Couldn’t open the link in your browser.",
      }),
    );
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={open}
      onAuxClick={open}
    >
      {children}
    </a>
  );
}

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
      <MarkdownWebLink href={href}>{children}</MarkdownWebLink>
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

type ResourceContentProps = {
  inspection: Inspection | null;
  changes: boolean;
  markdown: boolean;
  conversation: boolean;
  skillDocument?: boolean;
  error?: string;
  onRetry?: () => void;
};

export function ResourceContent(props: ResourceContentProps) {
  return (
    <LoadingRegion
      id="resource-content"
      label="Loading content…"
      data={props.inspection}
      sample={sampleInspection}
      error={
        props.error ? (
          <div className="content-message" role="alert">
            <p>{props.error}</p>
            {props.onRetry && (
              <Button size="sm" variant="tertiary" onClick={props.onRetry}>
                Retry
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {(inspection) => (
        <LoadedResourceContent {...props} inspection={inspection} />
      )}
    </LoadingRegion>
  );
}

function LoadedResourceContent({
  inspection,
  changes,
  markdown,
  conversation,
  skillDocument = false,
}: ResourceContentProps & { inspection: Inspection }) {
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
