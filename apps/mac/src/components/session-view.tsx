import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PersonIcon } from "@primer/octicons-react";
import type { Resource } from "@portable/protocol";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { SourceLabel } from "./source-label.js";
import { markdownComponents } from "./resource-content.js";
import { useSessionMessages } from "./use-session-messages.js";
import type { SessionMessage } from "../types.js";

export type SessionViewMode = "conversation" | "transcript";

/** One turn with its speaker column. Memoized so paging never re-parses earlier turns. */
const SessionTurn = memo(function SessionTurn({
  message,
  raw,
  source,
}: {
  message: SessionMessage;
  raw: boolean;
  source: Resource["source"];
}) {
  const user = message.role === "user";
  const speaker = user ? "You" : source === "claude" ? "Claude" : "Codex";
  return (
    <article
      className={
        user
          ? "session-turn session-turn--user"
          : "session-turn session-turn--assistant"
      }
      aria-label={speaker}
    >
      <div className="session-turn-speaker">
        {user ? (
          <>
            <Icon icon={PersonIcon} size="sm" variant="primary" />
            <span>You</span>
          </>
        ) : (
          <SourceLabel source={source} />
        )}
      </div>
      <div className="session-turn-body">
        {raw ? (
          <pre className="content">{message.text}</pre>
        ) : (
          <div className="markdown-content">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {message.text}
            </Markdown>
          </div>
        )}
      </div>
    </article>
  );
});

export interface SessionViewProps {
  id: string;
  revision: number;
  /** Conflict preview to read instead of the shared version. */
  conflictId: string;
  source: Resource["source"];
  /** Title row, facts, and conflict panels. */
  header: React.ReactNode;
  mode: SessionViewMode;
  /** Show turns as literal text instead of rendered Markdown. */
  raw: boolean;
  /** The unchanged original transcript; loaded only in transcript mode. */
  transcript: React.ReactNode;
}

/** Full-width reading view for one session with paged, windowed turns. */
export function SessionView({
  id,
  revision,
  conflictId,
  source,
  header,
  mode,
  raw,
  transcript,
}: SessionViewProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const { messages, total, loading, error, removed, hasMore, loadMore, retry } =
    useSessionMessages(id, revision, conflictId);
  const conversation = mode === "conversation";
  // The header scrolls with the turns, so the virtualizer needs the list's
  // offset inside the scroll container, refreshed whenever the header resizes.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () =>
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const child of Array.from(scroller.children))
      if (!child.contains(list)) observer.observe(child);
    return () => observer.disconnect();
  }, [conversation]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
    scrollMargin,
    getItemKey: (index) => messages[index].index,
  });
  const items = virtualizer.getVirtualItems();
  const lastVisible = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loading && !error && lastVisible >= messages.length - 5)
      loadMore();
  }, [hasMore, loading, error, lastVisible, messages.length, loadMore]);
  return (
    <section
      className="resource-detail resource-detail--session session-view"
      aria-label="Session details"
      ref={scrollRef}
    >
      {header}
      {!conversation ? (
        <div className="detail-body">{transcript}</div>
      ) : (
        <div
          className="session-conversation"
          aria-label="Conversation"
          aria-busy={loading}
        >
          {removed && (
            <p className="content-message">
              This version removes the session from shared history.
            </p>
          )}
          {error && (
            <p className="content-message" role="alert">
              {error}{" "}
              <Button size="sm" variant="tertiary" onClick={retry}>
                Retry
              </Button>
            </p>
          )}
          {!error && !removed && total === 0 && (
            <p className="content-message">
              No readable conversation messages. View the transcript for setup
              and tool records.
            </p>
          )}
          <div
            ref={listRef}
            className="session-turns"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="session-turn-slot"
                style={{
                  transform: `translateY(${item.start - scrollMargin}px)`,
                }}
              >
                <SessionTurn
                  message={messages[item.index]}
                  raw={raw}
                  source={source}
                />
              </div>
            ))}
          </div>
          {!error && (hasMore || (loading && total === null)) && (
            <div className="session-load-more">
              {loading ? (
                <span role="status">Loading messages…</span>
              ) : (
                <Button size="sm" variant="secondary" onClick={loadMore}>
                  Show more messages
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
