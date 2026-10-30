import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import {
  ToastProvider,
  ToastViewport,
  useToasts,
  useToastNotice,
} from "../../../apps/mac/src/components/toasts.js";
import { Overlay } from "../../../apps/mac/src/components/overlay.js";
import { Button } from "../../../apps/mac/src/components/button.js";
import "@fontsource-variable/inter";
import "../../../apps/mac/src/style.css";
const h = React.createElement;

function Demo({ onProject }: { onProject: () => void }) {
  const { notify } = useToasts();
  const notice = useToastNotice();
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState(0);
  const info = () =>
    notify({ title: "Changes will save as a copy", kind: "info" });
  return h(
    "div",
    { className: "app" },
    h("aside", { style: { width: 240, flexShrink: 0 } }, "Orka"),
    h(
      "main",
      { style: { padding: 24 } },
      h("h1", null, "Toast preview"),
      h(
        "div",
        { className: "actions" },
        h(Button, { onClick: info }, "Show info"),
        h(
          Button,
          { onClick: () => notify({ title: "ENV set published" }) },
          "Show ENV toast",
        ),
        h(
          Button,
          { onClick: () => notice("Reviewed draft ready") },
          "Show ENV draft notice",
        ),
        h(
          Button,
          {
            onClick: () => notify({ title: "Sync requested", kind: "queued" }),
          },
          "Queue next",
        ),
        h(
          Button,
          {
            onClick: () =>
              notify({
                title: "Couldn’t open session",
                kind: "error",
                action: {
                  label: "Try again",
                  onClick: () => setActions((n) => n + 1),
                },
              }),
          },
          "Show action",
        ),
        h(Button, { onClick: onProject }, "Change project"),
        h(
          Button,
          {
            onClick: () => {
              window.setTimeout(info, 1000);
            },
          },
          "Deferred toast",
        ),
        h(Button, { onClick: () => setOpen(true) }, "Open dialog"),
      ),
      h("output", { "aria-label": "Action count" }, actions),
      h(ToastViewport),
    ),
    open &&
      h(
        Overlay,
        {
          open: true,
          title: "Toast review",
          onClose: () => setOpen(false),
          children: null,
        },
        h("h2", null, "Toast review"),
        h(
          Button,
          {
            onClick: () =>
              notify({ title: "Sharing choices saved", kind: "success" }),
          },
          "Save test preference",
        ),
        h(Button, { onClick: () => setOpen(false) }, "Close dialog"),
      ),
  );
}
function Fixture() {
  const [scope, setScope] = useState("one");
  return h(
    MotionConfig,
    { reducedMotion: "user" },
    h(ToastProvider, {
      scope,
      children: h(Demo, {
        onProject: () =>
          setScope((current) => (current === "one" ? "two" : "one")),
      }),
    }),
  );
}
createRoot(document.getElementById("root")!).render(h(Fixture));
