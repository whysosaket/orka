import { useCallback, useEffect, useRef, useState } from "react";

/** Keep confirmed content during refresh and ignore requests from an old scope. */
export function useSettingsQuery<T>(
  load: () => Promise<T>,
  initial: T | null = null,
  revision?: number | string,
) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(initial === null);
  const [extended, setExtended] = useState(false);
  const generation = useRef(0);
  const active = useRef(true);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    setExtended(false);
    const timer = setTimeout(() => {
      if (active.current && request === generation.current) setExtended(true);
    }, 8000);
    try {
      const value = await load();
      if (active.current && request === generation.current) setData(value);
      return value;
    } catch (error) {
      if (active.current && request === generation.current)
        setError(String(error));
      return null;
    } finally {
      clearTimeout(timer);
      if (active.current && request === generation.current) {
        setLoading(false);
        setExtended(false);
      }
    }
  }, [load]);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh, revision]);
  const confirm = useCallback((value: T) => {
    generation.current++;
    setData(value);
    setError("");
    setLoading(false);
    setExtended(false);
  }, []);
  return { data, error, loading, extended, refresh, confirm };
}
