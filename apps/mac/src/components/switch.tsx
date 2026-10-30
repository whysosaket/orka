import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { motion, useReducedMotion, useSpring } from "motion/react";
import { spring } from "../lib/springs.js";

export type SwitchProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "role" | "size"
>;
const travel = 16;
const thumbSize = 20;

/** The native input owns value, labels, focus, forms and disabled semantics. */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className = "", ...props },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  const reducedMotion = useReducedMotion();
  const keyboard = useRef(false);
  const hovered = useRef(false);
  const pressed = useRef(false);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startPosition: number;
    position: number;
    dragged: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const clearClickFrame = useRef(0);
  const resetFrame = useRef(0);
  const initialPosition = (props.checked ?? props.defaultChecked) ? travel : 0;
  const x = useSpring(initialPosition, spring.moderate);
  const y = useSpring(0, spring.moderate);
  const scaleX = useSpring(1, spring.moderate);
  const scaleY = useSpring(1, spring.moderate);

  function updateThumb(direct = false) {
    const element = input.current;
    if (!element) return;
    const still =
      reducedMotion || keyboard.current || element.matches(":disabled");
    const extra = still ? 0 : pressed.current ? 4 : hovered.current ? 2 : 0;
    const shrink = !still && pressed.current ? 4 : 0;
    const checked = props.checked ?? element.checked;
    const position = gesture.current?.dragged
      ? gesture.current.position
      : checked
        ? travel
        : 0;
    const values = [
      [x, Math.min(position, travel - extra)],
      [y, shrink / 2],
      [scaleX, (thumbSize + extra) / thumbSize],
      [scaleY, (thumbSize - shrink) / thumbSize],
    ] as const;
    for (const [value, target] of values) {
      if (still || direct) value.jump(target);
      else value.set(target);
    }
  }

  // Controlled updates, including Discard, move the existing thumb to its new target.
  useLayoutEffect(() => updateThumb());
  useLayoutEffect(() => {
    const form = input.current?.form;
    // Form reset's default action runs after its event listeners.
    const reset = () => {
      cancelAnimationFrame(resetFrame.current);
      resetFrame.current = requestAnimationFrame(() => updateThumb(true));
    };
    form?.addEventListener("reset", reset);
    return () => {
      form?.removeEventListener("reset", reset);
    };
  });
  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(clearClickFrame.current);
      cancelAnimationFrame(resetFrame.current);
    },
    [],
  );

  function suppressDragClick() {
    suppressClick.current = true;
    cancelAnimationFrame(clearClickFrame.current);
    clearClickFrame.current = requestAnimationFrame(() => {
      suppressClick.current = false;
    });
  }
  function cancelGesture() {
    const active = gesture.current;
    if (!active) return;
    suppressDragClick();
    gesture.current = null;
    pressed.current = false;
    if (input.current?.hasPointerCapture(active.pointerId)) {
      input.current.releasePointerCapture(active.pointerId);
    }
    updateThumb();
  }

  return (
    <span
      className="ui-switch-control"
      style={
        {
          "--switch-color-duration": `${spring.fast.duration}s`,
        } as React.CSSProperties
      }
    >
      <input
        {...props}
        ref={input}
        type="checkbox"
        role="switch"
        className={`ui-switch ${className}`.trim()}
        onChange={(event) => {
          props.onChange?.(event);
          updateThumb();
        }}
        onClick={(event) => {
          props.onClick?.(event);
          // A label click reaches the input without a pointer-down on the track.
          if (event.detail > 0) keyboard.current = false;
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          suppressClick.current = false;
          keyboard.current = true;
          hovered.current = false;
          updateThumb(true);
        }}
        onPointerEnter={(event) => {
          props.onPointerEnter?.(event);
          hovered.current = event.pointerType === "mouse";
          keyboard.current = false;
          updateThumb();
        }}
        onPointerLeave={(event) => {
          props.onPointerLeave?.(event);
          hovered.current = false;
          updateThumb();
        }}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.currentTarget.matches(":disabled")
          )
            return;
          suppressClick.current = false;
          keyboard.current = false;
          pressed.current = true;
          const position = event.currentTarget.checked ? travel : 0;
          gesture.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startPosition: position,
            position,
            dragged: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          updateThumb();
        }}
        onPointerMove={(event) => {
          props.onPointerMove?.(event);
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const delta = event.clientX - active.startX;
          active.dragged ||= Math.abs(delta) > 2;
          if (!active.dragged) return;
          active.position = Math.max(
            0,
            Math.min(travel, active.startPosition + delta),
          );
          updateThumb(true);
        }}
        onPointerUp={(event) => {
          props.onPointerUp?.(event);
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          gesture.current = null;
          pressed.current = false;
          if (active.dragged) {
            if (
              !event.defaultPrevented &&
              active.position > travel / 2 !== event.currentTarget.checked
            )
              event.currentTarget.click();
            // The pointer-up's subsequent native click must not toggle again.
            suppressDragClick();
          }
          updateThumb();
        }}
        onPointerCancel={(event) => {
          props.onPointerCancel?.(event);
          cancelGesture();
        }}
        onLostPointerCapture={(event) => {
          props.onLostPointerCapture?.(event);
          if (gesture.current) cancelGesture();
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
            return;
          }
          props.onClickCapture?.(event);
        }}
      />
      <span className="ui-switch-track" aria-hidden="true">
        <motion.span
          className="ui-switch-thumb"
          style={{ x, y, scaleX, scaleY }}
        />
      </span>
    </span>
  );
});
