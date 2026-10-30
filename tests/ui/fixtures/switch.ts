import React from "react";
const { useState, useRef } = React;
import ReactDOM from "react-dom/client";
import { Switch } from "../../../apps/mac/src/components/switch.js";
import "../../../apps/mac/src/style.css";
const h = React.createElement;
function Fixture() {
  const [checked, setChecked] = useState(false);
  const [changes, setChanges] = useState(0);
  const [disabled, setDisabled] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  return h(
    "main",
    { style: { padding: 40 } },
    h(
      "label",
      null,
      "Controlled",
      h(Switch, {
        "aria-label": "Controlled",
        checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          setChecked(e.target.checked);
          setChanges((n) => n + 1);
        },
      }),
    ),
    h("output", { "aria-label": "Changes" }, changes),
    h("button", { onClick: () => setChecked(false) }, "Discard"),
    h(
      "form",
      null,
      h(
        "label",
        null,
        "Uncontrolled",
        h(Switch, {
          "aria-label": "Uncontrolled",
          name: "enabled",
          defaultChecked: true,
          ref: input,
        }),
      ),
      h("button", { type: "reset" }, "Reset"),
    ),
    h("button", { onClick: () => input.current?.focus() }, "Focus input"),
    h(
      "fieldset",
      { disabled },
      h(
        "label",
        null,
        "Disabled",
        h(Switch, { "aria-label": "Disabled", defaultChecked: true }),
      ),
    ),
    h("button", { onClick: () => setDisabled((d) => !d) }, "Toggle fieldset"),
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(h(Fixture));
