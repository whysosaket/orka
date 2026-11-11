import React, { lazy, Suspense, useMemo } from "react";
import {
  CodeIcon,
  FileIcon,
  MarkdownIcon,
  TableIcon,
  type Icon as OcticonIcon,
} from "@primer/octicons-react";
import { Icon } from "./icon.js";
import { summarizeDiff, type FileChangeStatus } from "./diff-model.js";
import { tokenizeMarkdown, type Token } from "./markdown-tokens.js";
import { supportsPierreDiffs } from "./pierre-diffs-compat.js";

// Import only after the capability check: Pierre itself contains regex syntax
// unsupported by older WebViews, so a guard inside its module would be too late.
const PierreDiff = lazy(() =>
  import("./pierre-diff.js").then((module) => ({ default: module.PierreDiff })),
);

export type SourceLanguage = "markdown" | "plain";

export interface FileKind {
  icon: OcticonIcon;
  /** The icon used in file lists, where the design keeps Markdown generic. */
  listIcon: OcticonIcon;
  label: string;
  language: SourceLanguage;
}

const codeLabels: Record<string, string> = {
  sh: "Shell script",
  bash: "Shell script",
  zsh: "Shell script",
  fish: "Shell script",
  py: "Python",
  rb: "Ruby",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  go: "Go",
  rs: "Rust",
  swift: "Swift",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
};

/** How a skill file reads: its icon, type label, and source treatment. */
export function fileKind(path: string): FileKind {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  if (["md", "markdown", "mdown"].includes(extension))
    return {
      icon: MarkdownIcon,
      listIcon: FileIcon,
      label: "Markdown",
      language: "markdown",
    };
  if (extension in codeLabels)
    return {
      icon: CodeIcon,
      listIcon: CodeIcon,
      label: codeLabels[extension],
      language: "plain",
    };
  if (extension === "csv" || extension === "tsv")
    return {
      icon: TableIcon,
      listIcon: FileIcon,
      label: extension.toUpperCase(),
      language: "plain",
    };
  return {
    icon: FileIcon,
    listIcon: FileIcon,
    label:
      extension === "txt"
        ? "Text"
        : extension
          ? extension.toUpperCase()
          : "File",
    language: "plain",
  };
}

const tokenClass: Record<Token["kind"], string | undefined> = {
  text: undefined,
  punct: "code-punct",
  heading: "code-heading",
  key: "code-key",
  string: "code-string",
};

function Tokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) =>
        tokenClass[token.kind] ? (
          <span key={i} className={tokenClass[token.kind]}>
            {token.text}
          </span>
        ) : (
          <React.Fragment key={i}>{token.text}</React.Fragment>
        ),
      )}
    </>
  );
}

export interface FileDiffCardProps {
  path: string;
  before: string;
  after: string;
  status?: FileChangeStatus;
  binary?: boolean;
  comparisonUnavailable?: boolean;
}

/** One unified, read-only comparison with collapsible unchanged regions. */
export function FileDiffCard({
  path,
  before,
  after,
  status = "modified",
  binary = false,
  comparisonUnavailable = false,
}: FileDiffCardProps) {
  const kind = fileKind(path);
  const textPreview = !binary && kind.label !== "PDF";
  const context = kind.language === "markdown" ? 2 : 5;
  const supported = useMemo(() => supportsPierreDiffs(), []);
  const diff = useMemo(() => summarizeDiff(before, after), [before, after]);
  const removed = status === "removed";
  return (
    <section
      className={`diff-card${removed ? " diff-card--removed" : ""}`}
      aria-label={`${path} changes`}
    >
      <header className="diff-card-header">
        <div className="diff-card-file">
          <Icon icon={kind.icon} size="sm" variant="primary" />
          <h3 className="diff-card-path">{path}</h3>
          {!removed && textPreview && diff.ranges && (
            <span className="diff-card-ranges">{diff.ranges}</span>
          )}
        </div>
        <div className="diff-card-counts">
          {removed ? (
            <span className="diff-card-removed">Removed</span>
          ) : !textPreview ? (
            <span className="diff-card-summary-status">
              {comparisonUnavailable
                ? "Review required"
                : status === "added"
                  ? "Added"
                  : "Updated"}
            </span>
          ) : (
            <>
              {diff.deletions > 0 && (
                <span className="diff-count--removed">
                  <span className="sr-only">Removed lines </span>−
                  {diff.deletions}
                </span>
              )}
              {diff.additions > 0 && (
                <span className="diff-count--added">
                  <span className="sr-only">Added lines </span>+{diff.additions}
                </span>
              )}
            </>
          )}
        </div>
      </header>
      {!removed && !textPreview && (
        <p className="diff-card-summary">No text preview for this file.</p>
      )}
      {!removed && textPreview && (
        <div className="diff-lines" role="group" aria-label="File changes">
          {supported ? (
            <Suspense
              fallback={
                <p className="diff-card-summary" role="status">
                  Loading changes…
                </p>
              }
            >
              <PierreDiff
                path={path}
                before={before}
                after={after}
                context={context}
              />
            </Suspense>
          ) : (
            <p className="diff-card-summary" role="status">
              Diff preview unavailable in this macOS webview. Use Open in editor
              to inspect the files.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export interface SourceCardProps {
  path: string;
  /** Null for binary files, which only offer the editor. */
  content: string | null;
  /** Malformed metadata stays readable as unprocessed, unhighlighted source. */
  variant?: "file" | "plain";
}

/** The read-only source of a non-Markdown file, or the raw Markdown with line numbers. */
export function SourceCard({
  path,
  content,
  variant = "file",
}: SourceCardProps) {
  const kind = fileKind(path);
  // A PDF can happen to decode as UTF-8 while still requiring a document viewer.
  const previewContent = kind.label === "PDF" ? null : content;
  const lines = useMemo(
    () =>
      previewContent !== null && kind.language === "markdown"
        ? tokenizeMarkdown(previewContent)
        : null,
    [previewContent, kind.language],
  );
  if (variant === "plain" && previewContent !== null)
    return (
      <section
        className="source-card source-card--plain"
        aria-label={`${path} source`}
      >
        <pre className="source-plain">{previewContent}</pre>
      </section>
    );
  return (
    <section
      className={`source-card${kind.language !== "markdown" ? " source-card--file" : ""}`}
      aria-label={`${path} source`}
    >
      <header className="source-card-header">
        <div
          className={`diff-card-file${kind.label === "CSV" || kind.label === "TSV" ? " diff-card-file--table" : ""}`}
        >
          <Icon icon={kind.icon} size="sm" variant="primary" />
          <h3 className="diff-card-path">{path}</h3>
        </div>
        {kind.language !== "markdown" && (
          <span className="source-card-type">{kind.label}</span>
        )}
      </header>
      {previewContent === null ? (
        <div className="source-card-unavailable" role="status">
          <Icon icon={FileIcon} size="sm" variant="primary" />
          <p className="source-card-unavailable-title">Preview unavailable</p>
          <p className="source-card-unavailable-message">
            Use Open in editor to view this {kind.label}.
          </p>
        </div>
      ) : lines ? (
        <div className="source-lines" role="group" aria-label="Markdown source">
          {lines.map((tokens, i) => (
            <div key={i} className="source-line">
              <span className="diff-gutter" aria-hidden="true">
                {i + 1}
              </span>
              <span className="source-code">
                <Tokens tokens={tokens} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <pre className="source-plain">{previewContent}</pre>
      )}
    </section>
  );
}
