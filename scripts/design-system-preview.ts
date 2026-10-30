import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArrowRightIcon,
  FileDirectoryIcon,
  PlusIcon,
} from "@primer/octicons-react";
import { Button } from "../apps/mac/src/components/button.js";
import { Icon, type ControlSize } from "../apps/mac/src/components/icon.js";
import { IconButton } from "../apps/mac/src/components/icon-button.js";
import postcss from "postcss";

// Render the actual components with production CSS, so the review artifact
// catches missing Tailwind classes as well as component/stylesheet drift.
const assets = new URL("../apps/mac/dist/assets/", import.meta.url);
const cssFile = readdirSync(assets).find((file) => file.endsWith(".css"));
if (!cssFile)
  throw new Error("Build the frontend before generating the preview.");
const css = readFileSync(new URL(cssFile, assets), "utf8").replace(
  /@font-face\{[^}]*\}/g,
  "",
);
const font = readFileSync(
  new URL(
    "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    import.meta.url,
  ),
).toString("base64");
const h = React.createElement;
const sizes: ControlSize[] = ["lg", "md", "sm"];
const variants = ["primary", "secondary", "tertiary"] as const;
const states = ["Default", "Hover", "Pressed", "Focus", "Disabled"] as const;
// Pin real production pseudo-states for side-by-side comparison. These
// aliases exist only in the gallery, not in the component API or app CSS.
const stateRules: string[] = [];
postcss.parse(css).walkRules((rule) => {
  const selectors = rule.selectors.filter(
    (selector) =>
      selector.includes(".ui-button") &&
      /:(hover|active|focus-visible)/.test(selector),
  );
  if (selectors.length) {
    let snapshot: postcss.ChildNode = rule.clone({
      selector: selectors
        .map((selector) =>
          selector
            .replaceAll(":hover", ".preview-state-hover")
            .replaceAll(":active", ".preview-state-pressed")
            .replaceAll(":focus-visible", ".preview-state-focus"),
        )
        .join(","),
    });
    // Keep pointer and reduced-motion conditions around the pinned states.
    for (
      let parent: typeof rule.parent | postcss.Document = rule.parent;
      parent;
      parent = parent.parent
    ) {
      if (
        parent.type === "atrule" &&
        ["media", "supports"].includes(parent.name)
      ) {
        snapshot = postcss
          .atRule({ name: parent.name, params: parent.params })
          .append(snapshot);
      }
    }
    stateRules.push(snapshot.toString());
  }
});
const content = h(
  "main",
  { className: "component-sheet" },
  h("h1", null, "Orka components"),
  h(
    "p",
    null,
    "Pitch · Inter Variable · Octicons · Built from the app components",
  ),
  h(
    "section",
    { className: "states-section", "aria-labelledby": "states-title" },
    h(
      "div",
      { className: "states-heading" },
      h(
        "div",
        null,
        h("h2", { id: "states-title" }, "Button states"),
        h("p", null, "Text and icon buttons, side by side."),
      ),
      h(
        "label",
        { className: "size-control" },
        "Size",
        h(
          "select",
          { id: "state-size", defaultValue: "md" },
          h("option", { value: "lg" }, "lg · 48px"),
          h("option", { value: "md" }, "md · 40px"),
          h("option", { value: "sm" }, "sm · 32px"),
        ),
      ),
    ),
    h(
      "div",
      { className: "states-scroll" },
      h(
        "table",
        { className: "states-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col" }, "State"),
            ...variants.map((variant) =>
              h("th", { key: variant, scope: "col" }, variant),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          ...states.map((state) =>
            h(
              "tr",
              { key: state, "data-state": state.toLowerCase() },
              h("th", { scope: "row" }, state),
              ...variants.map((variant) =>
                h(
                  "td",
                  { key: variant, "data-variant": variant },
                  h(
                    "div",
                    { className: "state-pair" },
                    h(
                      Button,
                      {
                        variant,
                        size: "md",
                        disabled: state === "Disabled",
                        tabIndex: -1,
                        className: `preview-state-${state.toLowerCase()}`,
                      },
                      "Continue",
                      variant === "tertiary"
                        ? null
                        : h(Icon, { icon: ArrowRightIcon }),
                    ),
                    h(IconButton, {
                      variant,
                      size: "md",
                      icon: PlusIcon,
                      disabled: state === "Disabled",
                      tabIndex: -1,
                      className: `preview-state-${state.toLowerCase()}`,
                      "aria-label": `${variant} add, ${state.toLowerCase()} state`,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "p",
      { className: "state-note" },
      "States are pinned for comparison. Try the live buttons below to hover, press, or focus with Tab.",
    ),
  ),
  ...sizes.map((size) =>
    h(
      "section",
      { key: size, "data-size": size },
      h(
        "h2",
        null,
        `${size} / ${size === "lg" ? 48 : size === "md" ? 40 : 32}px`,
      ),
      h(
        "div",
        { className: "component-row", "aria-label": `${size} text buttons` },
        ...variants.map((variant) =>
          h(
            Button,
            { key: variant, variant, size, className: `preview-${variant}` },
            variant === "tertiary"
              ? null
              : h(Icon, { icon: FileDirectoryIcon }),
            variant.charAt(0).toUpperCase() + variant.slice(1),
          ),
        ),
      ),
      h("h3", null, "Icon buttons"),
      h(
        "div",
        { className: "component-row", "aria-label": `${size} icon buttons` },
        ...variants.map((variant) =>
          h(IconButton, {
            key: variant,
            icon: PlusIcon,
            size,
            variant,
            className: `preview-${variant}`,
            "aria-label": `${variant} ${size} add`,
          }),
        ),
        h(IconButton, {
          icon: PlusIcon,
          size,
          disabled: true,
          "aria-label": `Disabled ${size} add`,
        }),
      ),
      h("h3", null, "Standalone icons / primary · secondary · tertiary"),
      h(
        "div",
        { className: "component-row standalone-icons" },
        ...variants.map((variant) =>
          h(Icon, {
            key: variant,
            icon: ArrowRightIcon,
            size,
            variant,
            label: `${variant} ${size} arrow`,
          }),
        ),
      ),
    ),
  ),
);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Orka component system</title><style>${css}
${stateRules.join("\n")}
@font-face{font-family:"Inter Variable";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
.component-sheet{max-width:1040px;margin:auto;padding:40px}
.component-sheet h1{font-size:var(--heading-lg-font-size);line-height:var(--heading-lg-line-height);letter-spacing:var(--heading-lg-letter-spacing)}
.component-sheet>p{margin-top:12px;color:var(--text-secondary)}
.component-sheet section{padding:28px 0;border-bottom:1px solid var(--border-subtle)}
.component-sheet h2{font-size:var(--body-md-font-size);line-height:var(--body-md-line-height);font-weight:500;margin-bottom:20px}
.component-sheet h3{font-size:var(--body-xs-font-size);line-height:var(--body-xs-line-height);font-weight:400;color:var(--text-tertiary);margin:24px 0 12px}
.component-row{display:flex;align-items:center;flex-wrap:wrap;gap:16px}
.states-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}
.states-heading h2{margin-bottom:6px;font-size:20px;line-height:28px;letter-spacing:-.01em}
.states-heading p,.state-note{color:var(--text-tertiary);font-size:12px;line-height:18px}
.size-control{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text-secondary);white-space:nowrap}
.size-control select{background:var(--surface-tertiary);color:var(--text-primary);padding:8px 12px;border:0;border-radius:8px;font:inherit;cursor:pointer}
.size-control select:focus-visible{outline:2px solid var(--focus-ring);outline-offset:4px}
.states-scroll{overflow-x:auto;padding:6px;margin:-6px}
.states-table{width:100%;min-width:700px;border-collapse:collapse;text-align:left}
.states-table th{font-size:12px;line-height:18px;font-weight:400;color:var(--text-tertiary)}
.states-table thead th{padding:0 0 16px;text-transform:capitalize}
.states-table tbody th{width:100px;color:var(--text-secondary)}
.states-table td{padding:18px 0}
.states-table tbody tr{border-top:1px solid var(--border-subtle)}
.state-pair{display:flex;align-items:center;gap:12px;padding-right:16px}
.state-pair .ui-button{pointer-events:none;transition:none}
.state-note{margin-top:20px}
@media(max-width:480px){.component-sheet{padding:24px}}
</style></head><body>${renderToStaticMarkup(content)}<script>
document.getElementById('state-size').addEventListener('change', (event) => {
  document.querySelectorAll('.state-pair .ui-button').forEach((button) => {
    button.classList.remove('ui-button--lg', 'ui-button--md', 'ui-button--sm');
    button.classList.add('ui-button--' + event.target.value);
  });
});
</script></body></html>`;
const output = new URL(
  "../docs/design-system/components.html",
  import.meta.url,
);
writeFileSync(output, html);
console.log(fileURLToPath(output));
