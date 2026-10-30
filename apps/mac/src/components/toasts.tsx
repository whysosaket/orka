import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  AlertIcon,
  CheckCircleIcon,
  ClockIcon,
  InfoIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { Button } from "./button.js";
import { spring } from "../lib/springs.js";
import { noticeToast } from "./toast-copy.js";
import { ENV_ENABLED } from "../lib/features.js";

export const TOAST_DURATION_MS = 5000;
export type ToastInput = {
  title: string;
  kind?: "success" | "info" | "queued" | "warning" | "error";
  action?: { label: string; onClick: () => void };
};
type Toast = ToastInput & {
  id: number;
  scope: string;
  returnFocus: HTMLElement | null;
};
type Bounds = { center: number; bottom: number; width: number };
const ToastContext = createContext<{
  notify: (input: ToastInput) => void;
  queue: Toast[];
  closing: number | null;
  dismiss: (id: number) => void;
  finishDismiss: () => void;
  progress: ReturnType<typeof useMotionValue<number>>;
  pause: (reason: "hover" | "focus", value: boolean) => void;
  modalHosts: string[];
  registerModal: (id: string) => () => void;
  bounds: Bounds | null;
  setBounds: (bounds: Bounds) => void;
  navigate: (destination: ToastDestination) => void;
  navigation: React.RefObject<((destination: ToastDestination) => void) | null>;
} | null>(null);
export type ToastDestination = "requests" | "env" | "sync";

export function ToastProvider({
  scope,
  children,
}: {
  scope: string;
  children: React.ReactNode;
}) {
  const [items, setItems] = useState<Toast[]>([]);
  const [closing, setClosing] = useState<number | null>(null);
  const closingRef = useRef<number | null>(null);
  const [paused, setPaused] = useState({ hover: false, focus: false });
  const [inactive, setInactive] = useState(false);
  const [modalHosts, setModalHosts] = useState<string[]>([]);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const updateBounds = useCallback((next: Bounds) => {
    setBounds((previous) =>
      previous?.center === next.center &&
      previous.bottom === next.bottom &&
      previous.width === next.width
        ? previous
        : next,
    );
  }, []);
  const scopeRef = useRef(scope);
  const nextId = useRef(0);
  const navigation = useRef<((destination: ToastDestination) => void) | null>(
    null,
  );
  const navigate = useCallback(
    (destination: ToastDestination) => navigation.current?.(destination),
    [],
  );
  scopeRef.current = scope;
  useEffect(() => {
    // Drop old entries so returning to a project cannot resurrect its notices.
    setItems((previous) => previous.filter((item) => item.scope === scope));
  }, [scope]);
  const queue = items.filter((item) => item.scope === scope);
  const active = queue[0];
  const progress = useMotionValue(0);
  const timerId = useRef<number | undefined>(undefined);
  const reducedMotion = useReducedMotion();
  const notify = useCallback(
    (input: ToastInput) => {
      // An asynchronous result from a previous project/account cannot leak into
      // the newly selected workspace. Nothing is persisted in app settings.
      if (!input.title || scopeRef.current !== scope) return;
      if (!ENV_ENABLED && /\bENVs?\b/.test(input.title)) return;
      const item: Toast = {
        ...input,
        id: ++nextId.current,
        scope,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      };
      setItems((previous) => {
        const current = previous.filter((entry) => entry.scope === scope);
        return current.some(
          (entry) => entry.title === item.title && entry.kind === item.kind,
        )
          ? current
          : [...current, item];
      });
    },
    [scope],
  );
  const dismiss = useCallback(
    (id: number) => {
      const item = items.find((entry) => entry.id === id);
      if (
        document.activeElement?.closest("[data-orka-toast]") &&
        item?.returnFocus?.isConnected
      )
        item.returnFocus.focus();
      closingRef.current = id;
      setClosing(id);
    },
    [items],
  );
  const finishDismiss = useCallback(() => {
    const dismissed = closingRef.current;
    if (dismissed === null) return;
    closingRef.current = null;
    setItems((previous) => previous.filter((item) => item.id !== dismissed));
    setClosing(null);
  }, []);
  useEffect(() => {
    if (closing === null) return;
    const timer = window.setTimeout(
      finishDismiss,
      reducedMotion ? 0 : spring.slow.exit.duration * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [closing, finishDismiss, reducedMotion]);
  const pause = useCallback((reason: "hover" | "focus", value: boolean) => {
    setPaused((previous) =>
      previous[reason] === value ? previous : { ...previous, [reason]: value },
    );
  }, []);
  const registerModal = useCallback((id: string) => {
    setModalHosts((previous) => [...previous, id]);
    return () =>
      setModalHosts((previous) => previous.filter((entry) => entry !== id));
  }, []);
  useEffect(() => {
    const update = () => setInactive(document.hidden || !document.hasFocus());
    const blur = () => setInactive(true);
    const focus = () => setInactive(document.hidden);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const activeId = active?.id;
  const blocked =
    paused.hover || paused.focus || inactive || closing === activeId;
  useEffect(() => {
    if (timerId.current !== activeId) {
      timerId.current = activeId;
      progress.set(0);
      setPaused({ hover: false, focus: false });
    }
    if (activeId === undefined || blocked) return;
    // This duration represents elapsed time, deliberately linear rather than a
    // UI spring. Stopping the same motion value preserves the remaining time.
    const controls = animate(progress, 1, {
      duration: ((1 - progress.get()) * TOAST_DURATION_MS) / 1000,
      ease: "linear",
      onComplete: () => dismiss(activeId),
    });
    return () => controls.stop();
  }, [activeId, blocked, progress, dismiss]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.altKey && event.code === "KeyT") {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>("[data-orka-toast] button")
          ?.focus();
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(
          '[role="dialog"], [data-state="open"][role="menu"]',
        )
      ) {
        event.preventDefault();
        dismiss(active.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, dismiss]);
  const value = useMemo(
    () => ({
      notify,
      queue,
      closing,
      dismiss,
      finishDismiss,
      progress,
      pause,
      modalHosts,
      registerModal,
      bounds,
      setBounds: updateBounds,
      navigate,
      navigation,
    }),
    [
      notify,
      queue,
      closing,
      dismiss,
      finishDismiss,
      progress,
      pause,
      modalHosts,
      registerModal,
      bounds,
      updateBounds,
      navigate,
    ],
  );
  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

export function useToasts() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("ToastProvider is missing");
  return context;
}

/** Radix handles Escape in document capture, before the toast's React handler. */
export function useToastEscape() {
  const context = useContext(ToastContext);
  return (event: KeyboardEvent) => {
    const active = context?.queue[0];
    if (
      !active ||
      !(event.target instanceof Element) ||
      !event.target.closest("[data-orka-toast]")
    )
      return false;
    event.preventDefault();
    context.dismiss(active.id);
    return true;
  };
}

export function useToastNotice() {
  const { notify, navigate } = useToasts();
  return useCallback(
    (message: string) => {
      if (!message) return;
      const toast = noticeToast(message);
      const destination: ToastDestination | null =
        /queued$|^Sync requested|^Upload retry requested/.test(toast.title)
          ? "sync"
          : /^Request |^Suggestion /.test(toast.title)
            ? "requests"
            : /^ENV set published|^Old ENV set|draft ready$/.test(toast.title)
              ? "env"
              : null;
      if (!ENV_ENABLED && destination === "env") return;
      notify({
        ...toast,
        action: destination
          ? {
              label:
                destination === "sync"
                  ? "View status"
                  : destination === "requests"
                    ? /needs a fresh review/.test(toast.title)
                      ? "Review"
                      : "View requests"
                    : /draft ready$/.test(toast.title)
                      ? "Review draft"
                      : "View ENVs",
              onClick: () => navigate(destination),
            }
          : undefined,
      });
    },
    [notify, navigate],
  );
}

export function useToastNavigation(
  handler: (destination: ToastDestination) => void,
) {
  const { navigation } = useToasts();
  useLayoutEffect(() => {
    navigation.current = handler;
    return () => {
      navigation.current = null;
    };
  }, [navigation, handler]);
}

/** A modal host keeps its toast inside Radix's focus and accessibility scope. */
export function ToastViewport({ modal = false }: { modal?: boolean }) {
  const context = useContext(ToastContext);
  const id = useId();
  const registerModal = context?.registerModal;
  const setBounds = context?.setBounds;
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (modal && registerModal) return registerModal(id);
  }, [modal, registerModal, id]);
  useLayoutEffect(() => {
    if (modal || !setBounds || !ref.current?.parentElement) return;
    const parent = ref.current.parentElement;
    const update = () => {
      const rect = parent.getBoundingClientRect();
      setBounds({
        center: rect.left + rect.width / 2,
        bottom: window.innerHeight - rect.bottom + 24,
        width: rect.width,
      });
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    });
    observer.observe(parent);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, [modal, setBounds]);
  if (!context) return null;
  const hostActive = modal
    ? context.modalHosts.at(-1) === id
    : !context.modalHosts.length;
  const active = hostActive ? context.queue[0] : undefined;
  const icon =
    active?.kind === "error"
      ? XCircleIcon
      : active?.kind === "warning"
        ? AlertIcon
        : active?.kind === "queued"
          ? ClockIcon
          : active?.kind === "success"
            ? CheckCircleIcon
            : InfoIcon;
  const Glyph = icon;
  return (
    <div
      ref={ref}
      className={`toast-viewport${modal ? " toast-viewport--modal" : ""}`}
      style={
        modal && context.bounds
          ? {
              left: context.bounds.center,
              bottom: context.bounds.bottom,
              width: context.bounds.width,
            }
          : undefined
      }
    >
      <>
        {active && (
          <motion.div
            key={active.id}
            className="toast-stack"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: context.closing === active.id ? 0 : 1, y: 0 }}
            transition={
              context.closing === active.id
                ? reduced
                  ? { duration: 0 }
                  : spring.slow.exit
                : spring.moderate
            }
          >
            {context.queue.length > 2 && (
              <div
                className="toast-queued toast-queued--back"
                aria-hidden="true"
              />
            )}
            {context.queue.length > 1 && (
              <div className="toast-queued" aria-hidden="true" />
            )}
            <div
              className="orka-toast"
              data-orka-toast=""
              data-kind={active.kind ?? "info"}
              onPointerEnter={() => context.pause("hover", true)}
              onPointerLeave={() => context.pause("hover", false)}
              onFocusCapture={() => context.pause("focus", true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  context.pause("focus", false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  context.dismiss(active.id);
                }
              }}
            >
              <span className="toast-icon">
                <Glyph size={16} aria-hidden="true" />
              </span>
              <span
                className="toast-title"
                role={active.kind === "error" ? "alert" : "status"}
                aria-atomic="true"
              >
                {active.title}
              </span>
              <Button
                size="sm"
                className="toast-action"
                disabled={context.closing === active.id}
                onClick={() => {
                  context.dismiss(active.id);
                  active.action?.onClick();
                }}
              >
                <TimerFill
                  progress={context.progress}
                  reduced={Boolean(reduced)}
                />
                <span className="toast-action-label">
                  {active.action?.label ?? "Dismiss"}
                </span>
              </Button>
            </div>
          </motion.div>
        )}
      </>
    </div>
  );
}

function TimerFill({
  progress,
  reduced,
}: {
  progress: ReturnType<typeof useMotionValue<number>>;
  reduced: boolean;
}) {
  const scale = useTransform(progress, (value) =>
    reduced ? Math.floor(value * 5) / 5 : value,
  );
  return (
    <motion.span
      className="toast-timer"
      aria-hidden="true"
      style={{ scaleX: scale }}
    />
  );
}
