import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionPage } from "../types.js";

const SESSION_PAGE_SIZE = 40;

interface State {
  messages: SessionMessage[];
  total: number | null;
  loading: boolean;
  error: string;
  removed: boolean;
}
const initial: State = {
  messages: [],
  total: null,
  loading: true,
  error: "",
  removed: false,
};

/**
 * Pages through a session's readable turns, oldest first. Only the requested
 * window crosses the native bridge; the parsed transcript stays native-side.
 */
export function useSessionMessages(
  id: string,
  revision: number,
  conflictId: string,
) {
  const [state, setState] = useState<State>(initial);
  const generation = useRef(0);
  const inflight = useRef(false);
  const fetchPage = useCallback(
    async (offset: number, current: number) => {
      if (inflight.current) return;
      inflight.current = true;
      setState((value) => ({ ...value, loading: true, error: "" }));
      try {
        const page = await invoke<SessionPage>("session_messages", {
          id,
          conflictId: conflictId || null,
          offset,
          limit: SESSION_PAGE_SIZE,
        });
        if (current !== generation.current) return;
        const messages = page.messages ?? [];
        setState((value) => ({
          messages: offset === 0 ? messages : [...value.messages, ...messages],
          total: page.total ?? messages.length,
          loading: false,
          error: "",
          removed: page.removed === true,
        }));
      } catch (error) {
        if (current === generation.current)
          setState((value) => ({
            ...value,
            loading: false,
            error: String(error),
          }));
      } finally {
        if (current === generation.current) inflight.current = false;
      }
    },
    [id, conflictId],
  );
  useEffect(() => {
    generation.current += 1;
    inflight.current = false;
    setState(initial);
    void fetchPage(0, generation.current);
    return () => {
      generation.current += 1;
    };
  }, [fetchPage, revision]);
  const hasMore = state.total !== null && state.messages.length < state.total;
  const loadMore = useCallback(() => {
    if (!state.loading && !state.error && hasMore)
      void fetchPage(state.messages.length, generation.current);
  }, [fetchPage, hasMore, state.loading, state.error, state.messages.length]);
  const retry = useCallback(() => {
    void fetchPage(state.messages.length, generation.current);
  }, [fetchPage, state.messages.length]);
  return { ...state, hasMore, loadMore, retry };
}
